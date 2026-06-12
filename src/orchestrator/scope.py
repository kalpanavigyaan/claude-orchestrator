"""Path normalization and read/write boundary checks.

The orchestrator runs on a Windows host but must reason about folders that live on the
Windows host and inside WSL2 distributions. WSL paths can appear in several forms:

    * ``//wsl$/Ubuntu/home/user/project``     (UNC form, older Windows builds)
    * ``//wsl.localhost/Ubuntu/home/user/...`` (UNC form, newer Windows builds)
    * ``E:/GitHub/project``                     (ordinary Windows drive path)

This module converts any such string into a canonical, comparable form and answers the
core safety question: "is this path inside an allowed root?" That question underpins the
permission callback that lets the agent read the configured scope but only write to the
repository a task explicitly names.
"""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath, PureWindowsPath


def normalize_path(raw_path: str | Path) -> Path:
    """Convert a host or WSL path string into a canonical, comparable ``Path``.

    The result has forward/back slashes resolved by the operating system, a normalized
    case-insensitive drive letter on Windows, and any ``..`` segments collapsed. The path
    is not required to exist; non-existent paths are normalized lexically.

    Args:
        raw_path: A path as written in configuration or instruction front matter. May be a
            Windows drive path, a WSL UNC path (``//wsl$/...`` or ``//wsl.localhost/...``),
            or an already-normalized ``Path``.

    Returns:
        A normalized ``Path`` suitable for containment comparisons.

    Example:
        >>> str(normalize_path("E:/GitHub/../GitHub/app")).replace("\\\\", "/").lower()
        'e:/github/app'
        >>> "wsl" in str(normalize_path("//wsl$/Ubuntu/home/user/app")).lower()
        True
    """
    text = str(raw_path).strip().strip('"').strip("'")

    # Preserve UNC prefixes (WSL paths) which use leading double slashes.
    is_unc = text.startswith("\\\\") or text.startswith("//")

    # Normalize slash direction to the host separator for consistent comparison.
    text = text.replace("/", os.sep).replace("\\", os.sep)
    if is_unc and not text.startswith(os.sep + os.sep):
        text = os.sep + os.sep + text.lstrip(os.sep)

    # Collapse redundant separators and ``..`` segments lexically (no filesystem access).
    normalized_text = os.path.normpath(text)

    # On Windows, lower-case the drive letter so "E:" and "e:" compare equal.
    if os.name == "nt" and len(normalized_text) >= 2 and normalized_text[1] == ":":
        normalized_text = normalized_text[0].lower() + normalized_text[1:]

    return Path(normalized_text)


def _comparable_parts(path: Path) -> tuple[str, ...]:
    """Return the lower-cased path components used for case-insensitive containment.

    Windows and WSL UNC paths are treated case-insensitively because the Windows host
    filesystem and the ``\\\\wsl$`` bridge are case-insensitive from the host's view.

    Args:
        path: A path already passed through :func:`normalize_path`.

    Returns:
        A tuple of lower-cased, non-empty path components.

    Example:
        >>> _comparable_parts(normalize_path("E:/GitHub/App"))[-1]
        'app'
    """
    text = str(path)
    if os.name == "nt":
        pure: PureWindowsPath | PurePosixPath = PureWindowsPath(text)
    else:
        pure = PurePosixPath(text)
    return tuple(part.lower() for part in pure.parts if part not in ("", os.sep))


def is_within_root(candidate_path: str | Path, root_path: str | Path) -> bool:
    """Return whether ``candidate_path`` is the same as, or nested inside, ``root_path``.

    Both paths are normalized first, then compared component by component so that, for
    example, ``E:/GitHub/app/src/main.py`` is inside ``E:/GitHub/app`` but
    ``E:/GitHubOther/app`` is not (a prefix-string check would wrongly accept the latter).

    Args:
        candidate_path: The path being checked (for example a file an agent wants to edit).
        root_path: The allowed root directory.

    Returns:
        ``True`` if the candidate is within the root, ``False`` otherwise.

    Example:
        >>> is_within_root("E:/GitHub/app/src/main.py", "E:/GitHub/app")
        True
        >>> is_within_root("E:/GitHubOther/app", "E:/GitHub/app")
        False
    """
    candidate_parts = _comparable_parts(normalize_path(candidate_path))
    root_parts = _comparable_parts(normalize_path(root_path))
    if len(candidate_parts) < len(root_parts):
        return False
    return candidate_parts[: len(root_parts)] == root_parts


def is_within_any_root(candidate_path: str | Path, root_paths: list[Path]) -> bool:
    """Return whether ``candidate_path`` is within any of the given roots.

    Args:
        candidate_path: The path being checked.
        root_paths: A list of allowed root directories.

    Returns:
        ``True`` if the candidate is within at least one root, ``False`` otherwise.

    Example:
        >>> from pathlib import Path
        >>> roots = [Path("E:/GitHub"), Path("D:/work")]
        >>> is_within_any_root("E:/GitHub/app/main.py", roots)
        True
        >>> is_within_any_root("C:/temp/file.txt", roots)
        False
    """
    return any(is_within_root(candidate_path, root) for root in root_paths)
