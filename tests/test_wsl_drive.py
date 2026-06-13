"""Tests for WSL UNC-path to drive-letter mapping (pure translation logic).

These tests cover the path parsing and translation that does not require actually mapping a
drive, plus the no-op behavior for ordinary Windows-host paths (which must not invoke
``net use`` at all).
"""

from pathlib import Path

from orchestrator.wsl_drive import (
    is_unc_path,
    mapped_paths,
    split_share_root,
    _translate_with_mapping,
)


def test_is_unc_path_detects_unc_and_drive_paths():
    """is_unc_path is True for UNC paths and False for ordinary drive paths."""
    assert is_unc_path(Path(r"\\wsl.localhost\Ubuntu\home"))
    assert is_unc_path(Path("//server/share/dir"))
    assert not is_unc_path(Path("E:/GitHub/app"))


def test_split_share_root_extracts_server_and_share():
    """split_share_root returns the \\\\server\\share root and the remaining components."""
    share_root, remainder = split_share_root(Path(r"\\wsl.localhost\Ubuntu-24-04-Vani\home\user"))
    assert share_root == r"\\wsl.localhost\Ubuntu-24-04-Vani"
    assert remainder == ["home", "user"]


def test_translate_with_mapping_translates_unc_to_drive():
    """_translate_with_mapping rewrites a UNC path under a mapped share to a drive path."""
    mapping = {r"\\WSL.LOCALHOST\UBUNTU-24-04-VANI": "Z"}
    translated = _translate_with_mapping(
        Path(r"\\wsl.localhost\Ubuntu-24-04-Vani\home\ramanan\writing"), mapping
    )
    assert str(translated) == r"Z:\home\ramanan\writing"


def test_translate_with_mapping_passes_through_non_unc():
    """_translate_with_mapping returns ordinary drive paths unchanged."""
    translated = _translate_with_mapping(Path("E:/GitHub/app"), {})
    assert translated == Path("E:/GitHub/app")


def test_mapped_paths_is_noop_for_windows_paths():
    """mapped_paths yields ordinary drive paths unchanged and maps no drives."""
    repository = Path("E:/GitHub/app")
    roots = [Path("E:/GitHub")]
    with mapped_paths(repository, roots) as (mapped_repository, mapped_roots):
        assert mapped_repository == repository
        assert mapped_roots == roots
