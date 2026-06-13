"""Write the per-repository orchestrator run record.

The agent maintains its own work report (``REPORT_YYYYMMDD.md``) while it works, as
instructed by the system prompt. This module writes a *separate*, orchestrator-level run
record named ``orchestrator_run_YYYYMMDD.md`` so it never collides with or duplicates the
agent's report. After each task it appends a clearly marked section recording the
timestamp, the instruction file, the outcome, token usage, cost, and (when git is
available) the recent commit history.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from .data_models import Task, TaskRunResult
from .git_operations import get_recent_commit_log, is_git_repository
from .logging_setup import get_logger

REPORT_FILENAME_TEMPLATE = "orchestrator_run_{timestamp}.md"
REPORT_FILENAME_GLOB = "orchestrator_run_*.md"


def report_path_for_repository(repository_path: Path, run_timestamp: datetime) -> Path:
    """Return the timestamped orchestrator run-record path for a repository.

    This is the orchestrator's own audit file
    (``orchestrator_run_YYYYMMDD_HHMMSS.md``), distinct from the agent's
    ``REPORT_YYYYMMDD.md`` work report. Including the time gives each run its own file.

    Args:
        repository_path: The repository whose run record is being written.
        run_timestamp: The run's start time, used to form the
            ``orchestrator_run_YYYYMMDD_HHMMSS.md`` filename.

    Returns:
        The path to the run-record file inside the repository.

    Example:
        >>> from datetime import datetime
        >>> from pathlib import Path
        >>> report_path_for_repository(Path("E:/GitHub/app"), datetime(2026, 6, 13, 22, 30, 15)).name
        'orchestrator_run_20260613_223015.md'
    """
    filename = REPORT_FILENAME_TEMPLATE.format(timestamp=run_timestamp.strftime("%Y%m%d_%H%M%S"))
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


def append_task_report(
    task: Task,
    result: TaskRunResult,
    now: datetime,
    run_timestamp: datetime | None = None,
) -> Path | None:
    """Append a task section to the orchestrator run-record file.

    Creates the run-record file with a title header if it does not yet exist, then appends
    the section for this task. The filename is derived from ``run_timestamp`` so that every
    task in the same run is recorded in one ``orchestrator_run_YYYYMMDD_HHMMSS.md`` file,
    while each section is stamped with its own ``now`` time.

    Args:
        task: The task that was run.
        result: The outcome of the run.
        now: The time this section is written (used in the section heading).
        run_timestamp: The run's start time, used for the filename. Defaults to ``now``.

    Returns:
        The path to the run-record file, or ``None`` if the repository directory does not
        exist (so nothing could be written).

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

    report_path = report_path_for_repository(task.repository_path, run_timestamp or now)
    section_text = build_report_section(task, result, now)

    if not report_path.exists():
        header = (
            f"# Orchestrator run record for {task.repository_path.name}\n\n"
            f"Generated by claude-orchestrator on {now.strftime('%Y-%m-%d')}. "
            f"This is the orchestrator's audit log; the agent's work report is "
            f"`REPORT_{now.strftime('%Y%m%d')}.md`.\n\n"
        )
        report_path.write_text(header + section_text, encoding="utf-8")
    else:
        with report_path.open("a", encoding="utf-8") as report_file:
            report_file.write("\n" + section_text)

    logger.info("Wrote report section to %s", report_path)
    return report_path
