"""Tests for loading and validating the YAML configuration."""

import pytest

from orchestrator.configuration import (
    ConfigurationError,
    load_configuration,
    parse_datetime,
)

_VALID_CONFIGURATION_TEXT = """\
schedule:
  start: "2026-06-13 22:00"
  end: "2026-06-14 06:00"
  timezone: "America/New_York"
scope:
  read:
    - "E:/GitHub"
defaults:
  max_turns: 150
  permission_mode: "default"
limits:
  max_cost_usd: 5.0
"""


def _write_configuration(tmp_path, text):
    """Write configuration text to a temporary file and return its path.

    Example:
        >>> # path = _write_configuration(tmp_path, "schedule: ...")
    """
    path = tmp_path / "orchestrator.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_parse_datetime_accepts_space_separated_format():
    """parse_datetime parses the 'YYYY-MM-DD HH:MM' format."""
    parsed = parse_datetime("2026-06-13 22:00")
    assert parsed.year == 2026 and parsed.hour == 22


def test_load_valid_configuration(tmp_path):
    """A well-formed configuration loads into typed models with normalized scope."""
    path = _write_configuration(tmp_path, _VALID_CONFIGURATION_TEXT)
    configuration = load_configuration(path)
    assert configuration.defaults.maximum_turns == 150
    assert configuration.limits.maximum_cost_usd == 5.0
    assert len(configuration.scope.readable_roots) == 1


def test_invalid_permission_mode_is_rejected(tmp_path):
    """An unknown permission_mode value raises ConfigurationError."""
    text = _VALID_CONFIGURATION_TEXT.replace('"default"', '"chaos"')
    path = _write_configuration(tmp_path, text)
    with pytest.raises(ConfigurationError):
        load_configuration(path)


def test_end_before_start_is_rejected(tmp_path):
    """An end time at or before the start time raises ConfigurationError."""
    text = _VALID_CONFIGURATION_TEXT.replace("2026-06-14 06:00", "2026-06-13 21:00")
    path = _write_configuration(tmp_path, text)
    with pytest.raises(ConfigurationError):
        load_configuration(path)


def test_missing_file_is_rejected(tmp_path):
    """A missing configuration file raises ConfigurationError."""
    with pytest.raises(ConfigurationError):
        load_configuration(tmp_path / "does_not_exist.yaml")
