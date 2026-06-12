"""Command-line entry point for the claude-orchestrator application.

This thin launcher adds the ``src`` directory to the import path and then hands
control to the Typer application defined in
:mod:`orchestrator.command_line_interface`. It is invoked through uv so that the
managed virtual environment (and therefore every dependency) is available,
without requiring the package to be installed or depending on pyproject.toml.

Example:
    Show the available commands::

        uv run python scripts/orchestrator.py --help

    Validate a configuration file and the discovered instruction files::

        uv run python scripts/orchestrator.py validate --config config/orchestrator.yaml

    Process every task in an instructions subfolder right now (skip the wait)::

        uv run python scripts/orchestrator.py run instructions/example --now
"""

import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIRECTORY = REPOSITORY_ROOT / "src"
if str(SOURCE_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SOURCE_DIRECTORY))

from orchestrator.command_line_interface import app  # noqa: E402  (path set above)

if __name__ == "__main__":
    app()
