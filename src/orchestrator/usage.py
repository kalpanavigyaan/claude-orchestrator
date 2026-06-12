"""Track token usage and cost, and wait for the 5-hour usage reset when needed.

Claude subscription plans meter usage on a rolling five-hour window. When the window's
tokens are exhausted, the orchestrator should pause and wait for the reset rather than
fail, then resume (as long as it is still inside the scheduled time window). This module
accumulates per-task usage, logs periodic checkpoints, enforces optional cumulative caps,
and implements the wait-for-reset behavior.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .data_models import Limits, TaskRunResult, TaskUsage
from .logging_setup import get_logger

USAGE_RESET_WINDOW_HOURS = 5


@dataclass
class UsageTracker:
    """Accumulates usage across tasks and manages the five-hour reset window.

    Attributes:
        total_input_tokens: Sum of input tokens across all recorded task runs.
        total_output_tokens: Sum of output tokens across all recorded task runs.
        total_cost_usd: Sum of reported cost across all recorded task runs.
        total_turns: Sum of agentic turns across all recorded task runs.
        last_checkpoint_time: When usage was last logged, for checkpoint pacing.

    Example:
        >>> tracker = UsageTracker()
        >>> tracker.total_cost_usd
        0.0
    """

    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cost_usd: float = 0.0
    total_turns: int = 0
    last_checkpoint_time: datetime = field(default_factory=datetime.now)

    def record_task_result(self, result: TaskRunResult) -> None:
        """Add one task run's usage to the running totals.

        Args:
            result: The completed task run whose usage should be accumulated.

        Example:
            >>> from pathlib import Path
            >>> from .data_models import Task
            >>> tracker = UsageTracker()
            >>> task = Task(Path("a.md"), Path("E:/GitHub/app"), "new", "body")
            >>> result = TaskRunResult(task=task, succeeded=True, number_of_turns=3,
            ...     usage=TaskUsage(input_tokens=100, output_tokens=50, cost_usd=0.0))
            >>> tracker.record_task_result(result)
            >>> tracker.total_input_tokens
            100
        """
        self.total_input_tokens += result.usage.input_tokens
        self.total_output_tokens += result.usage.output_tokens
        self.total_cost_usd += result.usage.cost_usd
        self.total_turns += result.number_of_turns

    def has_exceeded_limits(self, limits: Limits) -> bool:
        """Return whether any cumulative safety cap has been reached.

        Args:
            limits: The optional cumulative caps from configuration.

        Returns:
            ``True`` if a configured cost or turn cap has been reached or exceeded.

        Example:
            >>> tracker = UsageTracker(total_cost_usd=6.0)
            >>> tracker.has_exceeded_limits(Limits(maximum_cost_usd=5.0))
            True
            >>> tracker.has_exceeded_limits(Limits(maximum_cost_usd=None))
            False
        """
        if limits.maximum_cost_usd is not None and self.total_cost_usd >= limits.maximum_cost_usd:
            return True
        if limits.maximum_total_turns is not None and self.total_turns >= limits.maximum_total_turns:
            return True
        return False

    def is_checkpoint_due(self, interval_minutes: int, now: datetime | None = None) -> bool:
        """Return whether enough time has passed to log a usage checkpoint.

        Args:
            interval_minutes: Minimum minutes between checkpoints.
            now: The reference time. Defaults to the current time.

        Returns:
            ``True`` if at least ``interval_minutes`` have elapsed since the last checkpoint.

        Example:
            >>> from datetime import datetime, timedelta
            >>> tracker = UsageTracker(last_checkpoint_time=datetime(2026, 1, 1, 0, 0))
            >>> tracker.is_checkpoint_due(15, now=datetime(2026, 1, 1, 0, 20))
            True
        """
        moment = now or datetime.now()
        return (moment - self.last_checkpoint_time) >= timedelta(minutes=interval_minutes)

    def log_checkpoint(self, now: datetime | None = None) -> None:
        """Log the accumulated usage and reset the checkpoint timer.

        Args:
            now: The reference time recorded as the new checkpoint time.

        Example:
            >>> tracker = UsageTracker()
            >>> tracker.log_checkpoint()  # writes an INFO line to the orchestrator logger
        """
        get_logger().info(
            "Usage so far: input=%d output=%d turns=%d cost=$%.4f",
            self.total_input_tokens,
            self.total_output_tokens,
            self.total_turns,
            self.total_cost_usd,
        )
        self.last_checkpoint_time = now or datetime.now()


def usage_from_sdk_usage_dictionary(usage_dictionary: dict | None, cost_usd: float | None) -> TaskUsage:
    """Convert a Claude Agent SDK usage dictionary into a :class:`TaskUsage`.

    The SDK reports usage with snake_case keys (``input_tokens``, ``output_tokens``,
    ``cache_read_input_tokens``, ``cache_creation_input_tokens``). Missing keys default
    to zero.

    Args:
        usage_dictionary: The ``usage`` dictionary from a ``ResultMessage``, or ``None``.
        cost_usd: The ``total_cost_usd`` value from a ``ResultMessage``, or ``None``.

    Returns:
        A populated :class:`TaskUsage`.

    Example:
        >>> usage = usage_from_sdk_usage_dictionary(
        ...     {"input_tokens": 10, "output_tokens": 5}, 0.01)
        >>> usage.output_tokens
        5
    """
    data = usage_dictionary or {}
    return TaskUsage(
        input_tokens=int(data.get("input_tokens", 0) or 0),
        output_tokens=int(data.get("output_tokens", 0) or 0),
        cache_read_input_tokens=int(data.get("cache_read_input_tokens", 0) or 0),
        cache_creation_input_tokens=int(data.get("cache_creation_input_tokens", 0) or 0),
        cost_usd=float(cost_usd or 0.0),
    )


def compute_reset_time(rate_limited_at: datetime, provided_reset_time: datetime | None) -> datetime:
    """Compute when the usage window resets after hitting the limit.

    If the platform provided an explicit reset time, that is used. Otherwise the reset is
    estimated as five hours after the moment the limit was hit, per the plan's rolling
    five-hour window.

    Args:
        rate_limited_at: The moment the usage limit was hit.
        provided_reset_time: An explicit reset time from the platform, if available.

    Returns:
        The datetime at which work may resume.

    Example:
        >>> from datetime import datetime
        >>> compute_reset_time(datetime(2026, 6, 14, 1, 0), None)
        datetime.datetime(2026, 6, 14, 6, 0)
    """
    if provided_reset_time is not None:
        return provided_reset_time
    return rate_limited_at + timedelta(hours=USAGE_RESET_WINDOW_HOURS)


async def wait_for_usage_reset(
    reset_time: datetime,
    deadline: datetime,
    now_provider=datetime.now,
    poll_interval_seconds: float = 60.0,
) -> bool:
    """Sleep until the usage window resets, without sleeping past the schedule deadline.

    Args:
        reset_time: The moment the usage window is expected to reset.
        deadline: The schedule end time; the wait never extends past this.
        now_provider: Callable returning the current time (injectable for testing).
        poll_interval_seconds: How long to sleep between checks.

    Returns:
        ``True`` if the reset time was reached within the schedule window; ``False`` if the
        deadline arrived first (the caller should then stop).

    Example:
        >>> import asyncio
        >>> from datetime import datetime
        >>> # Reset already in the past relative to the provided clock returns True:
        >>> asyncio.run(wait_for_usage_reset(
        ...     reset_time=datetime(2000, 1, 1, 0, 0),
        ...     deadline=datetime(2000, 1, 2, 0, 0),
        ...     now_provider=lambda: datetime(2000, 1, 1, 1, 0)))
        True
    """
    logger = get_logger()
    while True:
        moment = now_provider()
        if moment >= deadline:
            logger.info("Schedule deadline reached while waiting for usage reset; stopping.")
            return False
        if moment >= reset_time:
            logger.info("Usage window has reset; resuming work.")
            return True
        remaining_seconds = (reset_time - moment).total_seconds()
        logger.info(
            "Usage limit reached. Waiting %.0f minute(s) for the 5-hour reset at %s.",
            remaining_seconds / 60.0,
            reset_time,
        )
        await asyncio.sleep(min(poll_interval_seconds, max(1.0, remaining_seconds)))
