"""Tests for discovering and parsing instruction markdown files into tasks."""

import pytest

from orchestrator.discovery import (
    DiscoveryError,
    discover_tasks,
    is_instruction_file,
    parse_instruction_file,
)
from pathlib import Path

_INSTRUCTION_TEXT = """\
---
repo: "E:/GitHub/app"
mode: "new"
branch: "feature/start"
push: false
---

# Task: build the thing

Do the work.
"""


def test_is_instruction_file_skips_report_files():
    """is_instruction_file accepts task markdown but skips generated report files."""
    assert is_instruction_file(Path("instructions/001_task.md"))
    assert not is_instruction_file(Path("instructions/REPORT_20260613.md"))
    assert not is_instruction_file(Path("instructions/notes.txt"))


def test_parse_instruction_file_reads_front_matter(tmp_path):
    """parse_instruction_file extracts repo, mode, branch, and push from front matter."""
    path = tmp_path / "001_task.md"
    path.write_text(_INSTRUCTION_TEXT, encoding="utf-8")
    task = parse_instruction_file(path)
    assert task.mode == "new"
    assert task.branch_name == "feature/start"
    assert task.push_override is False
    assert "build the thing" in task.body_text


def test_parse_instruction_file_requires_repo(tmp_path):
    """An instruction file without a repo key raises DiscoveryError."""
    path = tmp_path / "broken.md"
    path.write_text("---\nmode: new\n---\n\nbody", encoding="utf-8")
    with pytest.raises(DiscoveryError):
        parse_instruction_file(path)


def test_discover_tasks_sorts_by_path(tmp_path):
    """discover_tasks returns tasks in sorted path order and skips report files."""
    (tmp_path / "002_task.md").write_text(_INSTRUCTION_TEXT, encoding="utf-8")
    (tmp_path / "001_task.md").write_text(_INSTRUCTION_TEXT, encoding="utf-8")
    (tmp_path / "REPORT_20260613.md").write_text("ignore me", encoding="utf-8")
    tasks = discover_tasks(tmp_path)
    assert len(tasks) == 2
    assert tasks[0].instruction_path.name == "001_task.md"


def test_discover_tasks_requires_files(tmp_path):
    """discover_tasks raises DiscoveryError for an empty folder."""
    with pytest.raises(DiscoveryError):
        discover_tasks(tmp_path)
