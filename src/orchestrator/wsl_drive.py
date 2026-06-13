"""Map WSL (UNC) paths to temporary drive letters so processes can use them.

Windows cannot use a UNC path such as ``\\\\wsl.localhost\\Ubuntu\\home\\user\\project`` as a
process working directory: ``CreateProcess`` rejects it. Because the orchestrator sets the
agent's working directory to the target repository, a repository that lives inside a WSL2
distribution must first be mapped to an ordinary drive letter.

This module provides a context manager that, for the duration of a run, maps each distinct
UNC share referenced by the task (the repository and the readable roots) to a free drive
letter using ``net use``, translates the UNC paths to their drive-letter equivalents, and
unmaps the drives afterwards. Paths that are already ordinary drive paths pass through
unchanged, so Windows-host repositories are unaffected.
"""

from __future__ import annotations

import os
import subprocess
from contextlib import contextmanager
from pathlib import Path

from .logging_setup import get_logger


class DriveMappingError(Exception):
    """Raised when a UNC share cannot be mapped to a drive letter.

    Example:
        >>> raise DriveMappingError("net use failed")
        Traceback (most recent call last):
        ...
        orchestrator.wsl_drive.DriveMappingError: net use failed
    """


def is_unc_path(path: Path) -> bool:
    """Return whether a path is a UNC path (begins with two slashes).

    Args:
        path: The path to test.

    Returns:
        ``True`` for UNC paths such as ``\\\\wsl.localhost\\...`` or ``//server/share``.

    Example:
        >>> from pathlib import Path
        >>> is_unc_path(Path(r"\\\\wsl.localhost\\Ubuntu\\home"))
        True
        >>> is_unc_path(Path("E:/GitHub/app"))
        False
    """
    text = str(path)
    return text.startswith("\\\\") or text.startswith("//")


def split_share_root(unc_path: Path) -> tuple[str, list[str]]:
    """Split a UNC path into its share root and the remaining components.

    The share root is the ``\\\\server\\share`` portion; the remainder is everything below it.

    Args:
        unc_path: A UNC path.

    Returns:
        A tuple ``(share_root, remainder_components)``.

    Raises:
        DriveMappingError: If the path does not contain both a server and a share name.

    Example:
        >>> from pathlib import Path
        >>> root, rest = split_share_root(Path(r"\\\\wsl.localhost\\Ubuntu\\home\\user"))
        >>> root
        '\\\\\\\\wsl.localhost\\\\Ubuntu'
        >>> rest
        ['home', 'user']
    """
    text = str(unc_path).replace("/", "\\")
    stripped = text.lstrip("\\")
    components = [part for part in stripped.split("\\") if part]
    if len(components) < 2:
        raise DriveMappingError(
            f"UNC path '{unc_path}' must include both a server and a share name."
        )
    server, share = components[0], components[1]
    share_root = f"\\\\{server}\\{share}"
    remainder = components[2:]
    return share_root, remainder


def find_free_drive_letter(excluded_letters: set[str] | None = None) -> str:
    """Return a drive letter that is not currently in use.

    Searches from ``Z`` downward so it does not collide with typical ``C:``/``D:`` drives.

    Args:
        excluded_letters: Letters to skip in addition to those already mounted (used when
            allocating several drives in one mapping session).

    Returns:
        A single upper-case drive letter (without the colon).

    Raises:
        DriveMappingError: If no free drive letter is available.

    Example:
        >>> letter = find_free_drive_letter()
        >>> len(letter) == 1 and letter.isalpha()
        True
    """
    excluded = {letter.upper() for letter in (excluded_letters or set())}
    for letter in reversed("DEFGHIJKLMNOPQRSTUVWXYZ"):
        if letter in excluded:
            continue
        if not os.path.exists(f"{letter}:\\"):
            return letter
    raise DriveMappingError("No free drive letter is available to map the WSL share.")


