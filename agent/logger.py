"""Logging setup for the Tally Cloud Sync Agent.

Provides :func:`get_logger`, which returns a logger writing to a rotating file
(``logs/agent.log``, 1 MB x 5 backups) and to the console. The ``logs/``
directory is created on first use. Format includes a timestamp, level and
logger name so multi-module output stays readable.
"""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler


# Where rotating log files live (relative to the agent working directory).
_LOG_DIR = "logs"
_LOG_FILE = os.path.join(_LOG_DIR, "agent.log")

# Rotation policy: 1 MB per file, keep 5 old files.
_MAX_BYTES = 1 * 1024 * 1024
_BACKUP_COUNT = 5

_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def get_logger(name: str, level: str | int = "INFO") -> logging.Logger:
    """Return a configured :class:`logging.Logger` for ``name``.

    Attaches a :class:`RotatingFileHandler` (``logs/agent.log``) and a console
    handler exactly once per logger, so repeated calls do not duplicate output.
    ``level`` may be a level name (``"INFO"``) or numeric value; an unknown
    name falls back to ``INFO``.
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

        # File handler — never let a missing logs/ dir crash the agent.
        try:
            os.makedirs(_LOG_DIR, exist_ok=True)
            file_handler = RotatingFileHandler(
                _LOG_FILE,
                maxBytes=_MAX_BYTES,
                backupCount=_BACKUP_COUNT,
                encoding="utf-8",
            )
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
