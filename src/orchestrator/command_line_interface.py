"""The Typer command-line application for claude-orchestrator.

Commands:
    run       Wait for the schedule window, then run every task in an instructions folder.
    validate  Validate a configuration file and, optionally, an instructions folder.
    report    Locate the latest report file for a repository.
    version   Print the application version.

The ``run`` command contains the main orchestration loop: it processes tasks sequentially
inside the schedule window, enforces the read/write scope through the Claude Agent SDK
permission callback, records usage, makes safety-net commits, writes per-repository
reports, and waits for the five-hour usage reset when the usage limit is reached.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

import typer

from . import APPLICATION_NAME, APPLICATION_VERSION
from .configuration import ConfigurationError, load_configuration
from .data_models import Configuration, Task
from .discovery import DiscoveryError, discover_tasks
from .git_operations import commit_all_changes, push_current_branch
from .logging_setup import configure_logging, get_logger
from .permissions import decide_tool_permission
from .reporting import append_task_report, report_path_for_repository
from .scheduler import current_time, is_within_window, wait_until_start
from .task_runner import run_single_task
from .usage import UsageTracker, compute_reset_time, wait_for_usage_reset

MAXIMUM_RETRIES_AFTER_RESET = 3

app = typer.Typer(
    add_completion=False,
    help="Orchestrate autonomous Claude Code agents from markdown task files.",
)


def _preview_permission_decisions(task: Task, configuration: Configuration) -> None:
    """Print example permission decisions for a task without running anything.

    Shows that a write inside the task repository is allowed while a write outside it is
    denied, so a dry run makes the scope boundary visible.

    Args:
        task: The task whose scope is being previewed.
        configuration: The configuration providing the readable roots.

    Example:
        >>> # _preview_permission_decisions(task, configuration)  # prints allow/deny lines
    """
    inside_path = str(task.repository_path / "example_file.py")
    outside_path = str(task.repository_path.parent / "other_repository" / "example_file.py")
    roots = configuration.scope.readable_roots

    inside_decision = decide_tool_permission("Write", {"file_path": inside_path}, roots, task.repository_path)
    outside_decision = decide_tool_permission("Write", {"file_path": outside_path}, roots, task.repository_path)

    typer.echo(f"    write inside  {inside_path}: allowed={inside_decision.is_allowed}")
    typer.echo(f"    write outside {outside_path}: allowed={outside_decision.is_allowed}")


async def _execute_run(
    configuration: Configuration,
    tasks: list[Task],
    run_immediately: bool,
) -> None:
    """Run the main orchestration loop over the discovered tasks.

    Waits for the start time (unless running immediately), then processes each task in
    order while inside the schedule window, enforcing cumulative limits, writing reports,
    making safety-net commits, and waiting for the five-hour usage reset when the usage
    limit is reached.

    Args:
        configuration: The validated configuration.
        tasks: The tasks to run, in order.
        run_immediately: If ``True``, skip waiting for the start time (the end deadline
            still applies).

    Example:
        >>> # asyncio.run(_execute_run(configuration, tasks, run_immediately=True))
    """
    logger = get_logger()
    schedule = configuration.schedule
    usage_tracker = UsageTracker()

    if not run_immediately:
        await wait_until_start(schedule)

    task_index = 0
    retries_by_index: dict[int, int] = {}

    while task_index < len(tasks):
        now = current_time(schedule)
        if now >= schedule.end_time:
            logger.info("Schedule end time %s reached; stopping before the next task.", schedule.end_time)
            break
        if usage_tracker.has_exceeded_limits(configuration.limits):
            logger.info("Cumulative usage limit reached; stopping.")
            break

        task = tasks[task_index]
        result = await run_single_task(task, configuration, now=now)
        usage_tracker.record_task_result(result)
        append_task_report(task, result, now)

        push_enabled = (
            task.push_override if task.push_override is not None else configuration.defaults.push
        )
        if commit_all_changes(
            task.repository_path, "orchestrator: safety-net commit of remaining work"
        ) and push_enabled:
            push_current_branch(task.repository_path)

        if usage_tracker.is_checkpoint_due(configuration.defaults.usage_checkpoint_minutes, now):
            usage_tracker.log_checkpoint(now)

        if result.rate_limited:
            reset_time = compute_reset_time(now, provided_reset_time=None)
            resumed = await wait_for_usage_reset(
                reset_time,
                schedule.end_time,
                now_provider=lambda: current_time(schedule),
            )
            if not resumed:
                break
            attempts = retries_by_index.get(task_index, 0)
            if attempts < MAXIMUM_RETRIES_AFTER_RESET:
                retries_by_index[task_index] = attempts + 1
                logger.info("Retrying task %s after usage reset.", task.instruction_path)
                continue
            logger.warning(
                "Task %s still incomplete after %d retries; moving on.",
                task.instruction_path,
                attempts,
            )

        task_index += 1

    usage_tracker.log_checkpoint(current_time(schedule))
    logger.info("Run complete.")


@app.command()
def run(
    instructions_subfolder: str = typer.Argument(
        ..., help="Folder containing the instruction markdown files to process."
    ),
    config: str = typer.Option(
        "config/orchestrator.yaml", help="Path to the YAML configuration file."
    ),
    now: bool = typer.Option(
        False, "--now", help="Skip waiting for the start time (the end deadline still applies)."
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Show the plan and scope decisions without spawning agents."
    ),
) -> None:
    """Process every task in an instructions folder within the schedule window.

    Example:
        Run the example instructions immediately::

            uv run python scripts/orchestrator.py run instructions/example --now
    """
    configure_logging()
    logger = get_logger()

    try:
        configuration = load_configuration(config)
        tasks = discover_tasks(instructions_subfolder)
    except (ConfigurationError, DiscoveryError) as error:
        typer.secho(str(error), fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1) from error

    logger.info("Loaded configuration from %s", config)
    logger.info("Discovered %d task(s) in %s", len(tasks), instructions_subfolder)

    if dry_run:
        typer.echo("Dry run - no agents will be spawned.")
        typer.echo(f"Schedule: {configuration.schedule.start_time} -> {configuration.schedule.end_time}")
        typer.echo(f"Readable roots: {[str(root) for root in configuration.scope.readable_roots]}")
        for task in tasks:
            typer.echo(f"  Task {task.instruction_path} -> repo {task.repository_path} (mode={task.mode})")
            _preview_permission_decisions(task, configuration)
        return

    asyncio.run(_execute_run(configuration, tasks, run_immediately=now))


@app.command()
def validate(
    config: str = typer.Option(
        "config/orchestrator.yaml", help="Path to the YAML configuration file."
    ),
    instructions_subfolder: str = typer.Option(
        None, help="Optional instructions folder to validate alongside the configuration."
    ),
) -> None:
    """Validate the configuration and, optionally, an instructions folder.

    Example:
        Validate the configuration and the example instructions::

            uv run python scripts/orchestrator.py validate --instructions-subfolder instructions/example
    """
    try:
        configuration = load_configuration(config)
    except ConfigurationError as error:
        typer.secho(str(error), fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1) from error

    typer.secho("Configuration is valid.", fg=typer.colors.GREEN)
    typer.echo(f"Schedule: {configuration.schedule.start_time} -> {configuration.schedule.end_time}")
    typer.echo(f"Readable roots: {[str(root) for root in configuration.scope.readable_roots]}")

    if instructions_subfolder:
        try:
            tasks = discover_tasks(instructions_subfolder)
        except DiscoveryError as error:
            typer.secho(str(error), fg=typer.colors.RED, err=True)
            raise typer.Exit(code=1) from error
        typer.secho(f"Discovered {len(tasks)} task(s):", fg=typer.colors.GREEN)
        for task in tasks:
            typer.echo(f"  {task.instruction_path} -> {task.repository_path} (mode={task.mode})")


@app.command()
def report(
    repository: str = typer.Argument(..., help="Path to the repository whose report to locate."),
) -> None:
    """Locate today's report file for a repository and print its path and contents.

    Example:
        Show today's report for a repository::

            uv run python scripts/orchestrator.py report E:/GitHub/my-existing-app
    """
    report_path = report_path_for_repository(Path(repository), datetime.now())
    if not report_path.exists():
        typer.secho(f"No report found at {report_path}", fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)
    typer.echo(f"Report: {report_path}")
    typer.echo(report_path.read_text(encoding="utf-8"))


@app.command()
def version() -> None:
    """Print the application name and version.

    Example:
        Print the version::

            uv run python scripts/orchestrator.py version
    """
    typer.echo(f"{APPLICATION_NAME} {APPLICATION_VERSION}")


if __name__ == "__main__":
    app()