def _map_share_to_drive(share_root: str, drive_letter: str) -> None:
    """Map a UNC share root to a drive letter with ``net use``.

    Args:
        share_root: The ``\\\\server\\share`` to map.
        drive_letter: The single drive letter to map it to.

    Raises:
        DriveMappingError: If the ``net use`` command fails.

    Example:
        >>> # _map_share_to_drive(r"\\\\wsl.localhost\\Ubuntu", "Z")
    """
    result = subprocess.run(
        ["net", "use", f"{drive_letter}:", share_root],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise DriveMappingError(
            f"Failed to map {share_root} to {drive_letter}: with 'net use': "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )


def _unmap_drive(drive_letter: str) -> None:
    """Unmap a previously mapped drive letter, ignoring errors.

    Args:
        drive_letter: The drive letter to release.

    Example:
        >>> # _unmap_drive("Z")
    """
    subprocess.run(
        ["net", "use", f"{drive_letter}:", "/delete", "/y"],
        capture_output=True,
        text=True,
        check=False,
    )


def _translate_with_mapping(path: Path, share_to_drive: dict[str, str]) -> Path:
    """Translate a UNC path to its drive-letter equivalent using a share-to-drive map.

    Non-UNC paths and UNC paths whose share is not in the map are returned unchanged.

    Args:
        path: The path to translate.
        share_to_drive: A mapping of share roots (upper-cased) to drive letters.

    Returns:
        The translated drive-letter path, or the original path if no mapping applies.

    Example:
        >>> from pathlib import Path
        >>> mapping = {r"\\\\WSL.LOCALHOST\\UBUNTU": "Z"}
        >>> str(_translate_with_mapping(Path(r"\\\\wsl.localhost\\Ubuntu\\home\\u"), mapping))
        'Z:\\\\home\\\\u'
    """
    if not is_unc_path(path):
        return path
    share_root, remainder = split_share_root(path)
    drive_letter = share_to_drive.get(share_root.upper())
    if drive_letter is None:
        return path
    return Path(f"{drive_letter}:\\" + "\\".join(remainder))


@contextmanager
def mapped_paths(repository_path: Path, readable_roots: list[Path]):
    """Map any UNC shares used by a task to drive letters for the duration of the run.

    For each distinct UNC share among the repository and the readable roots, a free drive
    letter is mapped with ``net use``. The repository path and readable roots are then
    translated to their drive-letter equivalents and yielded. On exit, every drive mapped
    by this call is released. Paths that are already ordinary drive paths are yielded
    unchanged and no drives are mapped for them.

    Args:
        repository_path: The task's target repository (may be a UNC/WSL path).
        readable_roots: The configured readable roots (may include UNC/WSL paths).

    Yields:
        A tuple ``(translated_repository_path, translated_readable_roots)``.

    Raises:
        DriveMappingError: If a required share cannot be mapped to a drive letter.

    Example:
        >>> from pathlib import Path
        >>> # A Windows-host path needs no mapping and is yielded unchanged:
        >>> with mapped_paths(Path("E:/GitHub/app"), [Path("E:/GitHub")]) as (repo, roots):
        ...     repo == Path("E:/GitHub/app")
        True
    """
    logger = get_logger()
    all_paths = [repository_path, *readable_roots]
    share_roots: list[str] = []
    for path in all_paths:
        if is_unc_path(path):
            share_root, _ = split_share_root(path)
            if share_root.upper() not in {existing.upper() for existing in share_roots}:
                share_roots.append(share_root)

    if not share_roots:
        # Nothing to map (all paths are ordinary drive paths).
        yield repository_path, readable_roots
        return

    share_to_drive: dict[str, str] = {}
    mapped_letters: list[str] = []
    try:
        for share_root in share_roots:
            drive_letter = find_free_drive_letter(excluded_letters=set(mapped_letters))
            _map_share_to_drive(share_root, drive_letter)
            mapped_letters.append(drive_letter)
            share_to_drive[share_root.upper()] = drive_letter
            logger.info("Mapped %s to %s: for this run.", share_root, drive_letter)

        translated_repository = _translate_with_mapping(repository_path, share_to_drive)
        translated_roots = [_translate_with_mapping(root, share_to_drive) for root in readable_roots]
        yield translated_repository, translated_roots
    finally:
        for drive_letter in mapped_letters:
            _unmap_drive(drive_letter)
            logger.info("Unmapped %s: drive.", drive_letter)
