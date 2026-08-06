"""Agent-side data backup: copy Tally's data folder to a customer-chosen
destination on the SAME machine.

Tally holds its data files open while running, so some files may be
unreadable at copy time. A backup that quietly missed files is worse than no
backup at all, because the customer will rely on it — so every unreadable
file is both counted AND named, and a run that skipped even one file is
reported as ``partial``, never ``success``. The Tally data itself is only
ever READ here, never modified.

Each run copies into its own timestamped folder under the destination
(``<destination>/tallysaas-backup-YYYYMMDD-HHMMSS/``) so a run is either
fully there or not there at all, and retention (deleting old copies) is just
"delete old timestamped folders" — applied only AFTER the new copy has
finished writing, so an old backup is never lost while a new one is still in
progress or failed outright.

Public interface (consumed by :mod:`sync_agent`):
    run_backup(data_path, destination, keep_copies, logger) -> dict
    copies_to_delete(existing, keep) -> list
    due_now(settings, last_run_at, now) -> bool
"""

from __future__ import annotations

import datetime
import os
import shutil
from typing import Any, Optional


# Prefix for each run's timestamped folder under the destination.
BACKUP_FOLDER_PREFIX = "tallysaas-backup-"
_TIMESTAMP_FMT = "%Y%m%d-%H%M%S"

_DEFAULT_RUN_AT = "02:00:00"


# --------------------------------------------------------------------------- #
# Retention — MUST mirror api/Controllers/Tenant/BackupController.js
# copiesToDelete() exactly, so the cloud's stated rule and the agent's actual
# behaviour can never disagree.
# --------------------------------------------------------------------------- #
def copies_to_delete(existing: list, keep: Any) -> list:
    """Given existing copies oldest-first, return the ones to delete.

    Never deletes down to zero: ``keep <= 0`` is refused outright (a backup
    that erases everything is not a backup), so nothing is returned to
    delete in that case either.
    """
    lst = list(existing) if existing else []
    try:
        k = int(keep)
    except (TypeError, ValueError):
        return []
    if k <= 0:
        return []
    if len(lst) <= k:
        return []
    return lst[: len(lst) - k]


# --------------------------------------------------------------------------- #
# Schedule
# --------------------------------------------------------------------------- #
def _parse_run_at(run_at: Optional[str]) -> datetime.time:
    """Parse 'HH:MM:SS' (or 'HH:MM') into a time; falls back to the default
    on anything unparseable so a bad settings value never crashes the loop."""
    s = str(run_at or "").strip()
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.datetime.strptime(s, fmt).time()
        except ValueError:
            continue
    return datetime.datetime.strptime(_DEFAULT_RUN_AT, "%H:%M:%S").time()


def due_now(settings: dict, last_run_at: Optional[datetime.datetime],
            now: datetime.datetime) -> bool:
    """Decide whether a scheduled backup should run THIS cycle.

    ``settings`` is the dict returned by ``GET /agent/backup-settings``
    (``enabled``, ``frequency``, ``run_at``, ...). Disabled settings are
    never due. Otherwise a run is due once ``now`` has reached the scheduled
    time of day AND enough time has passed since ``last_run_at``:
    at least a day for 'daily', at least 7 days for 'weekly'. ``last_run_at
    = None`` (never run before) is due as soon as the scheduled time has
    been reached today.
    """
    if not isinstance(settings, dict) or not settings.get("enabled"):
        return False

    run_at = _parse_run_at(settings.get("run_at"))
    if now.time() < run_at:
        return False

    if last_run_at is None:
        return True

    frequency = str(settings.get("frequency") or "daily").strip().lower()
    if frequency == "weekly":
        return (now - last_run_at) >= datetime.timedelta(days=7)
    # daily (default): due once a new calendar day has begun, past run_at.
    return now.date() > last_run_at.date()


# --------------------------------------------------------------------------- #
# The backup itself
# --------------------------------------------------------------------------- #
def _new_result(destination: Optional[str] = None) -> dict:
    return {
        "status": "failed",
        "files_copied": 0,
        "files_skipped": 0,
        "bytes_copied": 0,
        "skipped": [],
        "destination": destination,
        "error": None,
    }


