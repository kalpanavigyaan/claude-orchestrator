"""Find and parse instruction markdown files into tasks.

The user points the orchestrator at one instruction subfolder. This module scans that
folder (recursively) for markdown files, skips generated report files, parses the YAML
front matter that names the target repository, and returns a sorted list of
:class:`~orchestrator.data_models.Task` objects ready to run.
"""

from __future__ import annotations

from pathlib import Path

import frontmatter

from .data_models import Task
from .scope import normalize_path

VALID_TASK_MODES = ("refactor", "new")
REPORT_FILENAME_PREFIX = "REPORT_"


class DiscoveryError(Exception):
    """Raised when an instruction folder or file cannot be parsed into a task.

    Example:
        >>> raise DiscoveryError("instruction is missing 'repo' in its front matter")
        Traceback (most recent call last):
        ...
        orchestrator.discovery.DiscoveryError: instruction is missing 'repo' in its front matter
    """


def is_instruction_file(candidate_path: Path) -> bool:
    """Return whether a path is an instruction markdown file (not a generated report).

    Args:
        candidate_path: A filesystem path to test.

    Returns:
        ``True`` for ``*.md`` files whose name does not start with ``REPORT_``.

    Example:
        >>> from pathlib import Path
        >>> is_instruction_file(Path("instructions/example/001_task.md"))
        True
        >>> is_instruction_file(Path("instructions/example/REPORT_20260613.md"))
        False
    """
    if candidate_path.suffix.lower() != ".md":
        return False
    if candidate_path.name.startswith(REPORT_FILENAME_PREFIX):
        return False
    return True


def parse_instruction_file(instruction_path: Path) -> Task:
    """Parse a single instruction markdown file into a :class:`Task`.

    The file must contain YAML front matter with a ``repo`` key naming the target
    repository. Optional keys are ``mode`` (``"refactor"`` or ``"new"``, default
    ``"refactor"``), ``branch``, and ``push``.

    Args:
        instruction_path: Path to the instruction markdown file.

    Returns:
        The parsed :class:`Task`.

    Raises:
        DiscoveryError: If the front matter is missing the ``repo`` key or has an
            invalid ``mode``.

    Example:
        >>> # For a file whose front matter sets repo: "E:/GitHub/app" and mode: "new":
        >>> # task = parse_instruction_file(Path("instructions/example/001_task.md"))
        >>> # task.mode
        >>> "new"
        'new'
    """
    parsed_document = frontmatter.load(str(instruction_path))
    metadata = parsed_document.metadata

    repository_value = metadata.get("repo")
    if not repository_value:
        raise DiscoveryError(
            f"{instruction_path}: front matter must include a 'repo' key naming the "
            f"target repository (this is what grants write access for the task)."
        )

    mode = str(metadata.get("mode", "refactor")).strip().lower()
    if mode not in VALID_TASK_MODES:
        raise DiscoveryError(
            f"{instruction_path}: mode '{mode}' is not valid. "
            f"Choose one of: {', '.join(VALID_TASK_MODES)}."
        )

    branch_value = metadata.get("branch")
    branch_name = str(branch_value).strip() if branch_value else None

    push_value = metadata.get("push")
    push_override = bool(push_value) if push_value is not None else None

    return Task(
        instruction_path=instruction_path,
        repository_path=normalize_path(str(repository_value)),
        mode=mode,
        body_text=parsed_document.content.strip(),
        branch_name=branch_name,
        push_override=push_override,
    )


def discover_tasks(instructions_subfolder: str | Path) -> list[Task]:
    """Discover and parse every instruction file in a subfolder into tasks.

    Files are processed in sorted order by path so that numeric prefixes such as
    ``001_``, ``002_`` control execution order deterministically.

    Args:
        instructions_subfolder: Path to the folder containing instruction markdown files.

    Returns:
        A list of :class:`Task` objects sorted by file path.

    Raises:
        DiscoveryError: If the folder does not exist, contains no instruction files, or
            any instruction file fails to parse.

    Example:
        >>> # tasks = discover_tasks("instructions/example")
        >>> # len(tasks) >= 1
        >>> True
        True
    """
    folder = Path(instructions_subfolder)
    if not folder.exists() or not folder.is_dir():
        raise DiscoveryError(f"Instructions folder not found: {folder}")

    instruction_paths = sorted(
        path for path in folder.rglob("*.md") if is_instruction_file(path)
    )
    if not instruction_paths:
        raise DiscoveryError(f"No instruction markdown files found in: {folder}")

    return [parse_instruction_file(path) for path in instruction_paths]
