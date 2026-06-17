"""Logging setup for the Tally Cloud Sync Agent.

Provides :func:`get_logger`, which returns a logger writing to a DAILY-rotating
file in ``logs/`` and to the console. A NEW file is started every day: the live
file is ``logs/agent.log`` and each completed day is kept as
``logs/agent-YYYY-MM-DD.log`` (last 60 days). The ``logs/`` directory is created
on first use. Format includes a timestamp, level and logger name.
"""

from __future__ import annotations

import logging
import os
from logging.handlers import TimedRotatingFileHandler


# Where the daily log files live (relative to the agent working directory).
_LOG_DIR = "logs"
_LOG_FILE = os.path.join(_LOG_DIR, "agent.log")

# Rotation policy: roll at midnight (one file per day); keep ~60 days.
_BACKUP_DAYS = 60

_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def _dated_namer(default_name: str) -> str:
    """Rename a rotated file from ``logs/agent.log.2026-06-17`` to
    ``logs/agent-2026-06-17.log`` so each day reads as a clean dated file."""
    folder = os.path.dirname(default_name)
    datepart = os.path.basename(default_name).split(".")[-1]
    return os.path.join(folder, "agent-" + datepart + ".log")


def get_logger(name: str, level: str | int = "INFO") -> logging.Logger:
    """Return a configured :class:`logging.Logger` for ``name``.

    Attaches a :class:`TimedRotatingFileHandler` that rolls over at midnight
    (a separate dated file per day) and a console handler, exactly once per
    logger so repeated calls do not duplicate output. ``level`` may be a level
    name (``"INFO"``) or numeric value; an unknown name falls back to ``INFO``.
    """
    logger = logging.getLogger(name)

    # Resolve the requested level (string name or int) defensively.
    resolved = logging.INFO
    if isinstance(level, int):
        resolved = level
    elif isinstance(level, str):
        candidate = logging.getLevelName(level.strip().upper())
        if isinstance(candidate, int):
            resolved = candidate
    logger.setLevel(resolved)

    # Only wire up handlers the first time this logger is requested.
    if not logger.handlers:
        formatter = logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT)

        # Daily file handler — never let a missing logs/ dir crash the agent.
        try:
            os.makedirs(_LOG_DIR, exist_ok=True)
            file_handler = TimedRotatingFileHandler(
                _LOG_FILE,
                when="midnight",
                interval=1,
                backupCount=_BACKUP_DAYS,
                encoding="utf-8",
            )
            file_handler.suffix = "%Y-%m-%d"          # rotated date stamp
            file_handler.namer = _dated_namer          # -> agent-YYYY-MM-DD.log
            file_handler.setFormatter(formatter)
            file_handler.setLevel(resolved)
            logger.addHandler(file_handler)
        except OSError:
            # File logging unavailable (e.g. read-only dir); console still works.
            pass

        # Console handler.
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        console_handler.setLevel(resolved)
        logger.addHandler(console_handler)

        # Don't double-emit through the root logger.
        logger.propagate = False

    return logger
