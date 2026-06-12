"""Write the per-repository ``REPORT_YYYYMMDD.md`` summary file.

The agent maintains its own report while it works, as instructed by the system prompt.
This module is the orchestrator-level backstop: after each task it appends a clearly
marked section to the repository's dated report file recording the timestamp, the
instruction file, the outcome, token usage, cost, and the recent commit history. There is
one report file per repository per day, matching the project specification.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from .data_models import Task, TaskRunResult
from .git_operations import get_recent_commit_log, is_git_repository
from .logging_setup import get_logger

REPORT_FILENAME_TEMPLATE = "REPORT_{date}.md"


def report_path_for_repository(repository_path: Path, now: datetime) -> Path:
    """Return the dated report file path for a repository.

    Args:
        repository_path: The repository whose report is being written.
        now: The current time, used to form the ``REPORT_YYYYMMDD.md`` filename.

    Returns:
        The path to the report file inside the repository.

    Example:
        >>> from datetime import datetime
        >>> from pathlib import Path
        >>> report_path_for_repository(Path("E:/GitHub/app"), datetime(2026, 6, 13)).name
        'REPORT_20260613.md'
    """
    filename = REPORT_FILENAME_TEMPLATE.format(date=now.strftime("%Y%m%d"))
    return repository_path / filename


def build_report_section(task: Task, result: TaskRunResult, now: datetime) -> str:
    """Build the markdown section recording one task run.

    Args:
        task: The task that was run.
        result: The outcome of the run.
        now: The time the section is written.

    Returns:
        A markdown string describing the run, its usage, and recent commits.

    Example:
        >>> from datetime import datetime
        >>> from pathlib import Path
        >>> from .data_models import Task, TaskRunResult, TaskUsage
        >>> task = Task(Path("a.md"), Path("E:/GitHub/app"), "new", "body")
        >>> result = TaskRunResult(task=task, succeeded=True, number_of_turns=4,
        ...     usage=TaskUsage(input_tokens=100, output_tokens=50, cost_usd=0.0))
        >>> section = build_report_section(task, result, datetime(2026, 6, 13, 22, 30))
        >>> "Succeeded: True" in section
        True
    """
    outcome_lines = [
        f"## Orchestrator run at {now.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        f"- Instruction file: `{task.instruction_path}`",
        f"- Mode: {task.mode}",
        f"- Succeeded: {result.succeeded}",
        f"- Agentic turns: {result.number_of_turns}",
        (
            f"- Token usage: input={result.usage.input_tokens}, "
            f"output={result.usage.output_tokens}, "
            f"cache_read={result.usage.cache_read_input_tokens}, "
            f"cache_creation={result.usage.cache_creation_input_tokens}"
        ),
        f"- Cost (USD): {result.usage.cost_usd:.4f}",
    ]
    if result.rate_limited:
        outcome_lines.append("- Note: the run paused because the usage limit was reached.")
    if result.error_message:
        outcome_lines.append(f"- Error: {result.error_message}")
    if result.summary_text:
        outcome_lines.extend(["", "### Agent summary", "", result.summary_text.strip()])

    if is_git_repository(task.repository_path):
        commit_log = get_recent_commit_log(task.repository_path, maximum_count=20)
        outcome_lines.extend(["", "### Recent commit history", ""])
        if commit_log:
            outcome_lines.extend(f"- {entry}" for entry in commit_log)
        else:
            outcome_lines.append("- (no commits found)")

    outcome_lines.append("")
    return "\n".join(outcome_lines)


def append_task_report(task: Task, result: TaskRunResult, now: datetime) -> Path | None:
    """Append a run section to the repository's dated report file.

    Creates the report file with a title header if it does not yet exist, then appends the
    section for this run.

    Args:
        task: The task that was run.
        result: The outcome of the run.
        now: The time the report is written.

    Returns:
        The path to the report file, or ``None`` if the repository directory does not exist
        (so nothing could be written).

    Example:
        >>> # path = append_task_report(task, result, datetime.now())
        >>> # path is None or path.exists()
        >>> True
        True
    """
    logger = get_logger()
    if not task.repository_path.exists():
        logger.warning(
            "Repository %s does not exist; skipping report write.", task.repository_path
        )
        return None

    report_path = report_path_for_repository(task.repository_path, now)
    section_text = build_report_section(task, result, now)

    if not report_path.exists():
        header = (
            f"# Work report for {task.repository_path.name}\n\n"
            f"Generated by claude-orchestrator on {now.strftime('%Y-%m-%d')}.\n\n"
        )
        report_path.write_text(header + section_text, encoding="utf-8")
    else:
        with report_path.open("a", encoding="utf-8") as report_file:
            report_file.write("\n" + section_text)

    logger.info("Wrote report section to %s", report_path)
    return report_path
