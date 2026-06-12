"""Configure console and file logging for the orchestrator.

A single rich-formatted logger writes human-readable progress to the console and a plain
copy to a timestamped log file under ``logs/`` so that unattended runs can be reviewed
afterwards.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

from rich.logging import RichHandler

LOGGER_NAME = "orchestrator"


def configure_logging(log_directory: str | Path = "logs", now: datetime | None = None) -> logging.Logger:
    """Configure and return the application logger.

    Sets up two handlers: a rich console handler for readable output and a file handler
    that writes a timestamped log file so unattended runs leave an audit trail.

    Args:
        log_directory: Directory in which to create the log file. Created if missing.
        now: The current time used to name the log file. Defaults to the actual now.

    Returns:
        The configured ``logging.Logger`` named ``"orchestrator"``.

    Example:
        >>> logger = configure_logging(log_directory="logs")
        >>> logger.name
        'orchestrator'
    """
    timestamp = (now or datetime.now()).strftime("%Y%m%d_%H%M%S")
    directory = Path(log_directory)
    directory.mkdir(parents=True, exist_ok=True)
    log_file_path = directory / f"orchestrator_{timestamp}.log"

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.propagate = False

    console_handler = RichHandler(rich_tracebacks=True, show_path=False)
    console_handler.setLevel(logging.INFO)
    logger.addHandler(console_handler)

    file_handler = logging.FileHandler(log_file_path, encoding="utf-8")
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    )
    logger.addHandler(file_handler)

    logger.info("Logging to %s", log_file_path)
    return logger


def get_logger() -> logging.Logger:
    """Return the application logger, configuring a default console logger if needed.

    Returns:
        The ``logging.Logger`` named ``"orchestrator"``.

    Example:
        >>> get_logger().name
        'orchestrator'
    """
    logger = logging.getLogger(LOGGER_NAME)
    if not logger.handlers:
        logger.setLevel(logging.INFO)
        logger.addHandler(RichHandler(rich_tracebacks=True, show_path=False))
    return logger
