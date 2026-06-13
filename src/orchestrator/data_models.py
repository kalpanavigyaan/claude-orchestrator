"""Plain data containers shared across the orchestrator modules.

These dataclasses carry validated, normalized values between the configuration loader,
the task discovery step, the runner, and the reporting step. They contain no behavior
beyond simple construction so that every other module can depend on them safely.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


@dataclass
class Schedule:
    """A time window during which the orchestrator is allowed to do work.

    Attributes:
        start_time: The moment the orchestrator may begin processing tasks.
        end_time: The hard deadline after which no new work is started or continued.
        timezone_name: Optional IANA timezone name (for example ``"America/New_York"``).
            When ``None`` the system local time is used.

    Example:
        >>> from datetime import datetime
        >>> schedule = Schedule(
        ...     start_time=datetime(2026, 6, 13, 22, 0),
        ...     end_time=datetime(2026, 6, 14, 6, 0),
        ...     timezone_name="America/New_York",
        ... )
        >>> schedule.end_time > schedule.start_time
        True
    """

    start_time: datetime
    end_time: datetime
    timezone_name: str | None = None


@dataclass
class Scope:
    """The set of folders the agent is permitted to read.

    Write access is never granted here; it is granted per task by the instruction
    markdown that names a target repository (see :class:`Task`).

    Attributes:
        readable_roots: Absolute, normalized directories the agent may read and search.

    Example:
        >>> from pathlib import Path
        >>> scope = Scope(readable_roots=[Path("E:/GitHub")])
        >>> scope.readable_roots[0].name
        'GitHub'
    """

    readable_roots: list[Path]


@dataclass
class Limits:
    """Optional cumulative safety caps for a whole run.

    Attributes:
        maximum_cost_usd: Stop launching new tasks once this much spend is recorded.
            ``None`` disables the cap.
        maximum_total_turns: Stop launching new tasks once this many agentic turns are
            recorded across all tasks. ``None`` disables the cap.

    Example:
        >>> limits = Limits(maximum_cost_usd=5.0, maximum_total_turns=None)
        >>> limits.maximum_cost_usd
        5.0
    """

    maximum_cost_usd: float | None = None
    maximum_total_turns: int | None = None


@dataclass
class Defaults:
    """Default behavior applied to every task unless a task overrides it.

    Attributes:
        model: Model identifier, or ``None`` to use the Claude Code default for the plan.
        maximum_turns: Per-task cap on agentic turns (tool-use round trips).
        permission_mode: Claude Agent SDK permission mode. The in-code permission
            callback performs the real read/write gating regardless of this value.
        commit_interval_minutes: How often a long-running task should commit progress.
        push: Whether to push commits to the remote by default.
        usage_checkpoint_minutes: How often accumulated usage is logged.

    Example:
        >>> defaults = Defaults(
        ...     model=None,
        ...     maximum_turns=200,
        ...     permission_mode="default",
        ...     commit_interval_minutes=30,
        ...     push=True,
        ...     usage_checkpoint_minutes=15,
        ... )
        >>> defaults.maximum_turns
        200
    """

    model: str | None
    maximum_turns: int
    permission_mode: str
    commit_interval_minutes: int
    push: bool
    usage_checkpoint_minutes: int


@dataclass
class Configuration:
    """The fully validated orchestrator configuration.

    Attributes:
        schedule: The allowed time window.
        scope: The readable folder scope.
        defaults: Per-task default behavior.
        limits: Optional cumulative safety caps.

    Example:
        >>> from datetime import datetime
        >>> from pathlib import Path
        >>> configuration = Configuration(
        ...     schedule=Schedule(datetime(2026, 6, 13, 22, 0), datetime(2026, 6, 14, 6, 0)),
        ...     scope=Scope(readable_roots=[Path("E:/GitHub")]),
        ...     defaults=Defaults(None, 200, "default", 30, True, 15),
        ...     limits=Limits(),
        ... )
        >>> configuration.defaults.push
        True
    """

    schedule: Schedule
    scope: Scope
    defaults: Defaults
    limits: Limits


@dataclass
class Task:
    """A single unit of work parsed from one instruction markdown file.

    Attributes:
        instruction_path: Path to the markdown file this task was read from.
        repository_path: The target repository. Naming it here grants write access to it.
        mode: Either ``"refactor"`` (existing repository) or ``"new"`` (new repository).
        body_text: The free-form instruction body passed to the agent as the prompt.
        branch_name: Optional git branch to use or create. ``None`` keeps the current branch.
        push_override: Optional per-task override of the default push behavior.

    Example:
        >>> from pathlib import Path
        >>> task = Task(
        ...     instruction_path=Path("instructions/example/001_task.md"),
        ...     repository_path=Path("E:/GitHub/my-existing-app"),
        ...     mode="refactor",
        ...     body_text="# Task: tidy the README",
        ...     branch_name="orchestrator/tidy-readme",
        ...     push_override=None,
        ... )
        >>> task.mode
        'refactor'
    """

    instruction_path: Path
    repository_path: Path
    mode: str
    body_text: str
    branch_name: str | None = None
    push_override: bool | None = None


@dataclass
class TaskUsage:
    """Token and cost usage recorded for one completed task run.

    Attributes:
        input_tokens: Total input tokens consumed.
        output_tokens: Total output tokens produced.
        cache_read_input_tokens: Input tokens served from the prompt cache.
        cache_creation_input_tokens: Input tokens written to the prompt cache.
        cost_usd: Reported cost in US dollars, when available.

    Example:
        >>> usage = TaskUsage(input_tokens=1200, output_tokens=800, cost_usd=0.0)
        >>> usage.input_tokens + usage.output_tokens
        2000
    """

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cost_usd: float = 0.0


@dataclass
class TaskRunResult:
    """The outcome of running a single task through the agent.

    Attributes:
        task: The task that was run.
        succeeded: Whether the agent finished without an error result.
        number_of_turns: How many agentic turns the run took.
        usage: Token and cost usage for the run.
        summary_text: The agent's final result text, when available.
        error_message: A human-readable error description when the run failed.
        rate_limited: Whether the run stopped because the usage limit was actually hit
            (the rate limit status was ``"rejected"``, not merely an approaching-limit
            warning).
        rate_limit_reset_epoch: Unix timestamp when the usage window resets, when the
            platform reported one; ``None`` falls back to a five-hour estimate.

    Example:
        >>> from pathlib import Path
        >>> task = Task(Path("a.md"), Path("E:/GitHub/app"), "new", "body")
        >>> result = TaskRunResult(task=task, succeeded=True, number_of_turns=12)
        >>> result.succeeded
        True
    """

    task: Task
    succeeded: bool = False
    number_of_turns: int = 0
    usage: TaskUsage = field(default_factory=TaskUsage)
    summary_text: str | None = None
    error_message: str | None = None
    rate_limited: bool = False
    rate_limit_reset_epoch: int | None = None
