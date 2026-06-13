"""Git repository helpers, safety-net commits, and commit history for reports.

The agent commits and pushes its own work as instructed by the system prompt. These
helpers provide a safety net (committing any work the agent left uncommitted at the end of
a task) and gather the commit history that the report records. Every function shells out
to the ``git`` command in the repository directory and fails softly, logging problems
rather than raising, so a git hiccup never aborts the whole run.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .logging_setup import get_logger


def _run_git_command(repository_path: Path, arguments: list[str]) -> subprocess.CompletedProcess:
    """Run a git command in a repository and capture its output.

    Args:
        repository_path: The repository working directory to run git in.
        arguments: The git arguments (without the leading ``git``).

    Returns:
        The completed process, with ``stdout``/``stderr`` captured as text.

    Example:
        >>> # result = _run_git_command(Path("E:/GitHub/app"), ["rev-parse", "--show-toplevel"])
        >>> # result.returncode in (0, 128)
        >>> True
        True
    """
    try:
        return subprocess.run(
            ["git", *arguments],
            cwd=str(repository_path),
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        # git missing from PATH, or the working directory cannot be used (for example a
        # UNC path Windows refuses as a process working directory). Fail softly so callers
        # treat it as "git unavailable" rather than crashing the run.
        get_logger().warning("git could not run in %s: %s", repository_path, error)
        return subprocess.CompletedProcess(args=["git", *arguments], returncode=1, stdout="", stderr=str(error))


def is_git_repository(repository_path: Path) -> bool:
    """Return whether a directory is inside a git working tree.

    Args:
        repository_path: The directory to test.

    Returns:
        ``True`` if the directory is part of a git repository, ``False`` otherwise.

    Example:
        >>> # is_git_repository(Path("E:/GitHub/app"))
        >>> True
        True
    """
    if not repository_path.exists():
        return False
    result = _run_git_command(repository_path, ["rev-parse", "--is-inside-work-tree"])
    return result.returncode == 0 and result.stdout.strip() == "true"


def get_current_branch_name(repository_path: Path) -> str | None:
    """Return the name of the currently checked-out branch.

    Args:
        repository_path: The repository directory.

    Returns:
        The branch name, or ``None`` if it cannot be determined.

    Example:
        >>> # get_current_branch_name(Path("E:/GitHub/app"))
        >>> "main"
        'main'
    """
    result = _run_git_command(repository_path, ["rev-parse", "--abbrev-ref", "HEAD"])
    if result.returncode != 0:
        return None
    branch_name = result.stdout.strip()
    return branch_name or None


def has_uncommitted_changes(repository_path: Path) -> bool:
    """Return whether the repository has staged or unstaged changes.

    Args:
        repository_path: The repository directory.

    Returns:
        ``True`` if ``git status --porcelain`` reports any changes.

    Example:
        >>> # has_uncommitted_changes(Path("E:/GitHub/app"))
        >>> False
        False
    """
    result = _run_git_command(repository_path, ["status", "--porcelain"])
    return bool(result.stdout.strip())


def commit_all_changes(repository_path: Path, commit_message: str) -> bool:
    """Stage and commit all changes as a safety net at the end of a task.

    Does nothing and returns ``False`` if there are no changes to commit.

    Args:
        repository_path: The repository directory.
        commit_message: The commit message to use.

    Returns:
        ``True`` if a commit was created, ``False`` if there was nothing to commit or git
        failed.

    Example:
        >>> # commit_all_changes(Path("E:/GitHub/app"), "orchestrator: safety-net commit")
        >>> True
        True
    """
    logger = get_logger()
    if not has_uncommitted_changes(repository_path):
        return False
    stage_result = _run_git_command(repository_path, ["add", "-A"])
    if stage_result.returncode != 0:
        logger.warning("git add failed in %s: %s", repository_path, stage_result.stderr.strip())
        return False
    commit_result = _run_git_command(repository_path, ["commit", "-m", commit_message])
    if commit_result.returncode != 0:
        logger.warning("git commit failed in %s: %s", repository_path, commit_result.stderr.strip())
        return False
    logger.info("Safety-net commit created in %s", repository_path)
    return True


def push_current_branch(repository_path: Path) -> bool:
    """Push the current branch to its remote, setting upstream if needed.

    Args:
        repository_path: The repository directory.

    Returns:
        ``True`` if the push succeeded, ``False`` otherwise.

    Example:
        >>> # push_current_branch(Path("E:/GitHub/app"))
        >>> True
        True
    """
    logger = get_logger()
    branch_name = get_current_branch_name(repository_path)
    if not branch_name:
        logger.warning("Could not determine branch to push in %s", repository_path)
        return False
    result = _run_git_command(repository_path, ["push", "--set-upstream", "origin", branch_name])
    if result.returncode != 0:
        logger.warning("git push failed in %s: %s", repository_path, result.stderr.strip())
        return False
    logger.info("Pushed branch '%s' in %s", branch_name, repository_path)
    return True


def get_recent_commit_log(repository_path: Path, maximum_count: int = 50) -> list[str]:
    """Return recent commit summaries for inclusion in the report.

    Args:
        repository_path: The repository directory.
        maximum_count: The maximum number of commits to return.

    Returns:
        A list of one-line commit summaries (``<short-hash> <subject>``), newest first.
        Empty if the history cannot be read.

    Example:
        >>> # log = get_recent_commit_log(Path("E:/GitHub/app"), maximum_count=5)
        >>> # isinstance(log, list)
        >>> True
        True
    """
    result = _run_git_command(
        repository_path,
        ["log", f"--max-count={maximum_count}", "--pretty=format:%h %ci %s"],
    )
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]
