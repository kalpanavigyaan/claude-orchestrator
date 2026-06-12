"""Load and validate the YAML configuration into typed data models.

The configuration declares the schedule window, the readable folder scope, per-task
defaults, and optional cumulative limits. This module reads the YAML, validates it with
pydantic, normalizes every scope path for the host, and returns a fully built
:class:`~orchestrator.data_models.Configuration`.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator

from .data_models import Configuration, Defaults, Limits, Schedule, Scope
from .scope import normalize_path

VALID_PERMISSION_MODES = (
    "default",
    "acceptEdits",
    "plan",
    "dontAsk",
    "bypassPermissions",
)

_ACCEPTED_DATETIME_FORMATS = (
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%dT%H:%M:%S",
)


class ConfigurationError(Exception):
    """Raised when a configuration file is missing, malformed, or invalid.

    Example:
        >>> raise ConfigurationError("schedule.start is required")
        Traceback (most recent call last):
        ...
        orchestrator.configuration.ConfigurationError: schedule.start is required
    """


def parse_datetime(value: str | datetime) -> datetime:
    """Parse a configuration datetime string into a ``datetime`` object.

    Accepts ``datetime`` instances unchanged and strings in common date-time formats
    such as ``"2026-06-13 22:00"`` or ``"2026-06-13T22:00:00"``.

    Args:
        value: A datetime instance or a string in an accepted format.

    Returns:
        The parsed ``datetime``.

    Raises:
        ValueError: If the string does not match any accepted format.

    Example:
        >>> parse_datetime("2026-06-13 22:00").hour
        22
    """
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    for datetime_format in _ACCEPTED_DATETIME_FORMATS:
        try:
            return datetime.strptime(text, datetime_format)
        except ValueError:
            continue
    raise ValueError(
        f"Unrecognized datetime '{text}'. Use a format like '2026-06-13 22:00'."
    )


class _ScheduleSchema(BaseModel):
    """Validation schema for the ``schedule`` section of the YAML file."""

    start: str
    end: str
    timezone: str | None = None


class _ScopeSchema(BaseModel):
    """Validation schema for the ``scope`` section of the YAML file."""

    read: list[str] = Field(default_factory=list)


class _DefaultsSchema(BaseModel):
    """Validation schema for the ``defaults`` section of the YAML file."""

    model: str | None = None
    max_turns: int = 200
    permission_mode: str = "default"
    commit_interval_minutes: int = 30
    push: bool = True
    usage_checkpoint_minutes: int = 15

    @field_validator("permission_mode")
    @classmethod
    def _validate_permission_mode(cls, value: str) -> str:
        """Ensure the permission mode is one the Claude Agent SDK accepts."""
        if value not in VALID_PERMISSION_MODES:
            raise ValueError(
                f"permission_mode '{value}' is not valid. "
                f"Choose one of: {', '.join(VALID_PERMISSION_MODES)}."
            )
        return value


class _LimitsSchema(BaseModel):
    """Validation schema for the optional ``limits`` section of the YAML file."""

    max_cost_usd: float | None = None
    max_total_turns: int | None = None


class _ConfigurationSchema(BaseModel):
    """Top-level validation schema for the whole configuration file."""

    schedule: _ScheduleSchema
    scope: _ScopeSchema = Field(default_factory=_ScopeSchema)
    defaults: _DefaultsSchema = Field(default_factory=_DefaultsSchema)
    limits: _LimitsSchema = Field(default_factory=_LimitsSchema)


def load_configuration(configuration_path: str | Path) -> Configuration:
    """Read, validate, and normalize a YAML configuration file.

    Args:
        configuration_path: Path to the YAML configuration file.

    Returns:
        A fully built :class:`~orchestrator.data_models.Configuration` with the schedule
        parsed, scope paths normalized for the host, and defaults/limits applied.

    Raises:
        ConfigurationError: If the file is missing, is not valid YAML, fails schema
            validation, or has an end time at or before the start time.

    Example:
        >>> # Given a valid config/orchestrator.yaml on disk:
        >>> # configuration = load_configuration("config/orchestrator.yaml")
        >>> # configuration.schedule.end_time > configuration.schedule.start_time
        >>> True
        True
    """
    path = Path(configuration_path)
    if not path.exists():
        raise ConfigurationError(f"Configuration file not found: {path}")

    try:
        raw_text = path.read_text(encoding="utf-8")
        raw_data = yaml.safe_load(raw_text) or {}
    except yaml.YAMLError as error:
        raise ConfigurationError(f"Configuration file is not valid YAML: {error}") from error

    try:
        validated = _ConfigurationSchema.model_validate(raw_data)
    except ValidationError as error:
        raise ConfigurationError(f"Configuration is invalid:\n{error}") from error

    try:
        start_time = parse_datetime(validated.schedule.start)
        end_time = parse_datetime(validated.schedule.end)
    except ValueError as error:
        raise ConfigurationError(str(error)) from error

    if end_time <= start_time:
        raise ConfigurationError(
            f"schedule.end ({end_time}) must be after schedule.start ({start_time})."
        )

    schedule = Schedule(
        start_time=start_time,
        end_time=end_time,
        timezone_name=validated.schedule.timezone,
    )
    scope = Scope(
        readable_roots=[normalize_path(entry) for entry in validated.scope.read]
    )
    defaults = Defaults(
        model=validated.defaults.model,
        maximum_turns=validated.defaults.max_turns,
        permission_mode=validated.defaults.permission_mode,
        commit_interval_minutes=validated.defaults.commit_interval_minutes,
        push=validated.defaults.push,
        usage_checkpoint_minutes=validated.defaults.usage_checkpoint_minutes,
    )
    limits = Limits(
        maximum_cost_usd=validated.limits.max_cost_usd,
        maximum_total_turns=validated.limits.max_total_turns,
    )
    return Configuration(schedule=schedule, scope=scope, defaults=defaults, limits=limits)
