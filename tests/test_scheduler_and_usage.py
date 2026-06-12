"""Tests for the schedule window logic and the usage tracker / reset behavior."""

import asyncio
from datetime import datetime

from orchestrator.data_models import Limits, Schedule, Task, TaskRunResult, TaskUsage
from orchestrator.scheduler import (
    is_within_window,
    seconds_until_end,
    wait_until_start,
)
from orchestrator.usage import (
    UsageTracker,
    compute_reset_time,
    usage_from_sdk_usage_dictionary,
    wait_for_usage_reset,
)
from pathlib import Path

_SCHEDULE = Schedule(
    start_time=datetime(2026, 6, 13, 22, 0),
    end_time=datetime(2026, 6, 14, 6, 0),
)


def test_is_within_window_true_inside():
    """is_within_window is True for a moment inside the window."""
    assert is_within_window(_SCHEDULE, now=datetime(2026, 6, 14, 1, 0))


def test_is_within_window_false_after_end():
    """is_within_window is False for a moment after the end time."""
    assert not is_within_window(_SCHEDULE, now=datetime(2026, 6, 14, 7, 0))


def test_seconds_until_end_counts_down():
    """seconds_until_end returns the remaining seconds before the end time."""
    assert seconds_until_end(_SCHEDULE, now=datetime(2026, 6, 14, 5, 0)) == 3600.0


def test_wait_until_start_returns_immediately_when_past():
    """wait_until_start returns immediately when the start time has already passed."""
    past_schedule = Schedule(datetime(2000, 1, 1, 0, 0), datetime(2000, 1, 2, 0, 0))
    asyncio.run(wait_until_start(past_schedule))


def test_usage_tracker_accumulates_and_enforces_limits():
    """The usage tracker accumulates usage and detects when a cost cap is reached."""
    tracker = UsageTracker()
    task = Task(Path("a.md"), Path("E:/GitHub/app"), "new", "body")
    result = TaskRunResult(
        task=task,
        succeeded=True,
        number_of_turns=3,
        usage=TaskUsage(input_tokens=100, output_tokens=50, cost_usd=6.0),
    )
    tracker.record_task_result(result)
    assert tracker.total_input_tokens == 100
    assert tracker.has_exceeded_limits(Limits(maximum_cost_usd=5.0))
    assert not tracker.has_exceeded_limits(Limits(maximum_cost_usd=None))


def test_compute_reset_time_defaults_to_five_hours():
    """compute_reset_time adds five hours when no explicit reset time is provided."""
    reset = compute_reset_time(datetime(2026, 6, 14, 1, 0), provided_reset_time=None)
    assert reset == datetime(2026, 6, 14, 6, 0)


def test_usage_from_sdk_usage_dictionary_defaults_missing_keys():
    """usage_from_sdk_usage_dictionary defaults missing token keys to zero."""
    usage = usage_from_sdk_usage_dictionary({"input_tokens": 10}, 0.02)
    assert usage.input_tokens == 10
    assert usage.output_tokens == 0
    assert usage.cost_usd == 0.02


def test_wait_for_usage_reset_returns_false_past_deadline():
    """wait_for_usage_reset returns False when the deadline has already passed."""
    resumed = asyncio.run(
        wait_for_usage_reset(
            reset_time=datetime(2026, 6, 14, 6, 0),
            deadline=datetime(2026, 6, 14, 5, 0),
            now_provider=lambda: datetime(2026, 6, 14, 5, 30),
        )
    )
    assert resumed is False
