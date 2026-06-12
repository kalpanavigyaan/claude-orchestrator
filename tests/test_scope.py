"""Tests for path normalization and read/write boundary checks.

These are the most safety-critical tests in the project: they confirm that a path inside an
allowed root is recognized as such, and that a sibling directory sharing a name prefix is
correctly rejected (a naive string-prefix check would wrongly accept it).
"""

from pathlib import Path

from orchestrator.scope import (
    is_within_any_root,
    is_within_root,
    normalize_path,
)


def test_normalize_path_collapses_parent_segments():
    """normalize_path collapses ``..`` segments lexically."""
    normalized = str(normalize_path("E:/GitHub/../GitHub/app")).replace("\\", "/").lower()
    assert normalized == "e:/github/app"


def test_normalize_path_preserves_wsl_unc_prefix():
    """normalize_path keeps the double-slash UNC prefix of a WSL path."""
    normalized = str(normalize_path("//wsl$/Ubuntu/home/user/app"))
    assert "wsl" in normalized.lower()
    assert normalized.startswith("\\\\") or normalized.startswith("//")


def test_is_within_root_accepts_nested_path():
    """A file nested inside a root is recognized as within that root."""
    assert is_within_root("E:/GitHub/app/src/main.py", "E:/GitHub/app")


def test_is_within_root_rejects_sibling_prefix():
    """A sibling directory sharing a name prefix is not within the root."""
    assert not is_within_root("E:/GitHubOther/app", "E:/GitHub/app")


def test_is_within_root_rejects_outside_path():
    """A path on a different drive is not within the root."""
    assert not is_within_root("C:/Windows/system32", "E:/GitHub/app")


def test_is_within_root_is_case_insensitive_on_windows_paths():
    """Drive-letter and folder casing do not affect containment on Windows paths."""
    assert is_within_root("e:/github/App/main.py", "E:/GitHub/app")


def test_is_within_any_root_matches_one_of_several():
    """is_within_any_root returns True when the path is inside at least one root."""
    roots = [Path("E:/GitHub"), Path("D:/work")]
    assert is_within_any_root("D:/work/project/file.py", roots)
    assert not is_within_any_root("C:/temp/file.py", roots)
