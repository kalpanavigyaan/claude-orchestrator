"""Pytest configuration that makes the ``src`` package importable during tests.

This file lets ``uv run pytest`` discover the :mod:`orchestrator` package without
installing it and without relying on pyproject.toml settings, by prepending the
``src`` directory to ``sys.path`` before any test module is collected.
"""

import sys
from pathlib import Path

SOURCE_DIRECTORY = Path(__file__).resolve().parent / "src"
if str(SOURCE_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SOURCE_DIRECTORY))
