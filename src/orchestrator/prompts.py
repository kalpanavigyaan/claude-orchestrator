"""Build the system prompt that encodes the orchestrator's autonomy rules.

The orchestrator runs with no human in the loop, so the rules from the project
specification are stated to the agent up front: work independently, never ask for
confirmation, stay inside the named repository for writes, test and document before
committing, commit and push periodically, use full descriptive names, give every function
a docstring with an example, and maintain a per-repository report file.
"""

from __future__ import annotations

from datetime import datetime

from .data_models import Task

_AUTONOMY_RULES_TEMPLATE = """\
You are running fully autonomously as part of a scheduled, unattended batch. There is no
human available to answer questions. Make reasonable decisions and keep working until the
task is complete or you are genuinely blocked.

Operating rules (these are mandatory):
1. Work independently. Never ask for confirmation or wait for user input.
2. Writes are restricted to this repository: {repository_path}
   You may read other folders in scope, but you must not modify anything outside this
   repository. Attempts to write outside it will be denied.
3. Task mode is "{mode}".
   - "refactor": improve the existing repository as instructed.
   - "new": build the new repository as instructed, initializing it if needed.
4. Test and validate every change. Run the project's tests and only commit once they pass.
5. Document your work: keep code comments and project documentation up to date.
6. Use full, descriptive names for variables, functions, and files. Never abbreviate.
7. Give every function a docstring that includes a detailed, runnable example.
8. Commit periodically with clear, descriptive messages, and push to the remote{push_clause}.
9. Maintain a single work report file named REPORT_{report_timestamp}.md (date and time)
   in this repository, unless your task instructions specify a different report filename or
   location, in which case follow the instructions. Record the date and time, the tasks
   performed, and the commit history. You may split details across additional linked
   markdown files, but keep one primary report per repository.
{branch_clause}
"""


def build_system_prompt(task: Task, push_enabled: bool, now: datetime) -> str:
    """Build the system prompt string for a single task run.

    Args:
        task: The task being run, used for the repository path, mode, and branch.
        push_enabled: Whether commits should be pushed to the remote for this task.
        now: The current time, used to stamp the report filename
            (``REPORT_YYYYMMDD_HHMMSS.md``).

    Returns:
        The fully rendered system prompt.

    Example:
        >>> from datetime import datetime
        >>> from pathlib import Path
        >>> task = Task(Path("a.md"), Path("E:/GitHub/app"), "new", "body", branch_name="feature/x")
        >>> prompt = build_system_prompt(task, push_enabled=True, now=datetime(2026, 6, 13, 22, 0))
        >>> "REPORT_20260613_220000.md" in prompt
        True
        >>> "E:/GitHub/app" in prompt or "E:\\\\GitHub\\\\app" in prompt
        True
    """
    report_timestamp = now.strftime("%Y%m%d_%H%M%S")
    push_clause = "" if push_enabled else " (do not push for this task)"
    if task.branch_name:
        branch_clause = (
            f"10. Use the git branch '{task.branch_name}' for this work, creating it if it "
            f"does not already exist."
        )
    else:
        branch_clause = "10. Use the repository's current branch unless the task says otherwise."

    return _AUTONOMY_RULES_TEMPLATE.format(
        repository_path=str(task.repository_path),
        mode=task.mode,
        push_clause=push_clause,
        report_timestamp=report_timestamp,
        branch_clause=branch_clause,
    )