def run_backup(data_path: str, destination: str, keep_copies: Any, logger) -> dict:
    """Copy every file under ``data_path`` into a new timestamped folder
    under ``destination``, then apply retention.

    Returns a result dict:
        { status: 'success'|'partial'|'failed',
          files_copied, files_skipped, bytes_copied: int,
          skipped: [str, ...],   # relative paths that could not be read
          destination: str|None, # the timestamped folder actually written
          error: str|None }

    Never raises: every failure mode is turned into ``status: 'failed'``
    with a human-readable ``error`` so the caller can always report SOMETHING
    to the cloud instead of losing the run entirely.
    """
    result = _new_result()

    data_path = str(data_path or "")
    if not data_path or not os.path.isdir(data_path):
        result["error"] = f"Tally data folder not found: {data_path or '(empty)'}"
        logger.error("backup: %s", result["error"])
        return result

    destination = str(destination or "")
    if not destination:
        result["error"] = "No backup destination configured."
        logger.error("backup: %s", result["error"])
        return result

    try:
        os.makedirs(destination, exist_ok=True)
    except OSError as exc:
        result["error"] = f"Could not create/access destination '{destination}': {exc}"
        logger.error("backup: %s", result["error"])
        return result

    if not os.path.isdir(destination):
        result["error"] = f"Destination is not a directory: {destination}"
        logger.error("backup: %s", result["error"])
        return result

    timestamp = datetime.datetime.now().strftime(_TIMESTAMP_FMT)
    target = os.path.join(destination, f"{BACKUP_FOLDER_PREFIX}{timestamp}")
    try:
        os.makedirs(target, exist_ok=False)
    except OSError as exc:
        result["error"] = f"Could not create backup folder '{target}': {exc}"
        logger.error("backup: %s", result["error"])
        return result

    result["destination"] = target

    files_found = 0
    for root, _dirs, files in os.walk(data_path):
        for name in files:
            files_found += 1
            src = os.path.join(root, name)
            rel = os.path.relpath(src, data_path)
            dst = os.path.join(target, rel)
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
            except (PermissionError, OSError) as exc:
                logger.warning("backup: could not read '%s': %s", rel, exc)
                result["skipped"].append(rel)
                result["files_skipped"] += 1
                continue
            try:
                size = os.path.getsize(src)
            except OSError:
                size = 0
            result["files_copied"] += 1
            result["bytes_copied"] += size

    if files_found == 0:
        # Nothing to copy is not a failure — an empty data folder still
        # produces a (empty) timestamped backup.
        result["status"] = "success"
    elif result["files_copied"] == 0:
        result["status"] = "failed"
        result["error"] = "No files could be copied (all were unreadable)."
        logger.error("backup: %s", result["error"])
    elif result["files_skipped"] > 0:
        result["status"] = "partial"
        result["error"] = (
            f"{result['files_skipped']} file(s) could not be read and were skipped."
        )
        logger.warning("backup: %s", result["error"])
    else:
        result["status"] = "success"

    # Retention: apply ONLY after the new copy is fully on disk, so an old
    # backup is never removed while the new one is incomplete or failed.
    if result["status"] in ("success", "partial"):
        _apply_retention(destination, keep_copies, logger)

    return result


def _apply_retention(destination: str, keep_copies: Any, logger) -> None:
    """Delete old timestamped backup folders beyond ``keep_copies``.

    Best-effort: a failure to remove one old folder is logged and does not
    affect the run's reported status (the new backup is already safe).
    """
    try:
        entries = sorted(
            d for d in os.listdir(destination)
            if d.startswith(BACKUP_FOLDER_PREFIX)
            and os.path.isdir(os.path.join(destination, d))
        )
    except OSError as exc:
        logger.warning("backup: could not list destination for retention: %s", exc)
        return

    for name in copies_to_delete(entries, keep_copies):
        path = os.path.join(destination, name)
        try:
            shutil.rmtree(path)
            logger.info("backup: removed old copy '%s' (retention).", name)
        except OSError as exc:
            logger.warning("backup: could not remove old copy '%s': %s", name, exc)
