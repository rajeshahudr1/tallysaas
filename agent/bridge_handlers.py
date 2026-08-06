"""What the served UI can ask this machine to do.

Everything the agent window shows or changes that no cloud endpoint could
answer: whether this PC is signed in, what the current cycle is doing, the tail
of the log, the Tally path, "sync now", "sign out".

THE SURFACE IS THE SECURITY BOUNDARY. `local_bridge` proves a caller is our own
page on loopback with the right per-run token; from there, whatever is listed in
:func:`build` is reachable. So this is a small, explicit dictionary rather than
anything that dispatches by name into an object — one accidental public method
should never become a remote capability.

Each handler takes the decoded JSON body and returns something serialisable.
Raising is fine and preferred over returning an error shape: the bridge turns an
exception into a 500 carrying the message, and the UI shows it. Silently
returning "ok" on failure is the outcome worth avoiding.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Optional


# The log tail the UI shows. Enough to see what the current cycle did; small
# enough that polling it every couple of seconds is free.
LOG_TAIL_BYTES = 16 * 1024

# What the dashboard lists, in the order the agent actually syncs them, so the
# rows fill top-to-bottom as a cycle progresses. Labels are the customer's words
# ("Ledgers"), not the wire keys ("tally_ledgers").
MODULE_LABELS = (
    ("groups", "Groups"),
    ("ledgers", "Ledgers"),
    ("stock_items", "Stock items"),
    ("masters", "Other masters"),
    ("vouchers", "Vouchers"),
    ("reports", "Reports"),
    ("outstanding", "Outstanding"),
)


def _tail(path: str, limit: int = LOG_TAIL_BYTES) -> str:
    """The last ``limit`` bytes of a text file, or '' if unreadable.

    Seeks rather than reading the whole file: an agent that has been running for
    months has a log far larger than the few KB the window shows, and reading it
    on every poll would be absurd.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > limit:
                fh.seek(size - limit)
                fh.readline()          # drop the partial first line
            data = fh.read()
        return data.decode("utf-8", "replace")
    except OSError:
        return ""


def build(cfg_loader: Callable[[], Any],
          state: Any,
          logger,
          log_path: Optional[str] = None,
          on_sync_now: Optional[Callable[[], None]] = None,
          on_sign_out: Optional[Callable[[], None]] = None) -> dict[str, Callable[[dict], Any]]:
    """Assemble the bridge API.

    ``cfg_loader`` returns a fresh Config — read each time rather than captured
    once, so a settings change made here is what the next call sees.

    ``state`` is the live sync state object the sync loop updates (see
    :class:`SyncState`).
    """

    def machine(_body: dict) -> dict:
        """Identity + whether this PC is signed in. The UI's first call.

        The agent is the authority on 'signed in', not the page: a sign-out done
        elsewhere must be visible the next time the window opens, and a browser
        that remembered its own answer would contradict it.
        """
        cfg = cfg_loader()
        from config import machine_fingerprint
        import sync_agent
        return {
            "machine_id": cfg.machine_id or machine_fingerprint(),
            "machine_name": sync_agent._machine_name(),
            "agent_version": cfg.agent_version,
            "signed_in": bool(cfg.get_token()),
        }

    def status(_body: dict) -> dict:
        """The current cycle, plus the log tail the UI prints."""
        snapshot = state.snapshot()
        snapshot["log"] = _tail(log_path) if log_path else ""
        return snapshot

    def sync_now(_body: dict) -> dict:
        if on_sync_now is None:
            raise RuntimeError("This build cannot start a sync from the window.")
        on_sync_now()
        return {"started": True}

    def save_token(body: dict) -> dict:
        """Persist the token the page received from /agent/verify.

        The token is written by the AGENT, encrypted and machine-bound, rather
        than kept in the page. Browser storage would outlive a sign-out and be
        readable by anything sharing the origin.
        """
        token = str(body.get("agent_token") or "").strip()
        if not token:
            raise ValueError("No token was supplied.")
        cfg = cfg_loader()
        cfg.set_token(token)
        logger.info("Signed in from the window (agent_id=%s).", body.get("agent_id"))
        return {"signed_in": True}

    def sign_out(_body: dict) -> dict:
        cfg = cfg_loader()
        cfg.clear_token()
        if on_sign_out is not None:
            on_sign_out()
        logger.info("Signed out from the window.")
        return {"signed_in": False}

    def get_settings(_body: dict) -> dict:
        cfg = cfg_loader()
        # Only the settings the window actually offers. The API base URL is
        # baked into the exe and deliberately not exposed: a customer pointing
        # the agent at another server is not a feature.
        return {
            "tally_url": cfg.tally_url,
            "sync_interval": cfg.sync_interval,
            "auto_update": bool(cfg.auto_update),
        }

    def save_settings(body: dict) -> dict:
        cfg = cfg_loader()
        if "tally_url" in body:
            cfg.tally_url = str(body.get("tally_url") or "").strip() or cfg.tally_url
        if "sync_interval" in body:
            try:
                interval = int(body.get("sync_interval") or 0)
            except (TypeError, ValueError):
                raise ValueError("Sync interval must be a number of seconds.")
            # A 1-second interval would hammer Tally continuously and is far
            # more likely a typo than an intention.
            if interval < 10:
                raise ValueError("Sync interval must be at least 10 seconds.")
            cfg.sync_interval = interval
        if "auto_update" in body:
            cfg.auto_update = bool(body.get("auto_update"))
        cfg.save()
        logger.info("Settings changed from the window.")
        return {"saved": True}

    return {
        "machine": machine,
        "status": status,
        "sync-now": sync_now,
        "save-token": save_token,
        "sign-out": sign_out,
        "get-settings": get_settings,
        "save-settings": save_settings,
    }


