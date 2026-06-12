"""Build the Claude Agent SDK tool-permission callback enforcing the scope rules.

The orchestrator's central safety property is: the agent may read and search anywhere in
the configured scope, but may only write inside the single repository that the current
task names. This module decides each tool call against that rule.

The decision logic in :func:`decide_tool_permission` is pure and has no dependency on the
Claude Agent SDK, so it can be unit-tested directly. :func:`build_tool_permission_callback`
wraps it in the async callback shape the SDK expects, importing the SDK lazily so the
decision logic stays importable without the SDK installed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .scope import is_within_any_root, is_within_root

READ_AND_SEARCH_TOOLS = ("Read", "Glob", "Grep")
WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
PATH_INPUT_KEYS = ("file_path", "notebook_path", "path")

# Match absolute paths that may appear inside a bash command string: Windows drive paths
# (E:\... or E:/...), UNC paths (\\... or //...), and POSIX absolute paths (/...).
_ABSOLUTE_PATH_PATTERN = re.compile(
    r"""
    (?:[A-Za-z]:[\\/][^\s'";|&<>]*)   # Windows drive path, e.g. E:/GitHub/app
    | (?:[\\/]{2}[^\s'";|&<>]+)        # UNC path, e.g. //wsl$/Ubuntu/home/user
    | (?<![A-Za-z0-9])/[^\s'";|&<>]+   # POSIX absolute path, e.g. /mnt/d/project
    """,
    re.VERBOSE,
)


@dataclass
class PermissionDecision:
    """The result of evaluating one tool call against the scope rules.

    Attributes:
        is_allowed: Whether the tool call may proceed.
        reason: A human-readable explanation, used as the denial message for the agent.

    Example:
        >>> decision = PermissionDecision(is_allowed=False, reason="outside the scope")
        >>> decision.is_allowed
        False
    """

    is_allowed: bool
    reason: str = ""


def extract_path_from_tool_input(tool_input: dict) -> str | None:
    """Return the filesystem path referenced by a tool's input, if any.

    Different tools name their path argument differently; this checks the known keys in
    priority order (``file_path``, then ``notebook_path``, then ``path``).

    Args:
        tool_input: The input dictionary the agent passed to the tool.

    Returns:
        The first path-like value found, or ``None`` if the tool input has no path.

    Example:
        >>> extract_path_from_tool_input({"file_path": "E:/GitHub/app/main.py"})
        'E:/GitHub/app/main.py'
        >>> extract_path_from_tool_input({"pattern": "*.py"}) is None
        True
    """
    for key in PATH_INPUT_KEYS:
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def evaluate_bash_command(
    command_text: str, readable_roots: list[Path], write_root: Path
) -> PermissionDecision:
    """Decide whether a bash command stays within the allowed scope.

    The agent runs with its working directory set to the task repository, so relative
    paths in a command operate inside that repository and are allowed. The risk is
    absolute paths that point outside the scope. This function denies the command if it
    references any absolute path that is neither inside the writable repository nor inside
    a readable root.

    Args:
        command_text: The bash command the agent wants to run.
        readable_roots: Directories the agent may read.
        write_root: The single repository the agent may write to.

    Returns:
        A :class:`PermissionDecision`.

    Example:
        >>> from pathlib import Path
        >>> roots = [Path("E:/GitHub")]
        >>> repo = Path("E:/GitHub/app")
        >>> evaluate_bash_command("pytest -q", roots, repo).is_allowed
        True
        >>> evaluate_bash_command("rm C:/Windows/system32/x", roots, repo).is_allowed
        False
    """
    allowed_roots = [write_root, *readable_roots]
    for match in _ABSOLUTE_PATH_PATTERN.finditer(command_text):
        referenced_path = match.group(0)
        if not is_within_any_root(referenced_path, allowed_roots):
            return PermissionDecision(
                is_allowed=False,
                reason=(
                    f"Bash command references '{referenced_path}', which is outside the "
                    f"allowed scope. Only the repository '{write_root}' is writable and "
                    f"only the configured scope is readable."
                ),
            )
    return PermissionDecision(is_allowed=True)


def decide_tool_permission(
    tool_name: str,
    tool_input: dict,
    readable_roots: list[Path],
    write_root: Path,
) -> PermissionDecision:
    """Decide whether a single tool call is allowed under the scope rules.

    Rules:
        * Read and search tools may target any path inside the readable roots or the
          writable repository; a tool call with no path (operating on the working
          directory) is allowed.
        * Write tools may only target a path inside the writable repository.
        * Bash is evaluated by :func:`evaluate_bash_command`.
        * Any other tool (for example web or planning tools) is allowed because it does
          not write to the filesystem.

    Args:
        tool_name: The name of the tool the agent wants to use.
        tool_input: The input dictionary for the tool call.
        readable_roots: Directories the agent may read.
        write_root: The single repository the agent may write to.

    Returns:
        A :class:`PermissionDecision`.

    Example:
        >>> from pathlib import Path
        >>> roots = [Path("E:/GitHub")]
        >>> repo = Path("E:/GitHub/app")
        >>> decide_tool_permission("Write", {"file_path": "E:/GitHub/app/x.py"}, roots, repo).is_allowed
        True
        >>> decide_tool_permission("Write", {"file_path": "E:/GitHub/other/x.py"}, roots, repo).is_allowed
        False
        >>> decide_tool_permission("Read", {"file_path": "E:/GitHub/other/x.py"}, roots, repo).is_allowed
        True
    """
    readable_targets = [write_root, *readable_roots]

    if tool_name in READ_AND_SEARCH_TOOLS:
        referenced_path = extract_path_from_tool_input(tool_input)
        if referenced_path is None:
            return PermissionDecision(is_allowed=True)
        if is_within_any_root(referenced_path, readable_targets):
            return PermissionDecision(is_allowed=True)
        return PermissionDecision(
            is_allowed=False,
            reason=(
                f"Reading '{referenced_path}' is outside the configured scope. "
                f"Readable roots: {[str(root) for root in readable_targets]}."
            ),
        )

    if tool_name in WRITE_TOOLS:
        referenced_path = extract_path_from_tool_input(tool_input)
        if referenced_path is None:
            return PermissionDecision(
                is_allowed=False,
                reason=f"Tool '{tool_name}' did not specify a file path to write.",
            )
        if is_within_root(referenced_path, write_root):
            return PermissionDecision(is_allowed=True)
        return PermissionDecision(
            is_allowed=False,
            reason=(
                f"Writing '{referenced_path}' is not permitted. This task may only write "
                f"inside the repository it named: '{write_root}'."
            ),
        )

    if tool_name == "Bash":
        command_text = str(tool_input.get("command", ""))
        return evaluate_bash_command(command_text, readable_roots, write_root)

    return PermissionDecision(is_allowed=True)


def build_tool_permission_callback(readable_roots: list[Path], write_root: Path):
    """Build the async ``can_use_tool`` callback the Claude Agent SDK expects.

    The returned callback evaluates each tool call with :func:`decide_tool_permission` and
    translates the result into the SDK's ``PermissionResultAllow`` or
    ``PermissionResultDeny``. The SDK is imported lazily here so that the pure decision
    logic in this module can be imported and tested without the SDK installed.

    Args:
        readable_roots: Directories the agent may read.
        write_root: The single repository the agent may write to.

    Returns:
        An async callable with the signature
        ``(tool_name, tool_input, context) -> PermissionResultAllow | PermissionResultDeny``.

    Example:
        >>> from pathlib import Path
        >>> callback = build_tool_permission_callback([Path("E:/GitHub")], Path("E:/GitHub/app"))
        >>> callable(callback)
        True
    """
    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

    async def can_use_tool(tool_name: str, tool_input: dict, context) -> object:
        """Evaluate one tool call and return the SDK permission result."""
        decision = decide_tool_permission(
            tool_name, tool_input, readable_roots, write_root
        )
        if decision.is_allowed:
            return PermissionResultAllow()
        return PermissionResultDeny(message=decision.reason)

    return can_use_tool
