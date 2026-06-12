"""Wait for the scheduled start time and guard the scheduled end time.

The orchestrator runs inside a fixed window defined by the configuration. This module
sleeps until the start time, reports whether the current moment is inside the window, and
computes how much time remains before the end deadline. The end time is a hard stop: once
it passes, no new task is started and any in-progress checks stop the loop cleanly.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

from .data_models import Schedule
from .logging_setup import get_logger


def current_time(schedule: Schedule) -> datetime:
    """Return the current naive local time in the schedule's timezone.

    The schedule's start and end times are stored as naive datetimes (no offset). To
    compare consistently, the current time is taken in the schedule's timezone (or the
    system local timezone when none is configured) and returned as a naive datetime.

    Args:
        schedule: The schedule whose timezone determines the clock used.

    Returns:
        The current time as a naive ``datetime`` comparable to the schedule's times.

    Example:
        >>> from datetime import datetime
        >>> schedule = Schedule(datetime(2026, 1, 1, 0, 0), datetime(2030, 1, 1, 0, 0))
        >>> isinstance(current_time(schedule), datetime)
        True
    """
    if schedule.timezone_name:
        zone = ZoneInfo(schedule.timezone_name)
        return datetime.now(zone).replace(tzinfo=None)
    return datetime.now()


def is_within_window(schedule: Schedule, now: datetime | None = None) -> bool:
    """Return whether the current moment is inside the schedule window.

    Args:
        schedule: The schedule defining the start and end times.
        now: The moment to test. Defaults to the current time in the schedule timezone.

    Returns:
        ``True`` if ``start_time <= now < end_time``, otherwise ``False``.

    Example:
        >>> from datetime import datetime
        >>> schedule = Schedule(datetime(2026, 6, 13, 22, 0), datetime(2026, 6, 14, 6, 0))
        >>> is_within_window(schedule, now=datetime(2026, 6, 14, 1, 0))
        True
        >>> is_within_window(schedule, now=datetime(2026, 6, 14, 7, 0))
        False
    """
    moment = now if now is not None else current_time(schedule)
    return schedule.start_time <= moment < schedule.end_time


def seconds_until_end(schedule: Schedule, now: datetime | None = None) -> float:
    """Return the number of seconds remaining before the schedule end time.

    Args:
        schedule: The schedule defining the end time.
        now: The reference moment. Defaults to the current time in the schedule timezone.

    Returns:
        Seconds until the end time. Zero if the end time has already passed.

    Example:
        >>> from datetime import datetime
        >>> schedule = Schedule(datetime(2026, 6, 13, 22, 0), datetime(2026, 6, 14, 6, 0))
        >>> seconds_until_end(schedule, now=datetime(2026, 6, 14, 5, 0))
        3600.0
    """
    moment = now if now is not None else current_time(schedule)
    remaining = (schedule.end_time - moment).total_seconds()
    return max(0.0, remaining)


async def wait_until_start(schedule: Schedule, poll_interval_seconds: float = 30.0) -> None:
    """Sleep until the schedule's start time is reached.

    If the start time has already passed, returns immediately. Otherwise sleeps in short
    intervals so the wait can be observed and interrupted, logging progress periodically.

    Args:
        schedule: The schedule defining the start time.
        poll_interval_seconds: How long to sleep between checks.

    Returns:
        ``None`` once the start time has been reached.

    Example:
        >>> import asyncio
        >>> from datetime import datetime
        >>> past = Schedule(datetime(2000, 1, 1, 0, 0), datetime(2000, 1, 2, 0, 0))
        >>> asyncio.run(wait_until_start(past))  # returns immediately; start already passed
    """
    logger = get_logger()
    while True:
        moment = current_time(schedule)
        if moment >= schedule.start_time:
            return
        remaining_seconds = (schedule.start_time - moment).total_seconds()
        logger.info(
            "Waiting %.0f minute(s) until scheduled start at %s",
            remaining_seconds / 60.0,
            schedule.start_time,
        )
        await asyncio.sleep(min(poll_interval_seconds, max(1.0, remaining_seconds)))