class SyncState:
    """What the sync loop is doing, in the shape the window renders.

    Written by the sync thread, read by bridge handlers on the HTTP thread, so
    every access is under a lock. Snapshots are copies: handing out the live
    dict would let a caller observe it mid-update and print a half-written
    cycle.
    """

    def __init__(self) -> None:
        import threading
        self._lock = threading.Lock()
        self._counts: dict[str, Optional[int]] = {}
        self._states: dict[str, str] = {}
        self.state = "idle"          # idle | syncing | failed
        self.phase = "idle"
        self.percent = 0.0
        self.company = ""
        self.last_sync = ""

    def begin(self, company: str = "") -> None:
        with self._lock:
            self.state = "syncing"
            self.company = company or self.company
            self.percent = 0.0
            self._counts.clear()
            self._states.clear()

    def step(self, key: str, *, count: Optional[int] = None,
             state: str = "synced", percent: Optional[float] = None) -> None:
        """Record one module's outcome and, optionally, overall progress."""
        with self._lock:
            self._counts[key] = count
            self._states[key] = state
            if percent is not None:
                self.percent = max(0.0, min(100.0, float(percent)))
            self.phase = key

    def finish(self, when: str, ok: bool = True) -> None:
        with self._lock:
            self.state = "idle" if ok else "failed"
            self.phase = "idle" if ok else "failed"
            self.percent = 100.0 if ok else self.percent
            self.last_sync = when

    def snapshot(self) -> dict:
        with self._lock:
            modules = []
            for key, label in MODULE_LABELS:
                modules.append({
                    "key": key,
                    "label": label,
                    "count": self._counts.get(key),
                    # A module the cycle has not reached yet reads as 'pending',
                    # not 'synced' — the difference is the whole point of the
                    # progress list.
                    "state": self._states.get(key, "pending"),
                })
            total = sum(c for c in self._counts.values() if isinstance(c, int))
            return {
                "state": self.state,
                "phase": self.phase,
                "percent": round(self.percent, 1),
                "company": self.company,
                "last_sync": self.last_sync,
                "modules": modules,
                "total": total,
            }
