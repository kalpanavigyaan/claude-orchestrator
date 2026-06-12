"""Tests for the tool-permission decision logic.

These confirm the central rule: the agent may read anywhere in the configured scope but
may only write inside the repository the current task names, and bash commands referencing
absolute paths outside the scope are denied.
"""

from pathlib import Path

from orchestrator.permissions import (
    decide_tool_permission,
    evaluate_bash_command,
    extract_path_from_tool_input,
)

READABLE_ROOTS = [Path("E:/GitHub")]
WRITE_ROOT = Path("E:/GitHub/app")


def test_extract_path_prefers_file_path_key():
    """extract_path_from_tool_input returns the file_path value when present."""
    assert extract_path_from_tool_input({"file_path": "E:/GitHub/app/x.py"}) == "E:/GitHub/app/x.py"


def test_extract_path_returns_none_when_absent():
    """extract_path_from_tool_input returns None when no path-like key is present."""
    assert extract_path_from_tool_input({"pattern": "*.py"}) is None


def test_write_inside_repository_is_allowed():
    """Writing inside the task repository is allowed."""
    decision = decide_tool_permission(
        "Write", {"file_path": "E:/GitHub/app/src/main.py"}, READABLE_ROOTS, WRITE_ROOT
    )
    assert decision.is_allowed


def test_write_outside_repository_is_denied():
    """Writing outside the task repository is denied even if inside a readable root."""
    decision = decide_tool_permission(
        "Write", {"file_path": "E:/GitHub/other/main.py"}, READABLE_ROOTS, WRITE_ROOT
    )
    assert not decision.is_allowed


def test_read_inside_scope_but_outside_repository_is_allowed():
    """Reading inside the readable scope but outside the repository is allowed."""
    decision = decide_tool_permission(
        "Read", {"file_path": "E:/GitHub/other/main.py"}, READABLE_ROOTS, WRITE_ROOT
    )
    assert decision.is_allowed


def test_read_outside_all_scope_is_denied():
    """Reading a path outside both the scope and the repository is denied."""
    decision = decide_tool_permission(
        "Read", {"file_path": "C:/secrets/passwords.txt"}, READABLE_ROOTS, WRITE_ROOT
    )
    assert not decision.is_allowed


def test_bash_relative_command_is_allowed():
    """A bash command using only relative paths runs inside the repo and is allowed."""
    decision = evaluate_bash_command("pytest -q && git add -A", READABLE_ROOTS, WRITE_ROOT)
    assert decision.is_allowed


def test_bash_absolute_outside_scope_is_denied():
    """A bash command writing to an absolute path outside the scope is denied."""
    decision = evaluate_bash_command("cp build.zip C:/Windows/temp/", READABLE_ROOTS, WRITE_ROOT)
    assert not decision.is_allowed


def test_bash_absolute_inside_repository_is_allowed():
    """A bash command referencing an absolute path inside the repository is allowed."""
    decision = evaluate_bash_command("python E:/GitHub/app/build.py", READABLE_ROOTS, WRITE_ROOT)
    assert decision.is_allowed


def test_unknown_tool_is_allowed():
    """A non-filesystem tool (for example a web tool) is allowed."""
    decision = decide_tool_permission("WebSearch", {"query": "python"}, READABLE_ROOTS, WRITE_ROOT)
    assert decision.is_allowed
