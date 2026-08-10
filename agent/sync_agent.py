"""Entry point for the Teloora Agent.

Runs on the customer's Windows PC alongside Tally Prime. It activates the
machine against the cloud (license key, machine-bound), heartbeats on an
interval, and - once the cloud sync-queue endpoints land in a later phase -
pulls pending records, pushes them into Tally over XML (``localhost:9000``),
and reports results back.

Design rules (Phase 4): nothing here may hard-crash the main loop. Every
external call (cloud HTTP via :class:`ApiClient`, Tally HTTP via
:class:`TallyConnector`) is wrapped; failures are logged and retried on the
next cycle, never fatal.

CLI
---
    python sync_agent.py                 # run the continuous sync loop
    python sync_agent.py --activate KEY  # (re)activate with a license key, then run
    python sync_agent.py --once          # run exactly one cycle and exit
    python sync_agent.py --status        # print config + token + Tally state, exit
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import time
from typing import Any, Optional

from config import Config, machine_fingerprint
from constants import BRAND_NAME_AGENT, PUBLISHER_CN, PUBLISHER_THUMBPRINT
from logger import get_logger
from api_client import ApiClient, ActivationError, AgentError
import tally_connector
from tally_connector import TallyConnector, TallySkipped, TallyUnavailable
import tally_control
import backup_runner


# Exit codes (POSIX-ish): 0 ok, non-zero = startup/activation failure.
_EXIT_OK = 0
_EXIT_ACTIVATION = 2
_EXIT_CONFIG = 3

# How many consecutive failed cycles before we widen the log to a warning.
_FAILED_RETRY_WARN_THRESHOLD = 3

# How many times the interactive activation prompt re-asks on a bad key.
_MAX_ACTIVATION_ATTEMPTS = 5

# App banner shown at startup (stdout only). Brand from constants.py.
_APP_NAME = BRAND_NAME_AGENT

# Module-level "show the operator everything" switch. True for --once and for
# the FIRST loop cycle (so the operator can watch the whole process happen);
# the loop drops it to False afterwards so subsequent cycles aren't spammy.
# When True, the agent ALSO echoes step-by-step progress to stdout - this is
# entirely separate from the file logger, which keeps logging as before.
VERBOSE = False


# --------------------------------------------------------------------------- #
# Console echo (stdout, separate from the file logger)
# --------------------------------------------------------------------------- #
def echo(msg: str = "") -> None:
    """Print a line to stdout for the operator to watch the process happen.

    Deliberately separate from the file logger (``logger.*``): the logger keeps
    its detailed, timestamped record in ``logs/agent.log`` exactly as before,
    while ``echo`` shows clear, ASCII-only progress on the console. ASCII markers
    ([OK]/[..]/[!]/[x], "STEP n/4") are used instead of emoji so output renders
    in a plain Windows console. ``flush=True`` so progress appears immediately.
    """
    try:
        print(msg, flush=True)
    except Exception:
        # The console must never be the thing that crashes the agent.
        pass


# --------------------------------------------------------------------------- #
# argv parsing (tiny, dependency-free)
# --------------------------------------------------------------------------- #
class _Args:
    """Parsed command-line options."""

    def __init__(self) -> None:
        # --signin forces a fresh sign-in even when a token exists (used to
        # move a machine to a different account). --activate is kept as an alias
        # so existing shortcuts and scheduled tasks do not break.
        self.activate: bool = False
        self.once: bool = False
        self.status: bool = False


def _parse_args(argv: list[str]) -> _Args:
    """Parse the small fixed set of flags this agent understands.

    Unknown flags are ignored rather than fatal so a stray argument from a
    scheduler / shortcut never stops the agent from running.
    """
    args = _Args()
    i = 0
    while i < len(argv):
        token = argv[i]
        if token in ("--signin", "--activate", "-a"):
            args.activate = True
            # A value used to follow here (the licence key). Licence keys are
            # gone, so anything trailing is skipped rather than misread as a
            # flag - an old "--activate KEY" shortcut still starts cleanly.
            if i + 1 < len(argv) and not argv[i + 1].startswith("-"):
                i += 1
        elif token == "--once":
            args.once = True
        elif token == "--status":
            args.status = True
        elif token in ("--help", "-h"):
            _print_usage()
            raise SystemExit(_EXIT_OK)
        # else: ignore unknown tokens deliberately.
        i += 1
    return args


def _print_usage() -> None:
    """Print CLI usage to stdout."""
    print(
        f"{_APP_NAME}\n"
        "\n"
        "Usage:\n"
        "  python sync_agent.py                 Run the continuous sync loop.\n"
        "  python sync_agent.py --activate KEY  Activate with a license key, then run.\n"
        "  python sync_agent.py --once          Run a single cycle and exit.\n"
        "  python sync_agent.py --status        Print config + status and exit.\n"
        "  python sync_agent.py --help          Show this help.\n"
    )


# --------------------------------------------------------------------------- #
# Bootstrap helpers
# --------------------------------------------------------------------------- #
def _load_config(log_name: str = "agent"):
    """Load :class:`Config`; return ``(cfg, logger)``.

    Config loading is wrapped so a bad ``config.ini`` is reported cleanly
    instead of dumping a traceback on a customer's screen.
    """
    try:
        cfg = Config.load()
    except Exception as exc:  # ConfigError or anything unexpected.
        # No logger yet - fall back to a default one so this is still recorded.
        boot_log = get_logger(log_name)
        boot_log.error("Failed to load configuration: %s", exc)
        print(f"Configuration error: {exc}", file=sys.stderr)
        raise SystemExit(_EXIT_CONFIG) from exc

    logger = get_logger(log_name, cfg.log_level)
    return cfg, logger


def _persist_token(cfg: Config, logger, data: dict) -> None:
    """Validate the activate response, persist the token, log the summary.

    Shared by both the interactive and non-interactive activation paths.
    Raises :class:`SystemExit` on a missing token or a persist failure.
    """
    token = data.get("agent_token")
    if not token:
        msg = "Activation response did not include an agent token."
        logger.error(msg)
        print(msg, file=sys.stderr)
        raise SystemExit(_EXIT_ACTIVATION)

    # Persist the token (and machine id) so restarts skip activation.
    try:
        cfg.set_token(token)
    except Exception as exc:  # ConfigError on a read-only dir, etc.
        logger.error("Activated but could not persist token: %s", exc)
        print(f"Activated, but failed to save token: {exc}", file=sys.stderr)
        raise SystemExit(_EXIT_CONFIG) from exc

    _log_activation_summary(logger, data)


def _activation_success_line(data: dict) -> str:
    """Build a one-line operator-facing success summary from the response.

    Pulls the holder name + plan from ``data['license']`` and the company count
    from ``data['companies']`` (best-effort; missing fields show as '?').
    """
    license_info = data.get("license") or {}
    holder = license_info.get("holder_name", "?")
    plan = license_info.get("plan", "?")
    companies = data.get("companies") or []
    return (
        f"  [OK] Activated for '{holder}' (plan={plan}, "
        f"{len(companies)} company(ies))."
    )


def _activate(cfg: Config, logger, api: ApiClient) -> None:
    """The NON-INTERACTIVE activation path - which no longer exists.

    Sign-in now requires a code emailed to the account owner, so there is
    nothing a headless run can supply up front: no key, no environment
    variable, no config entry. Rather than fail with a confusing auth error
    several steps later, say so here and point at the two paths that do work.

    (Once signed in, the token is machine-bound and long-lived, so an unattended
    service still runs for months without anyone touching it. This affects only
    the FIRST sign-in on a machine.)
    """
    msg = (
        "This computer is not signed in yet, and sign-in needs a code emailed "
        "to you.\n"
        f"  Run {_SLUG}.exe and sign in there, or run this agent from a "
        "terminal to be prompted."
    )
    logger.error("Non-interactive start with no token: sign-in required.")
    print(msg, file=sys.stderr)
    raise SystemExit(_EXIT_ACTIVATION)


def _activate_interactive(cfg: Config, logger, api: ApiClient) -> None:
    """Console sign-in: email + password, then the 6-digit code.

    Mirrors the GUI wizard so both paths hit the same two endpoints. As there,
    NOTHING is validated locally - whatever is typed goes to the server and the
    server's message is printed verbatim, so wording and rules stay in one place.

    The password is read with getpass so it is not echoed and does not land in
    the operator's shell history or a screen recording.
    """
    import getpass

    echo("")
    echo("STEP 1/4 - Sign in")

    machine_name = _machine_name()
    for attempt in range(1, _MAX_ACTIVATION_ATTEMPTS + 1):
        try:
            email = input("  Email: ").strip()
            password = getpass.getpass("  Password: ")
        except (EOFError, KeyboardInterrupt):
            echo("")
            echo("  [x] Sign-in cancelled. Exiting.")
            logger.info("Interactive sign-in aborted by operator.")
            raise SystemExit(_EXIT_ACTIVATION)

        if not email and not password:
            echo("  [x] Nothing entered. Exiting.")
            raise SystemExit(_EXIT_ACTIVATION)

        echo("  [..] Signing in...")
        try:
            challenge = api.login(email, password, cfg.machine_id,
                                  machine_name=machine_name,
                                  agent_version=cfg.agent_version)
        except ActivationError as exc:
            logger.warning("Sign-in attempt %d failed: %s", attempt, exc)
            echo(f"  [x] {exc}")
            continue

        echo(f"  [ok] We emailed a 6-digit code to {challenge.get('email_masked', 'your address')}.")
        if _verify_code_interactive(cfg, logger, api, challenge, machine_name):
            return
        # Code loop gave up; fall through and let the operator re-enter the
        # password, since the challenge is now dead.

    msg = (
        f"Sign-in failed after {_MAX_ACTIVATION_ATTEMPTS} attempts. "
        "Check your email and password and your internet connection, then run again."
    )
    logger.error(msg)
    echo(f"  [x] {msg}")
    raise SystemExit(_EXIT_ACTIVATION)


def _verify_code_interactive(cfg: Config, logger, api: ApiClient,
                             challenge: dict, machine_name: str) -> bool:
    """Prompt for the emailed code until it verifies or the challenge dies.

    Returns True once the token is stored. Returns False when the challenge is
    spent, so the caller can restart from the password - a dead challenge cannot
    be rescued by typing more codes at it.
    """
    challenge_id = challenge.get("challenge_id") or ""
    for _ in range(_MAX_ACTIVATION_ATTEMPTS):
        try:
            code = input("  6-digit code (or 'r' to resend): ").strip()
        except (EOFError, KeyboardInterrupt):
            echo("")
            echo("  [x] Sign-in cancelled. Exiting.")
            raise SystemExit(_EXIT_ACTIVATION)

        if code.lower() == "r":
            try:
                api.resend_otp(challenge_id)
                echo("  [ok] A new code is on its way.")
            except ActivationError as exc:
                echo(f"  [x] {exc}")
            continue

        try:
            data = api.verify_otp(challenge_id, code, cfg.machine_id,
                                  machine_name=machine_name,
                                  agent_version=cfg.agent_version)
        except ActivationError as exc:
            echo(f"  [x] {exc}")
            # "Start again" means the challenge is gone; more codes cannot help.
            if "start again" in str(exc).lower():
                return False
            continue

        _persist_token(cfg, logger, data)
        echo(_activation_success_line(data))
        return True
    return False


def _machine_name() -> str:
    """A name a person can recognise in a device list ("DESKTOP-A1B2")."""
    import socket
    try:
        return socket.gethostname()[:191]
    except Exception:            # noqa: BLE001 - a nameless device is fine
        return ""


def _log_activation_summary(logger, data: dict) -> None:
    """Log the license holder and accessible companies after activation."""
    license_info = data.get("license") or {}
    holder = license_info.get("holder_name", "?")
    plan = license_info.get("plan", "?")
    valid_until = license_info.get("valid_until", "?")
    max_companies = license_info.get("max_companies", "?")
    logger.info(
        "Activated for '%s' (plan=%s, valid_until=%s, max_companies=%s).",
        holder,
        plan,
        valid_until,
        max_companies,
    )

    companies = data.get("companies") or []
    if companies:
        logger.info("Accessible companies (%d):", len(companies))
        for company in companies:
            logger.info(
                "  - %s [%s] status=%s",
                company.get("name", "?"),
                company.get("slug", "?"),
                company.get("status", "?"),
            )
    else:
        logger.info("No companies are currently linked to this license.")


def _stdin_is_tty() -> bool:
    """Return True only when stdin is an interactive terminal.

    Headless / scheduled-task / piped contexts report False, in which case we
    must NOT enter the re-prompt loop (it would hang waiting on input forever).
    Wrapped because ``isatty`` can be missing/raise on odd stream replacements.
    """
    try:
        return bool(sys.stdin) and sys.stdin.isatty()
    except Exception:
        return False


def _ensure_activated(args: _Args, cfg: Config, logger, api: ApiClient) -> None:
    """Sign in if there is no saved token, or if ``--signin`` was passed.

    There is only one style now. Licence keys are gone, so nothing can be
    supplied ahead of time: sign-in always needs a password AND a code emailed
    to the account, which means a person. With a terminal attached we prompt;
    without one we fail fast with a message that says what to do, instead of
    blocking a scheduled task on input() forever.

    This is the FIRST run on a machine only. The token that comes back is
    machine-bound and effectively non-expiring, so the service then runs
    unattended for months.
    """
    if cfg.get_token() and not args.activate:
        logger.debug("Existing agent token found; skipping sign-in.")
        return

    if _stdin_is_tty():
        _activate_interactive(cfg, logger, api)
    else:
        _activate(cfg, logger, api)

# --------------------------------------------------------------------------- #
# One sync cycle
# --------------------------------------------------------------------------- #
def _flag(data: dict, key: str, default: bool = True) -> bool:
    """Read a boolean direction flag from the heartbeat response.

    Used for the per-license AUTO-sync toggles ``push_enabled`` / ``pull_enabled``
    (Requirement 1). MISSING key -> ``default`` (True), so an older cloud server
    that doesn't send the flags keeps the original behaviour (both directions ON,
    no regression). Tolerates bool / 0-1 / "true"/"false" / "on"/"off" / None so a
    differently-typed JSON value never crashes the loop.
    """
    if not isinstance(data, dict) or key not in data:
        return default
    val = data.get(key)
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val != 0
    s = str(val).strip().lower()
    if s in ("1", "true", "on", "yes"):
        return True
    if s in ("0", "false", "off", "no"):
        return False
    return default


# The syncable-module catalog (key -> friendly label) — MUST mirror the server's
# api/Helpers/syncModules.js. Used only to pretty-print the selection in the logs;
# the cloud is authoritative and already filters /pending (push) + /import (pull)
# to just the selected modules, so the agent never has to filter itself.
SYNC_MODULE_LABELS = {
    "customers": "Customers", "suppliers": "Suppliers", "products": "Products",
    "categories": "Categories", "locations": "Locations",
    "sales-invoices": "Sales Invoices", "purchase-invoices": "Purchase Invoices",
    "payments": "Payments", "receipts": "Receipts", "journals": "Journals",
}
ALL_SYNC_MODULE_KEYS = list(SYNC_MODULE_LABELS.keys())


def _modules(data: dict, key: str) -> list[str]:
    """Read a module-selection list from the heartbeat (``push_modules`` /
    ``pull_modules``). MISSING / non-list -> ALL modules (older server or an
    unconfigured licence syncs everything, no regression). Filters to the known
    keys so a stray value never confuses the log."""
    if not isinstance(data, dict) or key not in data:
        return list(ALL_SYNC_MODULE_KEYS)
    val = data.get(key)
    if not isinstance(val, list):
        return list(ALL_SYNC_MODULE_KEYS)
    return [str(x) for x in val if str(x) in SYNC_MODULE_LABELS]


def _modules_label(keys: list[str]) -> str:
    """Human-readable summary of a module selection for the logs/console."""
    if not keys:
        return "NONE"
    if len(keys) == len(ALL_SYNC_MODULE_KEYS):
        return "ALL"
    return ", ".join(SYNC_MODULE_LABELS.get(k, k) for k in keys)


def _open_company_names(cfg: Config, logger) -> Optional[list[str]]:
    """Return the names of the companies currently OPEN in Tally (or None).

    Best-effort + wrapped: if Tally is unreachable or the read fails we return
    ``None`` so the heartbeat omits the field (leaving the last reported value on
    the license untouched) instead of clobbering it with an empty list.
    """
    try:
        tally = TallyConnector(_tally_url(cfg), logger)
        names = [str(c.get("name") or "").strip()
                 for c in (tally.company_info().get("companies") or [])
                 if str(c.get("name") or "").strip()]
        return names
    except Exception as exc:  # Tally down / parse miss - report nothing.
        logger.debug("Could not read open companies for heartbeat: %s", exc)
        return None


def _tally_ini_path(cfg: Config, exe: Optional[str]) -> Optional[str]:
    """Best-effort path to tally.ini (next to tally.exe).

    The agent already locates tally.exe; tally.ini lives in the same folder
    (this matches the dev box, where Data= is read from that ini). Returns None
    if the exe is unknown.
    """
    if not exe:
        return None
    return os.path.join(os.path.dirname(exe), "tally.ini")


# --------------------------------------------------------------------------- #
# Data Backup (Task 2 — the agent side of Task 1's cloud endpoints)
# --------------------------------------------------------------------------- #
# When the most recent backup ran, in this process's memory only. A restart
# forgets it, which at worst causes one extra scheduled run shortly after
# restart (due_now still gates on the scheduled time of day) — never a data
# loss risk, since old copies are only ever removed AFTER a new one finishes.
_LAST_BACKUP_RUN_AT: Optional[datetime.datetime] = None


def _run_one_backup(cfg: Config, logger, api: ApiClient,
                    reason: str = "scheduled") -> Optional[dict]:
    """Run exactly one backup (if a destination is configured) and report it.

    Resolves Tally's data folder the SAME way the rest of the agent does
    (``tally_control._read_data_path`` off ``tally.ini`` — no second method),
    runs :func:`backup_runner.run_backup`, and reports the outcome to
    ``POST /agent/backup-runs`` regardless of whether it succeeded, was
    partial, or failed — a customer relying on this backup needs to see EVERY
    outcome, not just the good ones.

    Returns the result dict, or ``None`` when there is no token or no
    destination configured (nothing to report in that case). Never raises:
    every step is wrapped so a backup problem can never take down the sync
    loop (mirrors every other command handler in this module).
    """
    global _LAST_BACKUP_RUN_AT
    token = cfg.get_token()
    if not token:
        return None

    try:
        settings = api.get_backup_settings(token)
    except AgentError as exc:
        logger.warning("Backup (%s): could not fetch backup settings: %s", reason, exc)
        return None

    destination = str(settings.get("destination_path") or "").strip()
    if not destination:
        logger.debug("Backup (%s): no destination configured - skipping.", reason)
        return None

    keep_copies = settings.get("keep_copies", 7)

    exe = _find_tally_exe(cfg)
    ini_path = _tally_ini_path(cfg, exe)
    data_path = tally_control._read_data_path(ini_path) if ini_path else None

    started_at = datetime.datetime.utcnow()
    if not data_path:
        logger.warning("Backup (%s): could not resolve Tally data path from tally.ini.", reason)
        result = {
            "status": "failed",
            "files_copied": 0, "files_skipped": 0, "bytes_copied": 0,
            "skipped": [], "destination": None,
            "error": "Could not resolve the Tally data folder (tally.ini Data=).",
        }
    else:
        echo(f"[backup] Starting backup ({reason}) -> {destination}")
        try:
            result = backup_runner.run_backup(data_path, destination, keep_copies, logger)
        except Exception as exc:  # backup_runner is best-effort by contract, but be defensive.
            logger.error("Backup (%s): unexpected error: %s", reason, exc)
            result = {
                "status": "failed",
                "files_copied": 0, "files_skipped": 0, "bytes_copied": 0,
                "skipped": [], "destination": None,
                "error": "agent error: " + str(exc)[:200],
            }
    finished_at = datetime.datetime.utcnow()
    _LAST_BACKUP_RUN_AT = datetime.datetime.now()

    status = result.get("status")
    if status == "success":
        logger.info("Backup (%s): success - %d file(s), %d byte(s).",
                    reason, result.get("files_copied", 0), result.get("bytes_copied", 0))
        echo(f"[backup] Success - {result.get('files_copied', 0)} file(s) copied.")
    elif status == "partial":
        logger.warning("Backup (%s): PARTIAL - %d copied, %d skipped: %s",
                       reason, result.get("files_copied", 0), result.get("files_skipped", 0),
                       result.get("skipped"))
        echo(f"[backup] Partial - {result.get('files_skipped', 0)} file(s) could not be read.")
    else:
        logger.error("Backup (%s): FAILED - %s", reason, result.get("error"))
        echo(f"[backup] Failed - {result.get('error')}")

    try:
        api.record_backup_run(
            token,
            started_at=started_at.isoformat(),
            finished_at=finished_at.isoformat(),
            status=status,
            files_copied=result.get("files_copied", 0),
            files_skipped=result.get("files_skipped", 0),
            bytes_copied=result.get("bytes_copied", 0),
            destination=result.get("destination"),
            skipped_list=result.get("skipped") or [],
            error=result.get("error"),
        )
    except Exception as exc:  # reporting must never break the loop either.
        logger.warning("Backup (%s): could not report run result to cloud: %s", reason, exc)

    return result


def _maybe_run_scheduled_backup(cfg: Config, logger, api: ApiClient) -> None:
    """Once per cycle, check the backup schedule and run it if due.

    Best-effort + fully isolated (like every command handler here): a backup
    failure of any kind is logged and reported, never raised, so it can never
    stop the normal push/pull sync.
    """
    token = cfg.get_token()
    if not token:
        return
    try:
        settings = api.get_backup_settings(token)
    except AgentError as exc:
        logger.debug("Scheduled backup: could not fetch settings: %s", exc)
        return
    try:
        due = backup_runner.due_now(settings, _LAST_BACKUP_RUN_AT, datetime.datetime.now())
    except Exception as exc:  # a bad settings shape must never crash the cycle.
        logger.warning("Scheduled backup: due_now check failed: %s", exc)
        return
    if not due:
        return
    try:
        _run_one_backup(cfg, logger, api, reason="scheduled")
    except Exception as exc:  # absolute backstop - scheduled backup never raises out.
        logger.error("Scheduled backup: unexpected error: %s", exc)


def _dispatch_commands(cfg: Config, logger, api: ApiClient) -> bool:
    """Poll the cloud command channel and run each queued command.

    Drains ``/agent/commands`` (the cloud flips them to 'running' server-side),
    handles every ``open_company`` command via :func:`tally_control.open_company`,
    and reports the outcome back via ``/agent/commands/<id>/result``. Runs once
    per cycle around the normal pull/push.

    Returns ``True`` when a ``pull_now`` command was seen this cycle (a MANUAL
    "Sync from Tally"), so the caller can force a one-off ``_pull_pass`` EVEN when
    the per-license AUTO pull toggle is OFF (a manual action must always work).

    Best-effort + fully isolated: EACH command is wrapped in its own try/except
    so one bad command can never kill the loop, and the internal Tally polls are
    bounded so this never blocks the loop indefinitely.
    """
    token = cfg.get_token()
    if not token:
        return False
    try:
        commands = api.get_commands(token)
    except Exception as exc:  # get_commands already swallows, but be defensive.
        logger.debug("Command poll failed: %s", exc)
        return False
    if not commands:
        return False

    pull_now_seen = False

    logger.info("Command channel: %d command(s) to process.", len(commands))
    if VERBOSE:
        echo("")
        echo(f"[cmd] {len(commands)} command(s) from the cloud.")

    # Resolve Tally paths once for all commands this cycle.
    exe = _find_tally_exe(cfg)
    ini_path = _tally_ini_path(cfg, exe)
    tally = TallyConnector(_tally_url(cfg), logger)

    for cmd in commands:
        cmd_id = cmd.get("id")
        ctype = str(cmd.get("type") or "").strip()
        try:
            if ctype == "self_update":
                # "Update now" from the web — force an immediate update check.
                # Report done BEFORE applying: maybe_self_update may raise
                # SystemExit (hand-off to the updater) and the cloud row should
                # already be closed so it is not stuck 'running' after restart.
                echo("[cmd] Forced self-update check requested by the cloud.")
                api.command_result(token, cmd_id, "done",
                                   result="self-update check triggered")
                maybe_self_update(cfg, logger, api, forced=True)
                continue

            if ctype == "pull_now":
                # MANUAL "Sync from Tally" nudge from the web. The cloud already
                # reset the per-company pull WATERMARK, so a _pull_pass (Tally ->
                # cloud) re-imports everything from Tally. We FLAG it so the caller
                # forces a pull THIS cycle even when the AUTO pull toggle is OFF
                # (a manual action must work regardless of the auto toggle), then
                # ack the command so the row doesn't sit 'running'.
                pull_now_seen = True
                echo("[cmd] Manual pull-from-Tally requested (watermark reset; "
                     "re-importing from Tally this cycle).")
                api.command_result(token, cmd_id, "done",
                                   result="pull watermark reset; re-importing this cycle")
                continue

            if ctype == "backup_now":
                # "Backup now" from the web — run one backup immediately,
                # regardless of the schedule, and report the real outcome
                # (success/partial/failed) back as this command's result too
                # so the web click gets an honest answer, not just "done".
                echo("[cmd] Backup requested by the cloud - running now.")
                outcome = _run_one_backup(cfg, logger, api, reason="manual")
                if outcome is None:
                    api.command_result(token, cmd_id, "failed",
                                       error="backup destination is not configured")
                elif outcome.get("status") == "failed":
                    api.command_result(token, cmd_id, "failed",
                                       error=outcome.get("error") or "backup failed")
                else:
                    api.command_result(
                        token, cmd_id, "done",
                        result=f"{outcome.get('status')}: "
                               f"{outcome.get('files_copied', 0)} file(s) copied, "
                               f"{outcome.get('files_skipped', 0)} skipped")
                continue

            if ctype != "open_company":
                logger.info("Command %s: unknown type '%s' - skipping.", cmd_id, ctype)
                echo(f"[cmd] {cmd_id}: unknown command type '{ctype}' - skipped.")
                api.command_result(token, cmd_id, "failed",
                                   error=f"unknown command type '{ctype}'")
                continue

            name = str(cmd.get("company_name") or "").strip()
            if not name:
                logger.warning("Command %s: open_company has no company_name.", cmd_id)
                echo(f"[cmd] {cmd_id}: open_company missing company name - failing.")
                api.command_result(token, cmd_id, "failed",
                                   error="command had no company_name")
                continue

            echo(f"[cmd] Opening company '{name}' in Tally...")
            res = tally_control.open_company(
                cfg, logger, tally,
                name=name, data_path=None, ini_path=ini_path, exe_path=exe,
            )
            ok = bool(res.get("ok"))
            method = str(res.get("method") or "none")
            message = str(res.get("message") or "")
            if ok:
                api.command_result(token, cmd_id, "done",
                                   result=f"{method}: {message}")
                echo(f"[cmd] {cmd_id}: opened '{name}' via {method}.")
                logger.info("Command %s: opened '%s' via %s.", cmd_id, name, method)
            else:
                api.command_result(token, cmd_id, "failed",
                                   result=method, error=message)
                echo(f"[cmd] {cmd_id}: could not open '{name}' - {message}")
                logger.warning("Command %s: could not open '%s' - %s.",
                               cmd_id, name, message)
        except Exception as exc:  # one bad command must never kill the loop.
            logger.error("Command %s failed unexpectedly: %s", cmd_id, exc)
            echo(f"[cmd] {cmd_id}: error - {exc}")
            try:
                api.command_result(token, cmd_id, "failed",
                                   error="agent error: " + str(exc)[:200])
            except Exception:
                pass

    return pull_now_seen


def _run_cycle(cfg: Config, logger, api: ApiClient) -> bool:
    """Run a single heartbeat + sync cycle.

    Returns ``True`` if the cycle completed its work (or cleanly skipped),
    ``False`` if it failed in a way the caller should count as a retry. Never
    raises - every external call is wrapped so the loop survives.
    """
    # What earlier runs learned about requests that kill TallyPrime, loaded
    # BEFORE anything can ask for one. This lives here, in the cycle, rather
    # than in one caller of it: it used to be done only by run_sync_loop, so
    # `--once` (and anything else entering a cycle directly) started with an
    # empty quarantine and asked for the request the store already named —
    # taking Tally down again on a machine that had known better for an hour.
    # Cheap enough to repeat: one small file, once a cycle, and re-reading it
    # picks up a store another process has since added to.
    try:
        tally_connector.use_skip_store(skip_store_path(cfg))
    except Exception:                                       # noqa: BLE001
        pass

    token = cfg.get_token()
    if not token:
        # Should not happen after _ensure_activated, but be defensive.
        logger.error("No agent token available; cannot run cycle.")
        return False

    # 1) Heartbeat - tells the cloud we are alive and learns our license state.
    #    We also report the companies currently OPEN in Tally so the cloud (and
    #    the web Sync page) can show "Currently open in Tally: X, Y". Reading the
    #    open list is best-effort: if Tally is down it stays None and the
    #    heartbeat simply omits it (last value on the license is left untouched).
    open_companies = _open_company_names(cfg, logger)
    try:
        hb = api.heartbeat(token, cfg.agent_version, open_companies=open_companies)
    except AgentError as exc:
        logger.warning("Heartbeat failed (will retry next cycle): %s", exc)
        return False

    status = (hb.get("status") or "").lower()
    if status != "active":
        # Cloud has suspended/expired us - keep heartbeating but do not sync.
        logger.warning("license %s - pausing sync", status or "inactive")
        return True

    # Per-license AUTO-sync DIRECTION toggles (Requirement 1). The heartbeat
    # response carries push_enabled / pull_enabled; we gate the AUTO push/pull
    # passes on them. Default ON when the key is missing (older server / pre-
    # migration cloud) so there is no regression. These gate ONLY this automatic
    # loop - the web Sync Dashboard's MANUAL per-module buttons are independent.
    push_enabled = _flag(hb, "push_enabled")
    pull_enabled = _flag(hb, "pull_enabled")

    # Per-license SELECTED modules for AUTO push/pull. The cloud already filters
    # /pending + /import to just these; the agent reads them ONLY to report which
    # modules are in scope this cycle (the "with all logs" requirement).
    push_modules = _modules(hb, "push_modules")
    pull_modules = _modules(hb, "pull_modules")

    # 2) Tally reachability - if it is down, optionally AUTO-START it, then
    #    re-check. Tally serves its XML API only while open, so auto-start lets
    #    the agent run truly unattended (config [tally] auto_start, default on).
    url = _tally_url(cfg)
    if VERBOSE:
        echo("")
        echo("STEP 2/4 - Checking Tally")
        echo(f"  [..] Probing the Tally gateway at {url} ...")
    tally = TallyConnector(url, logger)
    try:
        available = tally.is_available()
    except Exception as exc:  # never trust an external probe to behave.
        logger.warning("Tally probe error (treating as unreachable): %s", exc)
        available = False

    if available:
        # Same TallyPrime as the quarantine was learned on? A licence activated
        # since the last cycle turns "this Tally cannot serve TDS" into a stale
        # fact that would suppress real data forever. Best-effort, one small
        # request. See TallyConnector.check_identity.
        try:
            tally.check_identity()
        except Exception as exc:                            # noqa: BLE001
            logger.debug("Tally identity check skipped: %s", exc)
        if VERBOSE:
            echo("  [OK] Tally is up and reachable.")

    if not available and cfg.tally_auto_start:
        if VERBOSE:
            echo("  [!] Tally is off -> launching TallyPrime...")
        available = _start_tally(cfg, logger)

    if not available:
        logger.info("Tally not reachable - will retry")
        if VERBOSE:
            echo(
                "  [!] Could not reach Tally on :9000. Open TallyPrime, load the "
                "company, and enable Gateway: F1 > Settings > Connectivity "
                "(Server, port 9000). Will retry."
            )
        return True

    # 2b) Cloud -> agent commands (e.g. "Open company X in Tally"). Drained and
    #     run BEFORE the push so a just-requested company is loaded in time to be
    #     a sync target this same cycle. Fully isolated: one bad command can never
    #     break the cycle, and the internal Tally polls are bounded.
    # A 'pull_now' command (MANUAL "Sync from Tally") forces a one-off pull this
    # cycle EVEN when the AUTO pull toggle is OFF - a manual action must always
    # work (the cloud reset the watermark; this consumes it now).
    pull_now = _dispatch_commands(cfg, logger, api)

    # 2c) Scheduled data backup - checked once per cycle, isolated from the
    # rest of the cycle so a backup problem never stops syncing.
    try:
        _maybe_run_scheduled_backup(cfg, logger, api)
    except Exception as exc:  # never let a backup problem break the cycle.
        logger.error("Scheduled backup check failed unexpectedly: %s", exc)

    if pull_now:
        # The cloud reset only the MASTERS watermark; vouchers keep a separate
        # LOCAL cursor, so clear it too — else "Sync from Tally" re-imports masters
        # but never the vouchers (the exact symptom this fixes).
        _reset_all_voucher_state(cfg, logger)

    # 3) Push (cloud -> Tally) then Pull (Tally -> cloud), each gated by its
    #    per-license AUTO toggle. Push drives the pass result; the pull is best-
    #    effort + never fails the cycle. When a direction is OFF its pass is
    #    skipped entirely (a skip is NOT a failure, so the cycle still counts ok).
    #    If BOTH are off the cycle still heartbeated + drained commands above.
    if push_enabled:
        logger.info("Cloud->Tally auto-sync ON; modules: %s", _modules_label(push_modules))
        if VERBOSE:
            echo("")
            echo("STEP 3/4 - Cloud -> Tally (push)")
            echo(f"  [i] Modules selected for auto-push: {_modules_label(push_modules)}")
        pushed = _sync_pass(cfg, logger, api, tally)
    else:
        pushed = True
        logger.info("Cloud->Tally auto-sync is OFF (skipped)")
        if VERBOSE:
            echo("")
            echo("STEP 3/4 - Cloud -> Tally (push)")
            echo("  [..] Cloud->Tally auto-sync is OFF (skipped).")

    # Pull runs when AUTO pull is ON, OR when a manual 'pull_now' arrived this
    # cycle (manual overrides the auto toggle).
    if pull_enabled or pull_now:
        if not pull_enabled and pull_now:
            logger.info("Tally->Cloud manual pull (AUTO pull is OFF; honouring "
                        "the manual 'Sync from Tally' request).")
            if VERBOSE:
                echo("")
                echo("STEP 4/4 - Tally -> Cloud (manual pull; auto is OFF)")
        else:
            logger.info("Tally->Cloud auto-sync ON; modules: %s", _modules_label(pull_modules))
            if VERBOSE:
                echo("")
                echo("STEP 4/4 - Tally -> Cloud (pull)")
                echo(f"  [i] Modules selected for auto-pull: {_modules_label(pull_modules)}")
        _pull_pass(cfg, logger, api, tally)
    else:
        logger.info("Tally->Cloud auto-sync is OFF (skipped)")
        if VERBOSE:
            echo("")
            echo("STEP 4/4 - Tally -> Cloud (pull)")
            echo("  [..] Tally->Cloud auto-sync is OFF (skipped).")

    return pushed


def _interpret_tally(resp: str) -> tuple[bool, str]:
    """Interpret a Tally import response -> (ok, info).

    Tally answers an IMPORT with <CREATED>/<ALTERED> counts on success and
    <LINEERROR>...</LINEERROR> / <EXCEPTIONS>n</EXCEPTIONS> on failure. We extract
    the error text when present, else treat created/altered>0 (or an otherwise
    error-free body) as success.
    """
    text = resp or ""
    m = re.search(r"<LINEERROR>(.*?)</LINEERROR>", text, re.S | re.I)
    if m:
        return False, m.group(1).strip()[:300]
    created = int((re.search(r"<CREATED>(\d+)</CREATED>", text, re.I) or [0, "0"])[1]) \
        if re.search(r"<CREATED>(\d+)</CREATED>", text, re.I) else 0
    altered = int((re.search(r"<ALTERED>(\d+)</ALTERED>", text, re.I) or [0, "0"])[1]) \
        if re.search(r"<ALTERED>(\d+)</ALTERED>", text, re.I) else 0
    if created or altered:
        return True, f"created={created} altered={altered}"
    em = re.search(r"<EXCEPTIONS>(\d+)</EXCEPTIONS>", text, re.I)
    if em and int(em.group(1)) > 0:
        return False, "Tally reported exceptions."
    return True, "ok"


def _push_master(tally: TallyConnector, item: dict, kind: str,
                 company: Optional[str] = None) -> dict:
    """Push one ledger/stock-item to Tally and shape a result row.

    ``company`` is the target Tally company name; when set, the master is
    imported into THAT company (SVCURRENTCOMPANY) rather than the active one.
    """
    if kind == "ledger":
        resp = tally.create_ledger(
            item["name"], parent=item.get("parent", "Sundry Debtors"),
            gstin=item.get("gstin"), opening=item.get("opening", 0),
            company=company,
            mobile=item.get("mobile"), email=item.get("email"), pan=item.get("pan"),
            address=item.get("address"), state=item.get("state"),
            pincode=item.get("pincode"), credit_limit=item.get("credit_limit"),
            action=item.get("action", "Create"),
        )
    else:  # stock item
        resp = tally.create_stock_item(
            item["name"], unit=item.get("unit", "Nos"),
            hsn=item.get("hsn"), gst_rate=item.get("gst_rate"),
            company=company, action=item.get("action", "Create"),
        )
    ok, info = _interpret_tally(resp)
    res = {"record_type": item["record_type"], "record_id": item["id"],
           "company_id": item["company_id"], "status": "synced" if ok else "failed"}
    # NOTE: no tally_guid here. A Tally master-import response carries only
    # created/altered counts, never the new master's GUID, so there is nothing
    # truthful to send. The cloud stamps tally_synced_at from status alone and
    # picks up the real GUID on the next PULL. (We used to send the literal
    # string "synced", which poisoned the column now that it is a unique
    # identity key.)
    if not ok:
        res["message"] = info
    return res


def _push_godown_or_group(tally: TallyConnector, item: dict, kind: str,
                          company: Optional[str] = None) -> dict:
    """Push one location (godown) or category (stock group) to Tally.

    ``kind`` is "location" (-> GODOWN master) or "category" (-> STOCKGROUP
    master). Shapes a result row with record_type "location"/"category" so the
    cloud's result() can stamp it. ``company`` targets a specific loaded company.
    """
    if kind == "location":
        resp = tally.create_godown(item["name"], company=company)
    else:  # category
        resp = tally.create_stock_group(item["name"], company=company)
    ok, info = _interpret_tally(resp)
    res = {"record_type": item["record_type"], "record_id": item["id"],
           "company_id": item["company_id"], "status": "synced" if ok else "failed"}
    # See _push_ledger_or_item: no placeholder guid — the cloud stamps
    # tally_synced_at from status and learns the real GUID on the next pull.
    if not ok:
        res["message"] = info
    return res


def _push_voucher(tally: TallyConnector, v: dict, company: Optional[str] = None) -> dict:
    """Push one voucher (sales/purchase/receipt/payment) and shape a result.

    ``company`` is the target Tally company name; when set, the voucher is
    imported into THAT company (SVCURRENTCOMPANY) rather than the active one.
    """
    kind = v.get("voucher_kind")
    if kind == "sales":
        if v.get("ledgers"):   # EXACT double-entry (party + Sales + GST + round-off)
            resp = tally.create_voucher_from_ledgers("Sales", v["party"], v["date"],
                                                     v["ledgers"], company=company)
        else:
            resp = tally.create_sales_voucher(v["party"], v["date"], v.get("items", []),
                                              company=company, amount=v.get("amount"))
    elif kind == "purchase":
        if v.get("ledgers"):
            resp = tally.create_voucher_from_ledgers("Purchase", v["party"], v["date"],
                                                     v["ledgers"], company=company)
        else:
            resp = tally.create_purchase_voucher(v["party"], v["date"], v.get("items", []),
                                                 company=company, amount=v.get("amount"))
    elif kind == "receipt":
        resp = tally.create_receipt(v["party"], v["date"], v.get("amount", 0),
                                    mode=v.get("mode", "Cash"), company=company)
    elif kind == "journal":
        resp = tally.create_journal(v["dr_ledger"], v["cr_ledger"], v["date"],
                                    v.get("amount", 0), v.get("narration", ""),
                                    vch_type=v.get("vch_type", "Journal"), company=company)
    elif kind == "payment":
        resp = tally.create_payment(v["party"], v["date"], v.get("amount", 0),
                                    mode=v.get("mode", "Cash"), company=company)
    elif kind in ("credit_note", "debit_note"):
        # No items-based fallback here (unlike sales/purchase): without an
        # exact ledger breakdown we cannot build a correct note, and a
        # partial voucher in the customer's books is worse than none.
        if not v.get("ledgers"):
            res = {"record_type": v["record_type"], "record_id": v["id"],
                   "company_id": v["company_id"], "status": "failed",
                   "message": f"{kind}: no ledgers supplied, refusing to build an incomplete voucher"}
            return res
        vtype = "Credit Note" if kind == "credit_note" else "Debit Note"
        resp = tally.create_voucher_from_ledgers(vtype, v["party"], v["date"],
                                                 v["ledgers"], company=company)
    elif kind in ("stock_journal", "physical_stock"):
        # GOODS vouchers: no ledgers, only item/godown/qty lines. A line
        # missing any of those must refuse the WHOLE voucher (see
        # TallyConnector._validate_stock_lines) rather than post a partial
        # stock movement into the customer's books.
        try:
            if kind == "stock_journal":
                resp = tally.create_stock_journal(
                    v["voucher_no"], v["date"], v.get("source_items", []),
                    v.get("destination_items", []), narration=v.get("narration", ""),
                    company=company)
            else:
                resp = tally.create_physical_stock(
                    v["voucher_no"], v["date"], v.get("items", []),
                    narration=v.get("narration", ""), company=company)
        except ValueError as exc:
            res = {"record_type": v["record_type"], "record_id": v["id"],
                   "company_id": v["company_id"], "status": "failed",
                   "message": str(exc)}
            return res
    elif kind in ("quotation", "sales_order", "purchase_order",
                  "delivery_note", "receipt_note"):
        # Item-carrying vouchers, all built by the same shared XML -- they
        # differ only in Tally's VOUCHER TYPE NAME (never hard-coded: it comes
        # from the row's own tally_voucher_type, since a company may call its
        # Quotation type anything, or not have one) and in whether they are
        # OPTIONAL. Tally can legitimately refuse all five -- Sales/Purchase
        # Order and Delivery/Receipt Note only exist when order processing is
        # switched on, and "Quotation" is not a stock Tally voucher type -- so
        # a missing voucher type here is an ordinary, expected failure, not a
        # bug; the ValueError/interpreted message below carries the reason
        # back rather than flattening it into a bare "failed".
        vtype = v.get("vch_type") or v.get("tally_voucher_type")
        if not vtype:
            res = {"record_type": v["record_type"], "record_id": v["id"],
                   "company_id": v["company_id"], "status": "failed",
                   "message": f"{kind}: no tally_voucher_type supplied, "
                              "refusing to build a voucher with no type name"}
            return res
        try:
            resp = tally.create_item_voucher(
                vtype, v["party"], v["date"], v.get("items", []),
                company=company, voucher_no=v.get("voucher_no"),
                is_optional=(kind == "quotation"),
                extra_date=v.get("extra_date"),
                extra_date_tag=v.get("extra_date_tag"),
                narration=v.get("narration", ""),
            )
        except ValueError as exc:
            res = {"record_type": v["record_type"], "record_id": v["id"],
                   "company_id": v["company_id"], "status": "failed",
                   "message": str(exc)}
            return res
    else:
        # An unrecognised voucher_kind must NEVER be guessed at -- silently
        # treating it as a payment would write the wrong voucher into the
        # customer's books. Refuse cleanly instead: no Tally call, and the
        # kind is named in the reason so a missed branch is caught fast.
        res = {"record_type": v["record_type"], "record_id": v["id"],
               "company_id": v["company_id"], "status": "failed",
               "message": f"Unknown voucher_kind: {kind!r}"}
        return res
    ok, info = _interpret_tally(resp)
    res = {"record_type": v["record_type"], "record_id": v["id"],
           "company_id": v["company_id"], "status": "synced" if ok else "failed"}
    if ok:
        res["tally_voucher_no"] = v.get("voucher_no")
    else:
        res["message"] = info
    return res


# Optional per-record progress observer, installed by run_sync_loop ONLY when a
# GUI is watching (on_status set). The headless console path leaves it None, so
# nothing here changes for the plain agent. _report_progress throttles a high-
# volume push to ~6 emits/sec (but the final record of a batch always fires).
_PROGRESS_CB = None
_PROGRESS_LAST = 0.0


def _report_progress(done: int, total: int, phase: str = "Cloud -> Tally") -> None:
    """Stream REAL sync progress (done/total) to the GUI bar. Best-effort."""
    cb = _PROGRESS_CB
    if cb is None:
        return
    global _PROGRESS_LAST
    now = time.time()
    if done < total and (now - _PROGRESS_LAST) < 0.15:
        return
    _PROGRESS_LAST = now
    try:
        cb(int(done), int(total), str(phase))
    except Exception:
        pass


def _echo_record(index: int, total: int, kind: str, name: str, res: dict) -> None:
    """Echo a single per-record push line to the console (verbose only).

    Shape: ``  [3/9] voucher  INV-2026-0001   [OK]`` on success, or
    ``  [3/9] voucher  INV-2026-0001   [x] <reason>`` on failure. No-op unless
    :data:`VERBOSE` so normal loop cycles stay quiet.
    """
    # Live progress for the GUI bar — fires even when NOT verbose so every cycle
    # animates the real percentage instead of a meaningless 0->100 sweep.
    _report_progress(index, total, "Cloud -> Tally")
    if not VERBOSE:
        return
    label = (str(name) or "?")[:40]
    if res.get("status") == "synced":
        echo(f"  [{index}/{total}] {kind:<8} {label}   [OK]")
    else:
        reason = (res.get("message") or "failed").strip()[:120]
        echo(f"  [{index}/{total}] {kind:<8} {label}   [x] {reason}")


def _create_companies_in_tally(token, logger, api: ApiClient, tally: TallyConnector,
                               companies: list[dict]) -> None:
    """Create web-made companies (cloud has tally_guid NULL) inside Tally.

    Each entry is ``{id, name}``. On a successful Tally create we report a
    ``record_type:'company'`` result so the cloud stamps companies.tally_guid
    ='tally' (and stops listing it). Best-effort + tolerant: a failure for one
    company is logged and the rest are still attempted; nothing here is fatal.
    """
    results: list[dict] = []
    if VERBOSE:
        echo(f"  Creating {len(companies)} web-made company(ies) in Tally...")
    for c in companies:
        cid = c.get("id")
        cname = str(c.get("name") or "").strip()
        if not cid or not cname:
            continue
        try:
            resp = tally.create_company(
                cname,
                books_from=c.get("books_from"),
                mailing_name=c.get("mailing_name"), email=c.get("email"),
                phone=c.get("phone"), mobile=c.get("mobile"),
                gst=c.get("gst"), pan=c.get("pan"), state=c.get("state"),
                pincode=c.get("pincode"), country=c.get("country"), address=c.get("address"),
                action=c.get("action", "Create"),
            )
            ok, info = _interpret_tally(resp)
        except TallyUnavailable as exc:
            # Tally went away - stop trying companies this pass.
            logger.warning("Company create: Tally unavailable: %s", exc)
            if VERBOSE:
                echo(f"  [!] Tally unavailable while creating companies: {exc}")
            break
        except Exception as exc:  # never let one bad company kill the pass.
            logger.warning("Company create '%s' failed: %s", cname, exc)
            ok, info = False, str(exc)[:200]

        res = {"record_type": "company", "record_id": cid,
               "company_id": cid, "status": "synced" if ok else "failed"}
        # No placeholder guid — see _push_ledger_or_item. The cloud stamps
        # tally_synced_at, and the company's real GUID arrives with the next
        # pull's company_master payload.
        if not ok:
            res["message"] = info
        results.append(res)
        if VERBOSE:
            if ok:
                echo(f"  [OK] company '{cname}' created in Tally.")
            else:
                echo(f"  [x] company '{cname}': {info}")

    if results:
        try:
            api.report_results(token, results)
        except AgentError as exc:
            logger.warning("Could not report company-create results (will retry): %s", exc)


def _sync_pass(cfg: Config, logger, api: ApiClient, tally: TallyConnector) -> bool:
    """One sync pass: pull pending from cloud -> push to Tally -> report results.

    Masters (ledgers + stock items) are pushed BEFORE vouchers, since a voucher
    references the party ledger + stock items. If Tally drops mid-pass we stop
    and report whatever succeeded so far (the rest stays pending for next time).
    """
    token = cfg.get_token()
    try:
        pending = api.get_pending(token)
    except AgentError as exc:
        logger.warning("Could not fetch pending records: %s", exc)
        return False

    ledgers = pending.get("ledgers") or []
    items = pending.get("stock_items") or []
    vouchers = pending.get("vouchers") or []
    locations = pending.get("locations") or []
    categories = pending.get("categories") or []
    new_companies = pending.get("companies_to_create") or []
    companies = pending.get("companies") or []
    total = len(ledgers) + len(items) + len(vouchers) + len(locations) + len(categories)
    if VERBOSE:
        echo("")
        echo("STEP 3/4 - Cloud -> Tally (push)")

    # 3a) Web-made companies that don't exist in Tally yet -> create them first
    #     (best-effort). On success, report so the cloud stamps companies
    #     .tally_guid='tally' and stops returning them here. Never fatal.
    if new_companies:
        _create_companies_in_tally(token, logger, api, tally, new_companies)

    if total == 0:
        logger.info("sync pass: nothing pending - all caught up.")
        if VERBOSE:
            echo("  [OK] Nothing pending - already up to date.")
        return True

    logger.info("sync pass: %d ledger(s), %d stock item(s), %d location(s), "
                "%d category(ies), %d voucher(s) to push.",
                len(ledgers), len(items), len(locations), len(categories), len(vouchers))
    if VERBOSE:
        echo(f"  Pending: {len(ledgers)} ledger(s), {len(items)} stock item(s), "
             f"{len(locations)} location(s), {len(categories)} category(ies), "
             f"{len(vouchers)} voucher(s)  ({total} total).")

    # COMPANY-TARGETED routing: each record carries a company_id; resolve it to
    # the Tally company NAME and import the record INTO that company. Records for
    # a company that isn't currently OPEN in Tally are SKIPPED (not pushed, not
    # reported) so they stay pending and retry once the operator opens it.
    def _as_int(v: Any) -> Optional[int]:
        """Coerce a company id to int, tolerating str/float/None (-> None)."""
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    company_names: dict[int, str] = {}
    for c in companies:
        cid = _as_int(c.get("id"))
        if cid is not None:
            company_names[cid] = str(c.get("name") or "").strip()
    try:
        open_names = {str(c.get("name") or "").strip().lower()
                      for c in (tally.company_info().get("companies") or [])
                      if str(c.get("name") or "").strip()}
    except Exception as exc:  # never let the open-company probe kill the pass.
        logger.warning("Could not read open companies from Tally: %s", exc)
        open_names = set()

    skipped_by_company: dict[str, int] = {}

    def _target_company(rec: dict) -> tuple[Optional[str], bool]:
        """Resolve a record's target company name + whether it's open in Tally.

        Returns ``(name, is_open)``. An unknown company_id (no name) is treated
        as open with ``name=None`` so it falls back to the active company (the
        original single-company behaviour is preserved).
        """
        cid = _as_int(rec.get("company_id"))
        name = company_names.get(cid) if cid is not None else None
        if not name:
            return None, True            # unknown -> active company (legacy path)
        return name, (name.lower() in open_names)

    def _note_skip(name: Optional[str]) -> None:
        key = name or "(unknown)"
        skipped_by_company[key] = skipped_by_company.get(key, 0) + 1

    results: list[dict] = []
    interrupted = False
    done = 0  # running index across ledgers + items + vouchers, for the echo.
    try:
        for lg in ledgers:
            cname, is_open = _target_company(lg)
            if not is_open:
                _note_skip(cname)
                continue
            res = _push_master(tally, lg, "ledger", company=cname)
            results.append(res)
            done += 1
            _echo_record(done, total, "ledger", lg.get("name", "?"), res)
        # Units must exist (per company) before the stock items that reference
        # them. Create each needed unit only in companies that are open.
        unit_companies: dict[Optional[str], set] = {}
        for it in items:
            cname, is_open = _target_company(it)
            if not is_open:
                continue
            unit_companies.setdefault(cname, set()).add(it.get("unit") or "Nos")
        for cname, units in unit_companies.items():
            for u in sorted(units):
                try:
                    tally.create_unit(u, company=cname)
                except Exception as exc:    # a unit that already exists is fine.
                    logger.debug("create_unit(%s, company=%s): %s", u, cname, exc)
        for it in items:
            cname, is_open = _target_company(it)
            if not is_open:
                _note_skip(cname)
                continue
            res = _push_master(tally, it, "stock", company=cname)
            results.append(res)
            done += 1
            _echo_record(done, total, "item", it.get("name", "?"), res)
        # Locations -> Tally godowns.
        for loc in locations:
            cname, is_open = _target_company(loc)
            if not is_open:
                _note_skip(cname)
                continue
            res = _push_godown_or_group(tally, loc, "location", company=cname)
            results.append(res)
            done += 1
            _echo_record(done, total, "location", loc.get("name", "?"), res)
        # Categories -> Tally stock groups.
        for cat in categories:
            cname, is_open = _target_company(cat)
            if not is_open:
                _note_skip(cname)
                continue
            res = _push_godown_or_group(tally, cat, "category", company=cname)
            results.append(res)
            done += 1
            _echo_record(done, total, "category", cat.get("name", "?"), res)
        # Sales/Purchase vouchers are now plain ACCOUNTING vouchers that credit a
        # "Sales" / debit a "Purchase" account ledger, so those ledgers must exist
        # first. Ensure them ONCE per open company that has a sales/purchase
        # voucher this pass (idempotent; a duplicate is harmless). Wrapped like
        # create_unit so an ensure failure never aborts the push.
        ensured_sales: set = set()
        ensured_purchase: set = set()
        for v in vouchers:
            cname, is_open = _target_company(v)
            if not is_open:
                continue
            vkind = v.get("voucher_kind")
            if vkind == "sales" and cname not in ensured_sales:
                ensured_sales.add(cname)
                try:
                    tally.ensure_sales_ledger(company=cname)
                except Exception as exc:    # an existing ledger is fine.
                    logger.debug("ensure_sales_ledger(company=%s): %s", cname, exc)
            elif vkind == "purchase" and cname not in ensured_purchase:
                ensured_purchase.add(cname)
                try:
                    tally.ensure_purchase_ledger(company=cname)
                except Exception as exc:
                    logger.debug("ensure_purchase_ledger(company=%s): %s", cname, exc)
        for v in vouchers:
            cname, is_open = _target_company(v)
            if not is_open:
                _note_skip(cname)
                continue
            res = _push_voucher(tally, v, company=cname)
            results.append(res)
            done += 1
            _echo_record(done, total, v.get("voucher_kind") or "voucher",
                         v.get("voucher_no") or v.get("party", "?"), res)
    except TallyUnavailable as exc:
        # Tally went away mid-pass; report what we have, retry the rest later.
        logger.warning("Tally became unavailable during sync: %s", exc)
        if VERBOSE:
            echo(f"  [!] Tally became unavailable mid-push: {exc}")
        interrupted = True
    except Exception as exc:  # never let one bad record kill the loop.
        logger.error("Unexpected error pushing to Tally: %s", exc)
        if VERBOSE:
            echo(f"  [x] Unexpected error pushing to Tally: {exc}")
        interrupted = True

    # Report whatever we managed to push.
    if results:
        try:
            ack = api.report_results(token, results)
            ok = sum(1 for r in results if r["status"] == "synced")
            logger.info("sync pass: reported %d result(s) (%d synced, %d failed).",
                        ack.get("processed", len(results)), ok, len(results) - ok)
            if VERBOSE:
                echo(f"  [OK] Pushed: {ok} synced, {len(results) - ok} failed.")
        except AgentError as exc:
            logger.warning("Could not report sync results (will resend next pass): %s", exc)
            if VERBOSE:
                echo(f"  [!] Could not report results to cloud (will resend): {exc}")
            return False

    # Records whose company is not open in Tally were skipped (left pending so
    # they sync once the operator opens that company). Surface a clear, per-
    # company message both on the console and in the file log.
    for cname, n in skipped_by_company.items():
        msg = (f"Company '{cname}' is not open in Tally - {n} record(s) skipped "
               "(will sync when you open it).")
        logger.warning(msg)
        if VERBOSE:
            echo(f"  [!] {msg}")

    return not interrupted


def _pull_pass(cfg: Config, logger, api: ApiClient, tally: TallyConnector) -> None:
    """Tally -> Cloud: read masters from the open Tally company + upsert to cloud.

    Reads ledgers (-> customers/suppliers) + stock items (-> products) and posts
    them to /agent/import. Best-effort: any error is logged, never raised. The
    import is idempotent (already-linked records are skipped cloud-side).
    Target company = the FIRST company under this license (single-company is the
    common case; multi-company name-matching is a later refinement).
    """
    token = cfg.get_token()
    if not token:
        return
    if VERBOSE:
        echo("")
        echo("STEP 4/4 - Tally -> Cloud (pull)")

    # Read the companies currently loaded in Tally. We create EACH of them in the
    # cloud (under this license, if new) and sync its data — so a Tally company
    # auto-appears in the cloud on first pull (no manual company setup needed).
    # Right after auto-start the :9000 gateway answers BEFORE the companies have
    # finished loading, so retry a few times before concluding none are open.
    companies = []
    for attempt in range(8):                      # up to ~8 x 4s = 32s
        try:
            info = tally.company_info()
            companies = info.get("companies") or []
        except Exception as exc:
            logger.warning("Pull: could not read Tally companies: %s", exc)
            if VERBOSE:
                echo(f"  [!] Could not read companies from Tally: {exc}")
            return
        if companies:
            break
        if attempt == 0 and VERBOSE:
            echo("  [..] Waiting for companies to finish loading in Tally...")
        time.sleep(4)

    names = [str(c.get("name") or "").strip() for c in companies if str(c.get("name") or "").strip()]
    if not names:
        logger.info("Pull: Tally reported no open company - skipping.")
        if VERBOSE:
            echo("  [!] No company is open in Tally. Open your companies in Tally "
                 "(or set tally.ini 'Load=' to your company numbers) - skipping pull.")
        return
    if VERBOSE:
        echo(f"  Found {len(names)} company(ies) in Tally: {', '.join(names)}")

    for _pi, cname in enumerate(names, 1):
        # Tally -> Cloud runs company-by-company; report coarse (but REAL) progress
        # so the GUI bar moves through the pull phase, not a fake sweep.
        _report_progress(_pi - 1, len(names), "Tally -> Cloud")
        if VERBOSE:
            echo(f"  [..] '{cname}': reading ledgers / stock / vouchers from Tally...")
        # INCREMENTAL masters: ask Tally only for masters changed since the
        # watermark the cloud last confirmed. Previously every cycle re-read the
        # entire master book and the cloud threw away the unchanged ones — the
        # write was cheap, the Tally read never was.
        mwm = _load_master_watermark(cfg, cname)
        if VERBOSE and mwm:
            echo(f"  '{cname}': masters changed since AlterID {mwm} only.")
        try:
            ledgers = tally.ledger_list(company=cname, after_alterid=mwm)
            stock = tally.stock_summary(company=cname, after_alterid=mwm)
            godowns = tally.godown_list(company=cname, after_alterid=mwm)
            groups = tally.group_list(company=cname, after_alterid=mwm)
            # The company master is ONE small record and carries the F11 flags the
            # master fetch below is gated on — always read it in full.
            cmaster = tally.company_full_info(company=cname)
            # Registry-driven masters (units, stock groups/categories, cost
            # centres, currencies, voucher types, budgets, GST/TDS/TCS, payroll).
            # Passing the company's F11 flags lets fetch_all_masters skip
            # collections it does not use — a company without payroll has no
            # Employee collection, so asking is a wasted round trip per cycle.
            # Best-effort: a Tally build that lacks a collection must not cost us
            # the ledgers/stock/vouchers that DID read fine.
            try:
                masters = tally.fetch_all_masters(
                    company=cname, features=(cmaster or {}).get("features"),
                    after_alterid=mwm)
            except TallyUnavailable:
                raise
            except Exception as _mexc:
                logger.warning("Pull[%s]: master collections read failed: %s", cname, _mexc)
                masters = {}
            # Tally's EXACT Balance Sheet / P&L / Trial Balance — pulled verbatim
            # so the cloud mirrors every figure (no reconstruction drift). Best-
            # effort: never let a report miss block the masters/voucher import.
            try:
                freports = tally.financial_reports(company=cname)
            except Exception as _rexc:
                logger.warning("Pull[%s]: financial reports read failed: %s", cname, _rexc)
                freports = {}
            # The SAME reports per financial year, so the cloud can show last
            # year beside this one. The undated pull above stays the "current"
            # snapshot the existing screens read; these are stored alongside it
            # under their FY label, never merged into it.
            # How many years: the company's OWN books span by default, so a book
            # that starts in 2016 syncs all of it instead of the last two years.
            try:
                _ryears = _report_years_for(cfg, cmaster, logger)
                logger.debug("Pull[%s]: pulling %d financial year(s) of reports "
                             "(books_from=%s).", cname, _ryears,
                             (cmaster or {}).get("books_from") if isinstance(cmaster, dict) else "?")
                freports_by_year = tally.financial_reports_by_year(
                    company=cname, years=_ryears)
            except TallyUnavailable:
                raise
            except Exception as _ryexc:
                logger.warning("Pull[%s]: per-year reports read failed: %s", cname, _ryexc)
                freports_by_year = {}
            # Reports the SERVER published that this build has no parser for.
            # This is what lets a new Tally report ship without a new exe: the
            # envelope comes down signed, the agent asks Tally, and the raw XML
            # goes up for the cloud to parse. Best-effort like every other report.
            try:
                extra_reports = tally.extra_reports(company=cname)
                if extra_reports:
                    logger.info("Pull[%s]: %d published report(s): %s", cname,
                                len(extra_reports), ", ".join(sorted(extra_reports)))
            except TallyUnavailable:
                raise
            except Exception as _pexc:
                logger.warning("Pull[%s]: published reports read failed: %s", cname, _pexc)
                extra_reports = {}
            # Tally's OWN bill-wise outstanding is read AFTER the upload below,
            # not here. It is a PER-LEDGER report — one request per party — and
            # on a 3,586-ledger company that is fifteen to twenty-five minutes
            # with the send throttle. Reading it here put every master and every
            # report behind it, so nothing at all reached the cloud until the
            # last bill had answered, and any interruption in between threw the
            # whole cycle away. See the second import further down.
            outstandings = {}
            # Vouchers are NOT read here (Tally's Day Book is single-day). They are
            # pulled below via _pull_vouchers - a chunked, AlterID-incremental
            # Voucher COLLECTION backfill (first run = all history over a few
            # cycles; later cycles = only new/changed).
            vouchers = []
        except Exception as exc:
            logger.warning("Pull[%s]: reading from Tally failed: %s", cname, exc)
            if VERBOSE:
                echo(f"  [x] '{cname}': could not read from Tally ({exc})")
            continue

        # DEBUG diagnostics: EXACTLY what Tally returned for this company. With
        # config.ini log_level=DEBUG this instantly tells real-vs-empty: all 0 =
        # the OPEN company is blank / the wrong company is active (Tally CMPINFO
        # shows 0 masters). Samples expose a mis-mapped group at a glance. This
        # is the toggleable "what came from Tally" log (turn off: log_level=INFO).
        logger.debug("Pull[%s]: Tally returned ledgers=%d stock=%d godowns=%d vouchers=%d",
                     cname, len(ledgers), len(stock), len(godowns), len(vouchers))
        if ledgers:
            logger.debug("Pull[%s]: ledger sample: %s", cname,
                         "; ".join((str(l.get("name", "?")) + "<" + str(l.get("parent") or "?") + ">")
                                   for l in ledgers[:8]))
        else:
            logger.debug("Pull[%s]: 0 ledgers from Tally - the OPEN company is most likely empty/blank "
                         "(only default Cash + P&L) or the WRONG company is active. Confirm the real "
                         "data folder is loaded + opened in Tally.", cname)
        if vouchers:
            logger.debug("Pull[%s]: voucher sample: %s", cname,
                         "; ".join((str(v.get("vtype", "?")) + " " + str(v.get("date", "?")) + " "
                                    + str(v.get("party", "?"))[:18]) for v in vouchers[:5]))

        try:
            counts = api.import_from_tally(token, ledgers, stock, vouchers, godowns,
                                           groups=groups, company_master=cmaster,
                                           company_name=cname, financial_reports=freports,
                                           masters=masters,
                                           financial_reports_by_year=freports_by_year,
                                           outstandings=outstandings,
                                           extra_reports=extra_reports)
            new = sum(counts.get(k, 0) for k in ("customers_new", "suppliers_new", "products_new"))
            linked = sum(counts.get(k, 0) for k in ("customers_linked", "suppliers_linked", "products_linked"))
            updated = counts.get("masters_updated", 0)
            vnew = counts.get("vouchers_new", 0)
            jnew = counts.get("journals_new", 0)
            lnew = counts.get("locations_new", 0)
            created = bool(counts.get("company_created"))
            # Advance the local master cursor to the CLOUD's confirmed watermark
            # (see _save_master_watermark: taking the cloud's number is what
            # makes a cloud-side reset re-fetch everything automatically).
            _save_master_watermark(cfg, cname, counts.get("master_alter_id") or 0)
            logger.info("Pull[%s]: company %s - %d masters-new, %d linked, %d updated, "
                        "%d vouchers, %d journals, %d locations",
                        cname, "CREATED in cloud" if created else "updated",
                        new, linked, updated, vnew, jnew, lnew)
            # ONE line, FOUND vs STORED, per module. The line above says what the
            # cloud accepted; it cannot say what Tally offered — so "0 stock
            # items" reads identically whether the company has none, the F11
            # inventory flag is off, or the read failed and was swallowed.
            # Printing both sides makes the difference obvious at a glance, which
            # is the whole question anyone opening the log is trying to answer.
            try:
                _stk_found = (len(stock.get("rows") or []) if isinstance(stock, dict)
                              else len(stock or []))
                _mst_found = sum(len(v or []) for v in (masters or {}).values())
                logger.info(
                    "SYNC[%s] | ledgers %d->%d new | stock %d->%d new | groups %d "
                    "| masters %d->%d upd | reports %d+%d | outstanding %d bills",
                    cname,
                    len(ledgers or []), counts.get("customers_new", 0) + counts.get("suppliers_new", 0),
                    _stk_found, counts.get("products_new", 0),
                    len(groups or []),
                    _mst_found, updated,
                    len([k for k, v in (freports or {}).items() if v]),
                    len(freports_by_year or {}),
                    len((outstandings or {}).get("rows") or []))
            except Exception:                               # noqa: BLE001
                pass    # a summary line must never break the sync it summarises
            # DEBUG: the cloud's per-type breakdown of what it accepted/skipped,
            # so a "Tally had data but the cloud stored nothing" case is obvious
            # (e.g. duplicates skipped, a mapping rejected). Toggle: log_level=DEBUG.
            logger.debug("Pull[%s]: cloud /agent/import accepted: customers_new=%s suppliers_new=%s "
                         "products_new=%s masters_updated=%s vouchers_new=%s journals_new=%s "
                         "locations_new=%s company_created=%s",
                         cname, counts.get("customers_new"), counts.get("suppliers_new"),
                         counts.get("products_new"), counts.get("masters_updated"),
                         counts.get("vouchers_new"), counts.get("journals_new"),
                         counts.get("locations_new"), counts.get("company_created"))
            if VERBOSE:
                tag = "company CREATED in cloud" if created else "company synced"
                echo(f"  '{cname}' - {tag}:")
                rows = counts.get("details") or []
                for d in rows:
                    act = str(d.get("action", ""))
                    mark = "[+]" if act == "created" else "[~]"
                    label = "new" if act == "created" else act
                    echo("    {0} {1} {2} {3}".format(
                        mark,
                        str(d.get("type", "")).ljust(9),
                        str(d.get("name", ""))[:34].ljust(34),
                        label,
                    ))
                if not rows:
                    echo("    (no changes - everything already in sync)")
                echo(f"  [OK] '{cname}': {new} new, {linked} linked, "
                     f"{updated} updated master(s), {vnew} voucher(s), "
                     f"{jnew} journal(s), {lnew} location(s).")
        except Exception as exc:
            logger.warning("Pull[%s]: import to cloud failed: %s", cname, exc)
            if VERBOSE:
                echo(f"  [x] '{cname}': cloud import failed ({exc})")

        # ── Vouchers: chunked, AlterID-INCREMENTAL backfill (separate from the
        #    masters import above). Best-effort - never aborts the pull. ──
        #
        #    RUNS BEFORE OUTSTANDINGS, and that order is the whole point. The
        #    outstanding report is per-party — one Tally round trip per ledger —
        #    so on a company with thousands of parties it can outlast the sync
        #    interval on its own. While it ran first, every cycle was spent
        #    there and this block was never reached: a live customer had 3,585
        #    ledgers mirrored and not one voucher, with an empty voucher
        #    watermark to prove the pull had never once completed.
        try:
            # Per-TYPE, diff-driven pull. Covers all 24 Tally voucher types
            # (orders, delivery/receipt notes, stock journals, job work, payroll)
            # that a single generic Voucher collection does not reliably return,
            # and self-heals gaps a forward-only watermark can never revisit.
            vsent = _pull_voucher_changes(cfg, logger, api, tally, token, cname)
            if vsent and VERBOSE:
                echo(f"  [OK] '{cname}': {vsent} voucher(s) pushed to cloud this cycle.")
        except TallyUnavailable:
            raise
        except Exception as exc:
            logger.warning("Voucher pull[%s] failed: %s", cname, exc)

        # ── Tally's OWN bill-wise outstanding — the independent check on the
        #    cloud's derived ageing. Read LAST, and only every Nth cycle: it is
        #    a per-ledger report (one request per party), by far the longest
        #    thing a cycle does, and outstanding balances do not move faster
        #    than the masters and vouchers that produce them.
        #
        #    Its own upload is a SECOND, outstandings-only import. The server
        #    replaces a side only when rows for that side arrived, so a post
        #    carrying nothing else cannot disturb the masters already stored
        #    (see AgentController.importFromTally). ──
        try:
            if _outstandings_due(cname):
                parties = tally.party_ledger_names(company=cname)
                # Progress, because silence here reads as a hang: the breadcrumb
                # in _send_once logs a distinct label once per run, and every
                # party carries the SAME label — so thousands of requests print
                # one line and then nothing for as long as they take.
                def _progress(done: int, total: int) -> None:
                    logger.info("Pull[%s]: outstanding %d/%d parties read.",
                                cname, done, total)

                outstandings = (tally.outstandings(company=cname, ledgers=parties,
                                                   on_progress=_progress)
                                if parties else {})
                if outstandings.get("failed"):
                    logger.warning("Pull[%s]: outstanding unreadable for %d ledger(s): %s",
                                   cname, len(outstandings["failed"]),
                                   ", ".join(outstandings["failed"][:5]))
                rows = (outstandings or {}).get("rows") or []
                if rows:
                    api.import_from_tally(token, [], [], company_name=cname,
                                          outstandings=outstandings)
                    logger.info("Pull[%s]: %d outstanding bill(s) uploaded.",
                                cname, len(rows))
        # TallySkipped FIRST: it subclasses TallyUnavailable, so the re-raise
        # below would catch it too — and did, live. The masters had just
        # uploaded when a quarantined outstandings report threw all the way out
        # of this function and ended the cycle with a traceback. A request we
        # deliberately did not send is the healthy case, not a failure.
        except TallySkipped as _sexc:
            logger.info("Pull[%s]: outstandings skipped: %s", cname, _sexc)
        except TallyUnavailable:
            raise
        except Exception as _oexc:                          # noqa: BLE001
            logger.warning("Pull[%s]: outstandings failed: %s", cname, _oexc)

        # ── DELETE detection. Periodic, not every cycle: it re-reads every
        #    master id, which is cheap but not free. Best-effort. ──
        try:
            _reconcile_pass(cfg, logger, api, tally, token, cname,
                            features=(cmaster or {}).get("features"))
        except Exception as exc:
            logger.warning("Reconcile[%s] failed: %s", cname, exc)


# ── Delete detection (reconcile) ─────────────────────────────────────────────
# Run every Nth pull cycle per company, not every cycle: a reconcile re-reads
# EVERY master id for the company. That is a small response (identity fields
# only) but still a full scan, and deletes are rare — hourly-ish is plenty.
RECONCILE_EVERY = 12
# Cycle counter per company name. Process-local by design: a restart simply
# reconciles on its first cycle, which is the safe direction to err in.
_reconcile_counter: dict[str, int] = {}

# ── Voucher sweep cadence ────────────────────────────────────────────────────
# The per-type id sweep is the same kind of full scan, and was the same mistake:
# it ran EVERY cycle. Measured on a 11,038-voucher company it read the complete
# {guid, alterid} list for all 24 voucher types — about 2.5 minutes of a 3
# minute cycle — to compare the same unchanged ids and discard them, once a
# minute, forever. TallyPrime was never idle and the Dashboard never stopped
# saying "Uploading".
#
# What actually carries new and edited vouchers to the cloud is the cheap
# AlterID-incremental pull, and that still runs every cycle. The sweep is kept
# for the two things only it can do — heal a window a forward-only watermark
# skipped, and notice deletes — which are not per-minute concerns. Same trade,
# same reasoning, as RECONCILE_EVERY above.
VOUCHER_SWEEP_EVERY = 12
_voucher_sweep_counter: dict[str, int] = {}

# ── Outstanding cadence ──────────────────────────────────────────────────────
# Same trade as RECONCILE_EVERY and VOUCHER_SWEEP_EVERY, for the most expensive
# scan of the three. Tally has no "every party's bills in one call" export, so
# the report costs ONE round trip per party; on the company this was found on
# that outlasted the whole sync interval, every cycle, forever — and because it
# ran first, nothing after it (vouchers included) ever got a turn.
#
# Outstanding is DERIVED from bills the masters/voucher passes already mirror
# every cycle, and the cloud computes its own figure from those. This report is
# the independent second opinion on that figure; a second opinion is worth a
# round trip per party occasionally, not once a minute.
OUTSTANDINGS_EVERY = 12
_outstandings_counter: dict[str, int] = {}


def _outstandings_due(cname: str) -> bool:
    """True when this cycle should read the per-party outstanding report.

    First cycle of a run always qualifies (n starts at 0), so a fresh install
    or a restart still gets the figure immediately rather than waiting.
    """
    n = _outstandings_counter.get(cname, 0)
    _outstandings_counter[cname] = n + 1
    return n % OUTSTANDINGS_EVERY == 0


def _pull_voucher_changes(cfg, logger, api, tally, token: str, cname: str) -> int:
    """Bring the cloud's vouchers up to date for one company.

    Cheap path every cycle; full sweep every VOUCHER_SWEEP_EVERY cycles (and
    always on the first cycle after a restart, so a fresh install does not wait
    to discover the history it has never seen).
    """
    n = _voucher_sweep_counter.get(cname, 0)
    _voucher_sweep_counter[cname] = n + 1
    if n % VOUCHER_SWEEP_EVERY == 0:
        return _pull_vouchers_by_type(cfg, logger, api, tally, token, cname)
    return _pull_vouchers(cfg, logger, api, tally, token, cname)


def _reconcile_pass(cfg, logger, api: ApiClient, tally: TallyConnector,
                    token: str, cname: str, features: "Optional[dict]" = None) -> None:
    """Tell the cloud which masters STILL EXIST in Tally, so it can delete the rest.

    Tally's XML API has no deletion feed: a deleted ledger just stops appearing
    in its collection. Without this pass a master deleted in Tally lived in the
    cloud forever, so the two could never actually match.

    For each master kind we read the complete live identity list and POST it to
    /agent/reconcile, which soft-deletes any Tally-sourced row whose identity is
    absent. Every step is guarded:

      • a read that raises is SKIPPED (never sent) — a failed read must not be
        mistaken for "Tally has nothing", which would delete the whole book;
      • an empty list is skipped for the same reason (the cloud also refuses it);
      • one kind failing does not stop the others.
    """
    if not token:
        return
    every = max(1, int(getattr(cfg, "reconcile_every", None) or RECONCILE_EVERY))
    n = _reconcile_counter.get(cname, 0)
    _reconcile_counter[cname] = n + 1
    if n % every != 0:
        return

    # Several kinds share one Tally collection (stock_item and stock_item_full
    # both read StockItem, into different cloud tables). Read each collection
    # ONCE per pass and reuse it — a reconcile is a full id scan, so paying for
    # it twice is the one avoidable cost here.
    by_collection: dict[str, list] = {}

    for kind, coll_type in TallyConnector.RECONCILE_TYPES.items():
        # The SAME F11 gate the master pull uses. Without it this loop asked a
        # payroll-less company for TSSRecEmployeeGroup and took TallyPrime down
        # — the crash the gate on the other side exists to prevent, just moved
        # here and made rarer (once every RECONCILE_EVERY cycles) and therefore
        # harder to trace.
        if not TallyConnector.feature_allows(kind, features):
            logger.debug("Reconcile[%s/%s]: skipped, the company does not "
                         "report that feature.", cname, kind)
            continue
        if coll_type not in by_collection:
            try:
                by_collection[coll_type] = tally.master_ids(kind, company=cname)
            except Exception as exc:
                logger.warning("Reconcile[%s/%s]: Tally read failed - skipping: %s",
                               cname, kind, exc)
                by_collection[coll_type] = None      # remembered as failed
        rows = by_collection[coll_type]
        if rows is None:
            continue
        if not rows:
            logger.warning("Reconcile[%s/%s]: Tally returned 0 masters - skipping "
                           "(treated as a failed read, not an empty company).", cname, kind)
            continue
        master_ids = [r["master_id"] for r in rows if r.get("master_id")]
        guids = [r["guid"] for r in rows if r.get("guid")]
        if not master_ids and not guids:
            logger.warning("Reconcile[%s/%s]: %d masters but NO identity fields - "
                           "skipping (this Tally build exposes neither GUID nor "
                           "MASTERID for this collection).", cname, kind, len(rows))
            continue
        try:
            out = api.reconcile(token, kind, master_ids, guids, company_name=cname)
        except Exception as exc:
            logger.warning("Reconcile[%s/%s]: cloud rejected: %s", cname, kind, exc)
            continue
        removed = out.get("deleted") or {}
        total = sum(int(v or 0) for v in removed.values())
        logger.info("Reconcile[%s/%s]: %d live in Tally, %d cloud row(s) marked deleted.",
                    cname, kind, len(rows), total)
        if total and VERBOSE:
            echo(f"  [-] '{cname}': {total} {kind}(s) deleted in Tally -> removed from cloud.")


# ── Voucher pull by TYPE, driven by an id diff ───────────────────────────────
# Vouchers are fetched one voucher TYPE at a time. A single unfiltered Voucher
# collection does not reliably return the order and inventory-only documents
# (Sales Order, Delivery Note, Stock Journal, Job Work, Material In/Out), so a
# generic pull can look healthy while missing whole categories — which is
# exactly what a company's books looked like before this: 8 types present out of
# the 24 Tally defines.
#
# Within a type we DIFF rather than walk a watermark. A watermark only moves
# forward, so any window skipped once (Tally stalls, the agent is killed
# mid-cycle, the cursor is bumped past a gap) is never revisited and nothing
# reports it. Comparing the live id list against the cloud's finds those holes
# however old they are — and finds deletions in the same pass.
VOUCHER_FETCH_BATCH = 200      # vouchers fetched per by-GUID request (filter is
                               # one OR term per guid — long formulae are slow
                               # and upset Tally)
VOUCHER_DIFF_MAX_IDS = 20000   # must match the cloud's cap; a bigger sweep is
                               # paged instead of truncated
VOUCHER_TYPES_PER_CYCLE = 0    # 0 = every type each cycle. The id sweep is
                               # identity-only and cheap; raise this to a small
                               # number only if a very large book needs pacing.


def _pull_vouchers_by_type(cfg, logger, api: ApiClient, tally: TallyConnector,
                           token: str, cname: str) -> int:
    """Tally -> Cloud voucher sync, per voucher type, driven by an id diff.

    For each voucher type defined in the company:
      1. read the live ``{guid, alterid}`` list from Tally (identity only);
      2. ask the cloud which of those it is missing or holds a stale AlterID for;
      3. fetch exactly those vouchers in full and import them;
      4. when the whole type was swept, let the cloud soft-delete the vouchers
         it holds that Tally no longer lists.

    Best-effort per type: one type failing must not cost the company the rest.
    Returns the number of vouchers imported.
    """
    if not token:
        return 0

    try:
        vtypes = tally.voucher_type_names(company=cname)
    except TallyUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("Voucher pull[%s]: could not list voucher types: %s", cname, exc)
        return 0

    total = 0
    for vt in vtypes:
        try:
            ids = tally.voucher_ids(company=cname, vtype=vt)
        except TallyUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("Voucher pull[%s/%s]: id sweep failed: %s", cname, vt, exc)
            continue
        if not ids:
            continue          # this company raises none of this type — normal

        # Page the diff when a type is huge. Only the FINAL page may carry
        # complete=True, or the cloud would delete everything not in page one.
        pages = [ids[i:i + VOUCHER_DIFF_MAX_IDS]
                 for i in range(0, len(ids), VOUCHER_DIFF_MAX_IDS)]
        missing: list[str] = []
        swept_all = True
        for pi, page in enumerate(pages):
            try:
                out = api.voucher_diff(
                    token, vt,
                    [{"guid": r["guid"], "alterid": r["alterid"]} for r in page],
                    # A paged sweep can only be complete on its last page, and
                    # only if every earlier page succeeded.
                    complete=(pi == len(pages) - 1 and swept_all and len(pages) == 1),
                    company_name=cname,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Voucher pull[%s/%s]: diff page %d rejected: %s",
                               cname, vt, pi + 1, exc)
                swept_all = False
                continue
            missing.extend(out.get("missing") or [])
            if out.get("deleted"):
                logger.info("Voucher pull[%s/%s]: %s deleted in Tally -> removed from cloud.",
                            cname, vt, out["deleted"])

        if not missing:
            continue

        logger.info("Voucher pull[%s/%s]: %d live, %d to fetch.",
                    cname, vt, len(ids), len(missing))
        if VERBOSE:
            echo(f"  [..] '{cname}' {vt}: {len(missing)} voucher(s) to fetch.")

        for i in range(0, len(missing), VOUCHER_FETCH_BATCH):
            batch = missing[i:i + VOUCHER_FETCH_BATCH]
            try:
                vouchers = tally.vouchers_by_guid(batch, company=cname)
            except TallyUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Voucher pull[%s/%s]: fetch failed: %s", cname, vt, exc)
                break        # retry this type next cycle; the diff is stateless
            if not vouchers:
                continue
            try:
                api.import_from_tally(token, [], [], vouchers, [], company_name=cname)
                total += len(vouchers)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Voucher pull[%s/%s]: import failed: %s", cname, vt, exc)
                break

    return total


VOUCHER_STATE_FILENAME = ".voucher_sync.json"
VOUCHER_CHUNK = 2000         # DEFAULT AlterID window per Tally fetch (config.ini
                             # [agent] voucher_chunk overrides). SMALL on purpose:
                             # a big window pulls thousands of full double-entry
                             # vouchers in one COLLECTION → Tally "memory access
                             # violation" crash. 2000 keeps each response safe.
VOUCHER_BATCH = 2000         # MAX vouchers per cloud /agent/import POST (a ceiling,
                             # not the usual batch size — see VOUCHER_BATCH_BYTES).
# Vouchers are batched by BYTES as well as by count, because count alone does not
# bound the request. A cash receipt is a few hundred bytes; a sales invoice with
# 60 stock lines, batch/godown allocations, bill references and GST details is
# tens of KB. 2000 of the first is a small POST, 2000 of the second is not — and
# the cloud rejects the body at 50 MB, so the whole AlterID window fails, retries
# next cycle, fails again, and that company's backfill never advances. Nothing
# logs "too big"; it just stops making progress.
#
# 8 MB leaves generous room under the 50 MB server limit for JSON overhead and
# any proxy in between, and still sends thousands of ordinary vouchers per POST.
VOUCHER_BATCH_BYTES = 8 * 1024 * 1024
# A single voucher larger than this is sent alone rather than skipped: it will
# probably still be accepted, and dropping a real voucher to protect a batch is
# the wrong trade. It is logged, because it is worth knowing about.
VOUCHER_HUGE_BYTES = 4 * 1024 * 1024
VOUCHER_MAX_FETCHES = 30     # DEFAULT AlterID windows per cycle (cfg overrides);
                             # more, smaller windows keep the same backfill pace.
# If the backfill scans this far and finds NO voucher at all (max_seen == 0), the
# cursor likely overran the data while Tally was still loading (cold start) or the
# cloud was reset — re-scan from AlterID 0 ONCE so the vouchers are actually found
# instead of climbing empty high windows forever.
VOUCHER_RESCAN_CEILING = 300000
_voucher_rescan_done = set()     # companies already re-scanned this session (no loop)


def _size_batches(items: list, max_count: int, max_bytes: int,
                  huge_bytes: int = 0, logger=None) -> "list[list]":
    """Split ``items`` into POST-sized batches by BOTH count and encoded bytes.

    Yields the same items in the same order — this only decides where the cuts
    go. An item bigger than ``max_bytes`` on its own becomes its own batch
    rather than being dropped: a voucher we refuse to send is a voucher the
    cloud never has, which is worse than a large request that probably succeeds.

    Measuring costs one json.dumps per item. That is cheap next to the HTTP
    round trip it is protecting, and it is the only way to know the size of a
    voucher whose weight lives in its allocation lists.
    """
    batches: list[list] = []
    current: list = []
    current_bytes = 0
    for item in items:
        try:
            n = len(json.dumps(item, default=str).encode("utf-8"))
        except Exception:                                 # noqa: BLE001
            n = 4096                                      # unmeasurable: assume typical
        if huge_bytes and n > huge_bytes and logger:
            logger.warning("Voucher %s is %.1f MB on its own — sending it alone.",
                           (item or {}).get("guid", "?") if isinstance(item, dict) else "?",
                           n / 1024 / 1024)
        # Start a new batch when this item would push us over either limit —
        # unless the batch is empty, in which case the item goes alone.
        if current and (len(current) >= max_count or current_bytes + n > max_bytes):
            batches.append(current)
            current, current_bytes = [], 0
        current.append(item)
        current_bytes += n
    if current:
        batches.append(current)
    return batches


def _voucher_state_path(cfg: Config) -> str:
    return os.path.join(_agent_dir(cfg), VOUCHER_STATE_FILENAME)


def _load_voucher_state(cfg: Config, company: str) -> dict:
    """Per-company voucher watermark {through, max_seen}. Never raises."""
    try:
        with open(_voucher_state_path(cfg), "r", encoding="utf-8") as fh:
            allst = json.load(fh) or {}
    except Exception:
        allst = {}
    st = allst.get(company) or {}
    return {"through": int(st.get("through", 0) or 0),
            "max_seen": int(st.get("max_seen", 0) or 0)}


def _save_voucher_state(cfg: Config, company: str, st: dict) -> None:
    try:
        path = _voucher_state_path(cfg)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                allst = json.load(fh) or {}
        except Exception:
            allst = {}
        allst[company] = {"through": int(st.get("through", 0) or 0),
                          "max_seen": int(st.get("max_seen", 0) or 0)}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(allst, fh)
    except Exception:
        pass


# Master watermark lives in the SAME state file under a reserved key, so a
# manual "Sync from Tally" (which deletes the file) clears both cursors at once.
# A company can never be named "__masters__" in Tally, so there is no collision.
_MASTER_STATE_KEY = "__masters__"


def _load_master_watermark(cfg: Config, company: str) -> int:
    """Highest master AlterID the CLOUD has confirmed for this company.

    Used as the `$AlterID >` filter on every master collection, so each cycle
    reads only what changed instead of the whole master book. Never raises;
    0 (= fetch everything) is always the safe answer.
    """
    try:
        with open(_voucher_state_path(cfg), "r", encoding="utf-8") as fh:
            allst = json.load(fh) or {}
        return int((allst.get(_MASTER_STATE_KEY) or {}).get(company, 0) or 0)
    except Exception:
        return 0


def _save_master_watermark(cfg: Config, company: str, alterid: int) -> None:
    """Record the watermark the CLOUD reported (not one we computed).

    Taking the cloud's number makes this self-healing: if the cloud's state is
    reset (a wiped tenant, a manual re-sync), it reports 0 and the next cycle
    automatically re-fetches every master. An agent-side counter would instead
    keep filtering them out and the cloud would stay permanently empty.
    """
    try:
        path = _voucher_state_path(cfg)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                allst = json.load(fh) or {}
        except Exception:
            allst = {}
        allst.setdefault(_MASTER_STATE_KEY, {})[company] = int(alterid or 0)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(allst, fh)
    except Exception:
        pass


def _reset_all_voucher_state(cfg: Config, logger=None) -> None:
    """Wipe the LOCAL voucher watermark(s) so the next pull re-scans every
    company's vouchers from AlterID 0. A manual 'Sync from Tally' (and the cloud
    reset) only clear the MASTERS watermark cloud-side; vouchers keep their own
    local cursor, which must be cleared too or they never re-import."""
    try:
        path = _voucher_state_path(cfg)
        if os.path.exists(path):
            os.remove(path)
        _voucher_rescan_done.clear()
        if logger:
            logger.info("Manual pull: voucher watermark cleared — re-scanning vouchers from AlterID 0.")
    except Exception:
        pass


def _pull_vouchers(cfg, logger, api, tally, token, cname) -> int:
    """Tally -> Cloud VOUCHER backfill, chunked + AlterID-incremental.

    Reads vouchers via an AlterID-windowed Voucher COLLECTION (each carries GUID +
    ALTERID). A local per-company watermark {through, max_seen} drives it: each
    cycle pull the next few AlterID windows above `through` and POST each window's
    vouchers to the cloud in batches. First runs fill the whole history a few
    windows per cycle; once we scan a window PAST the highest voucher seen
    (caught up), `through` parks at max_seen so later cycles fetch ONLY new/changed
    vouchers (their AlterID climbs above max_seen). Best-effort: any read/import
    error stops THIS cycle and resumes next cycle from the saved watermark (the
    cloud dedupes by GUID, so re-pulling a window is harmless).
    """
    if not token:
        return 0
    st = _load_voucher_state(cfg, cname)
    through = st["through"]
    max_seen = st["max_seen"]
    sent = 0
    # Window size + count come from config (safe small defaults) so a busy book
    # can be tuned WITHOUT a rebuild and Tally never gets a huge COLLECTION.
    chunk = getattr(cfg, "voucher_chunk", VOUCHER_CHUNK) or VOUCHER_CHUNK
    fetches = getattr(cfg, "voucher_max_fetches", VOUCHER_MAX_FETCHES) or VOUCHER_MAX_FETCHES
    for _ in range(fetches):
        lo, hi = through, through + chunk
        try:
            vs = tally.voucher_list(company=cname, after_alterid=lo, upto_alterid=hi)
        except Exception as exc:
            logger.warning("Voucher pull[%s] %d-%d read failed: %s", cname, lo, hi, exc)
            break
        if vs:
            ok = True
            # By bytes as well as count: 2000 line-heavy invoices is a body the
            # cloud rejects outright, and a rejected window never advances.
            batches = _size_batches(vs, VOUCHER_BATCH, VOUCHER_BATCH_BYTES,
                                    VOUCHER_HUGE_BYTES, logger)
            for bno, batch in enumerate(batches, 1):
                try:
                    c = api.import_from_tally(token, [], [], batch, [], company_name=cname)
                    sent += len(batch)
                    logger.debug("Voucher pull[%s] %d-%d: batch %d/%d, %d vouchers "
                                 "sent (cloud new=%s)", cname, lo, hi, bno,
                                 len(batches), len(batch), (c or {}).get("vouchers_new"))
                except Exception as exc:
                    logger.warning("Voucher import[%s] %d-%d failed on batch %d/%d "
                                   "(%d vouchers): %s", cname, lo, hi, bno,
                                   len(batches), len(batch), exc)
                    ok = False
                    break
            if not ok:
                break   # keep `through` so this window retries next cycle
            mx = max((int(v.get("alterid") or 0) for v in vs), default=0)
            if mx > max_seen:
                max_seen = mx
            logger.info("Voucher pull[%s] window %d-%d: %d vouchers -> cloud; max_seen=%d",
                        cname, lo, hi, len(vs), max_seen)
            through = hi
        else:
            # Empty window. Past the highest voucher seen => backfill complete;
            # park `through` at max_seen so the next cycle re-checks just above it
            # for new vouchers. Otherwise a mid-range gap / nothing yet => scan on.
            if max_seen > 0 and lo >= max_seen:
                _save_voucher_state(cfg, cname, {"through": max_seen, "max_seen": max_seen})
                logger.info("Voucher pull[%s]: caught up at alterid %d (incremental now).",
                            cname, max_seen)
                return sent
            # Scanned a long stretch with NO voucher found at all (max_seen == 0):
            # the cursor likely overran the data while Tally was still loading, or
            # the cloud was reset. Re-scan from 0 ONCE this session so the vouchers
            # are actually found (a genuinely high-alterid company then scans on
            # past the ceiling normally — the flag stops an endless reset loop).
            if max_seen == 0 and hi >= VOUCHER_RESCAN_CEILING and cname not in _voucher_rescan_done:
                _voucher_rescan_done.add(cname)
                _save_voucher_state(cfg, cname, {"through": 0, "max_seen": 0})
                logger.info("Voucher pull[%s]: no voucher up to AlterID %d — resetting to 0 "
                            "to re-scan (Tally may have been loading).", cname, hi)
                return sent
            through = hi
        _save_voucher_state(cfg, cname, {"through": through, "max_seen": max_seen})
    logger.info("Voucher pull[%s]: backfill at alterid %d (max_seen=%d); continues next cycle.",
                cname, through, max_seen)
    return sent


def _tally_url(cfg: Config) -> str:
    """Resolve the Tally HTTP endpoint (config [tally] tally_url, default 9000)."""
    return cfg.tally_url or "http://localhost:9000"


# Usual TallyPrime / Tally.ERP9 install locations, newest first. The agent
# probes these when [tally] tally_exe is not set explicitly.
_TALLY_EXE_CANDIDATES = (
    r"C:\Program Files\TallyPrime\tally.exe",
    r"C:\Program Files (x86)\TallyPrime\tally.exe",
    r"C:\TallyPrime\tally.exe",
    r"C:\Program Files\Tally.ERP9\tally.exe",
    r"C:\Program Files (x86)\Tally.ERP9\tally.exe",
    r"C:\Tally.ERP9\tally.exe",
)


def _tally_exe_from_registry() -> Optional[str]:
    """Best-effort: read tally.exe's path from the Windows registry (App Paths).

    Lets auto-start work even for non-standard install folders without the user
    setting [tally] tally_exe. Windows-only; any failure just returns None.
    """
    if os.name != "nt":
        return None
    try:
        import winreg  # type: ignore
    except Exception:
        return None
    keys = (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\tally.exe"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\tally.exe"),
        (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\tally.exe"),
    )
    for hive, key in keys:
        try:
            with winreg.OpenKey(hive, key) as handle:
                val, _ = winreg.QueryValueEx(handle, None)  # default value = full exe path
                if val and os.path.isfile(val):
                    return val
        except OSError:
            continue
    return None


def _find_tally_exe(cfg: Config) -> Optional[str]:
    """Return the TallyPrime executable path: config override -> known install
    folders -> Windows registry (App Paths). None if it can't be located."""
    if cfg.tally_exe and os.path.isfile(cfg.tally_exe):
        return cfg.tally_exe
    for path in _TALLY_EXE_CANDIDATES:
        if os.path.isfile(path):
            return path
    return _tally_exe_from_registry()


def _ensure_all_companies_loaded(cfg, logger, exe) -> list:
    """Make Tally auto-load ALL its companies on the next startup.

    Reads the company folders (numeric) from Tally's data directory (the Data=
    line in tally.ini) and writes them all into the tally.ini Load= line, so that
    when the agent launches Tally EVERY company loads and gets synced - fully
    hands-free multi-company sync (the operator never opens companies manually).
    Best-effort; never raises. Returns the company numbers it set (or []).
    """
    try:
        ini = os.path.join(os.path.dirname(exe), "tally.ini")
        if not os.path.isfile(ini):
            return []
        with open(ini, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
        data_path = None
        for ln in lines:
            m = re.match(r"\s*Data\s*=\s*(.+?)\s*$", ln, re.I)
            if m:
                data_path = m.group(1).strip()
                break
        if not data_path or not os.path.isdir(data_path):
            return []
        nums = sorted(d for d in os.listdir(data_path)
                      if d.isdigit() and os.path.isdir(os.path.join(data_path, d)))
        if not nums:
            return []
        load_val = ",".join(nums)
        out, seen = [], False
        for ln in lines:
            if re.match(r"\s*Load\s*=", ln, re.I):
                out.append("Load=" + load_val + "\n")
                seen = True
            else:
                out.append(ln)
        if not seen:
            out.append("Load=" + load_val + "\n")
        if "".join(out) != "".join(lines):      # only rewrite on a real change
            with open(ini, "w", encoding="utf-8") as fh:
                fh.writelines(out)
            logger.info("tally.ini: set Load=%s (auto-load all %d companies).", load_val, len(nums))
            if VERBOSE:
                echo(f"  [..] Configured Tally to auto-load all {len(nums)} company(ies).")
        return nums
    except Exception as exc:                    # never break the loop over a config write
        logger.warning("Could not configure tally.ini auto-load: %s", exc)
        return []


def _start_tally(cfg: Config, logger) -> bool:
    """Launch TallyPrime if it is installed, then wait for its gateway (:9000).

    Tally only serves its XML API while the app is open, so when it is down the
    agent starts it (config [tally] auto_start, default on) and polls until the
    port answers - up to ~60s. Returns True once Tally is reachable. Best-effort
    and never raises (a missing exe / launch error is logged + returns False).
    Windows-only in practice; on other OSes it just reports the exe wasn't found.
    """
    exe = _find_tally_exe(cfg)
    if not exe:
        logger.warning(
            "Auto-start: TallyPrime executable not found. Set [tally] tally_exe in "
            "config.ini to its full path (e.g. C:\\Program Files\\TallyPrime\\tally.exe)."
        )
        if VERBOSE:
            echo("  [x] TallyPrime not found. Set [tally] tally_exe in config.ini "
                 "to tally.exe's full path.")
        return False

    # Make the about-to-launch Tally auto-load EVERY company (hands-free).
    _ensure_all_companies_loaded(cfg, logger, exe)

    logger.info("Auto-start: launching Tally - %s", exe)
    if VERBOSE:
        echo(f"  [..] Launching TallyPrime: {exe}")
    try:
        # Detached so Tally keeps running independently of the agent process.
        flags = 0x00000008 if os.name == "nt" else 0  # DETACHED_PROCESS
        subprocess.Popen([exe], cwd=os.path.dirname(exe) or None, close_fds=True,
                         creationflags=flags)
    except Exception as exc:  # launch failure must not kill the loop.
        logger.warning("Auto-start: failed to launch Tally: %s", exc)
        if VERBOSE:
            echo(f"  [x] Failed to launch Tally: {exc}")
        return False

    if VERBOSE:
        echo("  [..] Waiting for the Tally gateway (:9000) to come up "
             "(up to ~60s)...")
    # Poll the gateway - Tally + its company take a little while to come up.
    tally = TallyConnector(_tally_url(cfg), logger)
    for attempt in range(30):           # 30 x 2s ~ 60s
        time.sleep(2)
        try:
            if tally.is_available():
                logger.info("Auto-start: Tally is up and reachable.")
                if VERBOSE:
                    echo("  [OK] Tally is up and reachable.")
                return True
        except Exception:
            pass
        if VERBOSE and (attempt + 1) % 5 == 0:
            echo(f"  [..] still waiting... ({(attempt + 1) * 2}s)")
    logger.warning(
        "Auto-start: launched Tally but the gateway (:9000) did not respond in time. "
        "Open the company + enable Gateway > F1 > Connectivity (port 9000)."
    )
    if VERBOSE:
        echo("  [!] Launched Tally but :9000 did not respond in time. Open the "
             "company and enable Gateway > F1 > Connectivity (port 9000).")
    return False


# --------------------------------------------------------------------------- #
# Self-update (Requirement 2) — Windows-safe swap of a running one-file exe.
# --------------------------------------------------------------------------- #
# The agent name on disk (matches build_exe.APP_NAME). The Startup VBS that
# launches it hidden (install-autostart.ps1) uses the same base name.
# IDENTITY — built from brand.SLUG, the same constant build_exe.py names the
# exe from and gui_agent/win_service build the install dir, registry key and
# service name from. A slug change is a reinstall (an install made by an older
# build keeps its old filenames and is not adopted), never a silent rename.
from brand import CONSOLE_EXE_NAME as _CONSOLE_EXE, SLUG as _SLUG

_EXE_BASENAME = f"{_CONSOLE_EXE}.exe"
_NEW_EXE_BASENAME = f"{_CONSOLE_EXE}.new.exe"
_UPDATER_BAT = "_agent_update.bat"
_STARTUP_VBS = f"{_CONSOLE_EXE}.vbs"


def _version_tuple(v: str) -> tuple:
    """Parse a version string into a comparable tuple of ints.

    "1.2.10" -> (1, 2, 10). Non-numeric / missing parts are treated as 0 and a
    trailing non-numeric suffix (e.g. "1.2.0-beta") is ignored on each part, so
    a junk value never raises (it just compares low).
    """
    parts = []
    for chunk in str(v or "").strip().split("."):
        m = re.match(r"\d+", chunk)
        parts.append(int(m.group(0)) if m else 0)
    return tuple(parts) if parts else (0,)


def _sync_is_enabled(cfg: Config) -> bool:
    """Is syncing switched on, according to config.ini RIGHT NOW?

    Deliberately re-reads the file. The Dashboard and the Windows service are
    different processes, so the ``cfg`` object this loop holds cannot see a
    Start/Stop pressed in the GUI — only the file changes. Re-reading is a few
    hundred bytes once per cycle.

    Any read problem answers True: a config we cannot parse must not leave a
    customer silently un-synced.
    """
    try:
        path = getattr(cfg, "path", None) or getattr(cfg, "_path", None)
        if not path:
            return bool(getattr(cfg, "sync_enabled", True))
        fresh = Config.load(path)
        return bool(getattr(fresh, "sync_enabled", True))
    except Exception:                                       # noqa: BLE001
        return True


def _report_years_for(cfg, cmaster, logger=None) -> int:
    """How many financial years of reports to pull for THIS company.

    ``cfg.report_years`` is a manual pin; 0 (the default) means "as many as the
    company actually has books for", derived from its own BOOKSFROM /
    STARTINGFROM date.

    WHY THIS IS NOT A CONSTANT: it used to be 2, so the cloud held this year and
    last for every customer regardless of how much history Tally had. A book
    that began in 2016 synced 2 of its 10 years, and the missing eight looked
    identical to eight empty ones — no screen, log line or reconciliation could
    tell the difference. Deriving it means the default is "everything", and the
    only companies that pull two years are the ones that only have two.

    Defensive on every input: a missing company master, an unparseable or absurd
    BOOKSFROM (Tally will hand back 1900 dates), or a future date all fall back
    to a sane span rather than either 0 years (silently syncing nothing) or a
    thousand round trips.
    """
    pinned = int(getattr(cfg, "report_years", 0) or 0)
    if pinned > 0:
        return pinned

    from config import _DEFAULT_REPORT_YEARS, _MAX_REPORT_YEARS   # noqa: PLC0415
    fallback = _DEFAULT_REPORT_YEARS if _DEFAULT_REPORT_YEARS > 0 else 2

    books_from = ""
    if isinstance(cmaster, dict):
        books_from = str(cmaster.get("books_from") or "").strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", books_from)
    if not m:
        if logger and books_from:
            logger.debug("Report years: unparseable books_from %r; using %d.",
                         books_from, fallback)
        return fallback

    start_year, start_month = int(m.group(1)), int(m.group(2))
    # Indian FY runs Apr-Mar: books opened in Jan 2016 belong to FY 2015-16.
    books_fy = start_year if start_month >= 4 else start_year - 1

    today = datetime.date.today()
    current_fy = today.year if today.month >= 4 else today.year - 1

    years = current_fy - books_fy + 1
    if years < 1:
        # BOOKSFROM in the future — a company created ahead of its year, or a
        # junk date. One year (the current one) is the only honest answer.
        return 1
    if years > _MAX_REPORT_YEARS:
        if logger:
            logger.warning("Report years: books_from %s implies %d years; "
                           "capping at %d.", books_from, years, _MAX_REPORT_YEARS)
        return _MAX_REPORT_YEARS
    return years


def _is_newer(latest: str, installed: str) -> bool:
    """Return True iff ``latest`` is a strictly newer version than ``installed``.

    Tuple/semantic compare (1.10.0 > 1.9.9). Empty/None latest -> False (nothing
    to do). A malformed value compares as (0,) so we never update toward junk.
    """
    if not latest:
        return False
    return _version_tuple(latest) > _version_tuple(installed)


def _running_frozen() -> bool:
    """True when running as the PyInstaller one-file exe (not as a .py)."""
    return bool(getattr(sys, "frozen", False))


def _exe_path() -> str:
    """Absolute path of the currently-running executable (the frozen exe)."""
    return os.path.abspath(sys.executable)


def _spawn_updater_bat(exe_dir: str, logger, exe_path: Optional[str] = None) -> bool:
    """Write + launch the detached updater batch that swaps in the new exe.

    The batch (``_agent_update.bat``) waits until the live exe is no longer
    locked (we are about to exit), moves the downloaded ``*.new.exe`` over it,
    relaunches it HIDDEN via the Startup VBS if present (else ``start ""`` the
    exe), and deletes itself. Launched DETACHED with no window so it survives
    this process exiting. Returns True if the bat was launched.

    ``exe_path`` is the ACTUAL running executable (``sys.executable``); the swap
    targets that exact file so a renamed exe is still replaced in place (we fall
    back to the conventional name only if it is not supplied).

    NEVER deletes the old exe before the new one is moved into place; if the
    move fails the old exe stays untouched and the agent keeps running.
    """
    exe = exe_path or os.path.join(exe_dir, _EXE_BASENAME)
    new_exe = os.path.join(exe_dir, _NEW_EXE_BASENAME)
    bat = os.path.join(exe_dir, _UPDATER_BAT)

    # The Startup VBS (written by install-autostart.ps1) runs the exe hidden.
    startup_dir = os.path.join(
        os.environ.get("APPDATA", ""),
        "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
    )
    vbs = os.path.join(startup_dir, _STARTUP_VBS)

    # Batch script. Loops (with a ping-based ~1s delay, no extra deps) until the
    # rename of the live exe succeeds (i.e. the old process has released it),
    # up to ~30 tries, then relaunches hidden and self-deletes. ASCII only.
    lines = [
        "@echo off",
        "setlocal",
        'set "EXE=' + exe + '"',
        'set "NEW=' + new_exe + '"',
        'set "VBS=' + vbs + '"',
        "rem Stop the Windows SERVICE (if installed) so it RELEASES its exe lock;",
        "rem a harmless no-op for a portable/GUI install (service simply not found).",
        'net stop "' + _SLUG + '" >nul 2>&1',
        "rem Wait for the running agent to exit and release its exe.",
        "set /a tries=0",
        ":waitloop",
        'if not exist "%NEW%" goto done',
        'move /Y "%NEW%" "%EXE%" >nul 2>&1',
        "if %errorlevel%==0 goto relaunch",
        "set /a tries+=1",
        "if %tries% geq 30 goto giveup",
        "ping -n 2 127.0.0.1 >nul",
        "goto waitloop",
        ":relaunch",
        "rem Prefer restarting the SERVICE (errorlevel 0 = it was started); else",
        "rem fall back to launching the portable exe hidden via the Startup VBS.",
        'net start "' + _SLUG + '" >nul 2>&1',
        "if %errorlevel%==0 goto cleanup",
        'if exist "%VBS%" (',
        '  start "" wscript.exe "%VBS%"',
        ") else (",
        '  start "" "%EXE%"',
        ")",
        "goto cleanup",
        ":giveup",
        "rem Could not replace the exe (lock never released). Drop the staged",
        "rem update and RELAUNCH the old exe so the agent is not left down.",
        'if exist "%NEW%" del /F /Q "%NEW%" >nul 2>&1',
        'net start "' + _SLUG + '" >nul 2>&1',
        "if %errorlevel%==0 goto cleanup",
        'if exist "%VBS%" (',
        '  start "" wscript.exe "%VBS%"',
        ") else (",
        '  start "" "%EXE%"',
        ")",
        ":cleanup",
        ":done",
        'del /F /Q "%~f0" >nul 2>&1',
    ]
    try:
        with open(bat, "w", encoding="ascii", errors="replace") as fh:
            fh.write("\r\n".join(lines) + "\r\n")
    except OSError as exc:
        logger.error("Self-update: could not write updater batch: %s", exc)
        return False

    # Launch DETACHED with no window so it outlives this process.
    try:
        flags = 0
        if os.name == "nt":
            # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
            flags = 0x00000008 | 0x00000200 | 0x08000000
        subprocess.Popen(
            ["cmd.exe", "/c", bat],
            cwd=exe_dir, close_fds=True, creationflags=flags,
        )
    except Exception as exc:  # launching the bat must not crash the agent.
        logger.error("Self-update: could not launch updater batch: %s", exc)
        return False

    logger.info("Self-update: updater batch launched (%s).", bat)
    return True


def _effective_auto_update(cfg: Config, info: dict) -> bool:
    """Decide if updating is allowed: the CLOUD toggle wins when provided.

    ``info`` is the /agent/version response. When it carries ``auto_update``
    (the per-license toggle) we honour that; otherwise fall back to the local
    config ``auto_update``. A MANDATORY release overrides both (handled by the
    caller) so a security fix always lands.
    """
    if isinstance(info, dict) and ("auto_update" in info) and (info.get("auto_update") is not None):
        return bool(info.get("auto_update"))
    return bool(cfg.auto_update)


def maybe_self_update(cfg: Config, logger, api: ApiClient,
                      *, forced: bool = False) -> None:
    """Check for a newer published exe and, if appropriate, self-update.

    BEST-EFFORT: every step is wrapped so this can NEVER crash the main loop. It
    runs once at startup and every ``cfg.update_check_cycles`` cycles (and on a
    forced 'self_update' command). Flow:

      1. Ask the cloud (``/agent/version``) for the latest version + flags.
      2. If latest is set and NEWER than cfg.agent_version, and updating is
         allowed (cloud toggle if provided else config; a MANDATORY release
         overrides the toggle), proceed — else log + return.
      3. Interactive + confirm_updates on -> prompt; headless -> apply.
      4. Only when FROZEN (running as the exe): download to ``*.new.exe``, verify
         sha/size, write + launch the detached updater bat, then ``sys.exit(0)``
         so the bat can replace the live file. Running as .py just logs.

    On ANY failure before exit we abort and keep running the OLD version.
    """
    token = cfg.get_token()
    if not token:
        return
    try:
        info = api.get_latest_version(token, installed_version=cfg.agent_version)
    except Exception as exc:  # get_latest_version already swallows, be defensive.
        logger.debug("Self-update: version check failed: %s", exc)
        return
    if not isinstance(info, dict) or not info:
        return

    latest = str(info.get("latest_version") or "").strip()
    mandatory = bool(info.get("mandatory"))
    sha256 = info.get("sha256") or None

    if not _is_newer(latest, cfg.agent_version):
        logger.debug("Self-update: up to date (installed=%s, latest=%s).",
                     cfg.agent_version, latest or "none")
        return

    allowed = _effective_auto_update(cfg, info) or mandatory or forced
    if not allowed:
        logger.info("Self-update: v%s available but auto-update is OFF; skipping.", latest)
        echo(f"[update] v{latest} available (auto-update is OFF).")
        return

    logger.info("Self-update: newer version v%s available (installed v%s, mandatory=%s).",
                latest, cfg.agent_version, mandatory)
    echo(f"[update] New agent version v{latest} available.")

    # Interactive confirm (only with a real terminal + confirm_updates on, and
    # never for a mandatory release — security fixes always apply).
    if (not forced) and (not mandatory) and cfg.confirm_updates and _stdin_is_tty():
        try:
            ans = input(f"  Update to v{latest} now? [Y/n]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            ans = "n"
        if ans in ("n", "no"):
            logger.info("Self-update: declined by operator.")
            echo("[update] Skipped (you can update later).")
            return

    # Only the FROZEN exe can swap itself; a .py run just reports.
    if not _running_frozen():
        logger.info("Self-update: running from source - rebuild the exe to v%s "
                    "(no swap when not frozen).", latest)
        echo(f"[update] Running from source; rebuild the exe for v{latest}.")
        return

    exe_path = _exe_path()
    exe_dir = os.path.dirname(exe_path)
    new_exe = os.path.join(exe_dir, _NEW_EXE_BASENAME)

    echo(f"[update] Downloading v{latest} ...")
    try:
        ok = api.download_update(token, new_exe, expected_sha256=sha256)
    except Exception as exc:  # download already swallows, be defensive.
        logger.error("Self-update: download error: %s", exc)
        ok = False
    if not ok:
        logger.warning("Self-update: download/verify failed; keeping current version.")
        echo("[update] Download failed; staying on the current version.")
        return

    # Sanity: the new exe must exist + be non-empty before we hand off.
    try:
        if (not os.path.isfile(new_exe)) or os.path.getsize(new_exe) <= 0:
            logger.warning("Self-update: downloaded exe missing/empty; aborting.")
            return
    except OSError:
        return

    # ── AUTHENTICODE GATE ────────────────────────────────────────────────
    # The SHA-256 checked during download came from the SAME server that served
    # the file, so it proves the transfer was intact — not that the file is
    # ours. A server with a foothold would happily publish a matching hash for a
    # hostile binary, and the agent would install it with SYSTEM privileges.
    #
    # The signature is the check the server cannot forge: the signing key lives
    # on a token/HSM the server has never held. We require BOTH a valid chain
    # AND our publisher CN — "validly signed" alone only proves the attacker
    # bought a certificate.
    #
    # Skipped only when this build is itself unsigned (a dev/self-hosted build):
    # enforcing it there would brick self-update for anyone running an unsigned
    # agent, while enforcing it for signed agents is exactly where it matters.
    try:
        import codesign
        # "Is this build signed at all?" — thumbprint when we pin one (a
        # self-signed release), chain validation otherwise. An unsigned dev
        # build skips the gate entirely, which is the only way to keep
        # self-update working for anyone running one.
        _signed = bool(codesign.signer_thumbprint(exe_path)) if PUBLISHER_THUMBPRINT             else codesign.verify(exe_path)
        if (PUBLISHER_CN or PUBLISHER_THUMBPRINT) and _signed:
            if not codesign.verify_publisher(new_exe, PUBLISHER_CN,
                                             PUBLISHER_THUMBPRINT):
                signer = codesign.signer_subject(new_exe) or "(unsigned)"
                logger.error(
                    "Self-update REFUSED: downloaded exe is not signed by %r "
                    "(signer: %s). Keeping the current version.",
                    PUBLISHER_CN, signer)
                echo("[update] Update rejected: signature check failed.")
                api._remove_quietly(new_exe)
                return
            logger.info("Self-update: publisher signature verified.")
        else:
            logger.info("Self-update: this build is unsigned; "
                        "skipping the publisher check.")
    except ImportError:
        logger.warning("Self-update: codesign unavailable; "
                       "proceeding on the hash check alone.")

    logger.info("Self-update: applying v%s via detached updater.", latest)
    echo(f"[update] Installing v{latest} (the agent will restart)...")
    if not _spawn_updater_bat(exe_dir, logger, exe_path=exe_path):
        logger.warning("Self-update: could not start updater; keeping current version.")
        echo("[update] Could not start the updater; staying on the current version.")
        return

    # Hand off: exit so the bat can replace the (now-unlocked) exe and relaunch
    # it hidden. The old exe is NEVER deleted before the new one is in place.
    logger.info("Self-update: exiting to let the updater swap in v%s.", latest)
    echo("[update] Restarting to finish the update...")
    raise SystemExit(_EXIT_OK)


# --------------------------------------------------------------------------- #
# Loop + sub-commands
# --------------------------------------------------------------------------- #
def build_api(cfg: Config, logger) -> ApiClient:
    """Return an :class:`ApiClient` bound to ``cfg.api_url``.

    Tiny convenience so callers (the console ``main`` AND the GUI) construct the
    client the same way without importing :class:`ApiClient` themselves.
    """
    return ApiClient(cfg.api_url, logger)


# --------------------------------------------------------------------------- #
# Service <-> GUI interop files (Phase 2): a "Sync Now" trigger + a status dump.
# --------------------------------------------------------------------------- #
# These two tiny files live next to config.ini (the install dir). They let the
# Dashboard control + observe a BACKGROUND service WITHOUT a second syncer:
#   * SYNC_NOW_FILENAME - the Dashboard drops this file to ask the running loop
#     to run one cycle immediately (instead of waiting out the interval). The
#     loop deletes it as soon as it sees it, then runs a cycle.
#   * STATUS_FILENAME   - the loop writes a small JSON snapshot after each cycle
#     (and on lifecycle events) so the Dashboard can poll live status (running /
#     last sync / last result) for a service it does not host in-process.
SYNC_NOW_FILENAME = ".sync_now"
STATUS_FILENAME = ".status.json"


def _agent_dir(cfg: Config) -> str:
    """Directory that holds config.ini (and so the trigger + status files).

    For the installed exe / service this is the install folder; from source it
    is wherever ``cfg.path`` points. Falls back to the current directory.
    """
    try:
        d = os.path.dirname(os.path.abspath(cfg.path))
        return d or os.getcwd()
    except Exception:
        return os.getcwd()


def sync_now_path(cfg: Config) -> str:
    """Absolute path of the ``.sync_now`` trigger file for this install."""
    return os.path.join(_agent_dir(cfg), SYNC_NOW_FILENAME)


def status_path(cfg: Config) -> str:
    """Absolute path of the ``.status.json`` status file for this install."""
    return os.path.join(_agent_dir(cfg), STATUS_FILENAME)


def skip_store_path(cfg: Config) -> str:
    """Where the "requests that crash TallyPrime" list is remembered.

    Beside the config, so it belongs to THIS install and survives restarts and
    updates. See tally_connector._POISON for why remembering matters: without
    it every fresh process re-discovers the fatal request by crashing Tally
    with it once more.
    """
    return os.path.join(_agent_dir(cfg), ".tally_skip.json")


def _consume_sync_now(cfg: Config, logger) -> bool:
    """Return True (and delete the file) if a ``.sync_now`` trigger is present.

    Best-effort: any error reading/deleting it is swallowed and treated as "no
    trigger" so a stray permissions issue never stalls the loop.
    """
    path = sync_now_path(cfg)
    try:
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass  # deleting failed - still treat it as a one-shot request.
            logger.info("Sync Now: trigger file seen; running an immediate cycle.")
            return True
    except Exception as exc:
        logger.debug("Sync Now: trigger check failed (ignored): %s", exc)
    return False


def make_status_writer(cfg: Config, logger):
    """Build an ``on_status`` callback that writes ``.status.json`` snapshots.

    Used by the HEADLESS service (which has no GUI queue to push to) so the
    Dashboard can poll live status for a process it does not host. The returned
    callable matches the ``on_status(payload: dict)`` contract of
    :func:`run_sync_loop` and is fully best-effort (never raises). It keeps a
    little rolling state (last good sync timestamp) across cycles.

    The file holds: ``running`` (bool), ``event``, ``ok`` (last cycle result),
    ``cycle``, ``ts`` (event time), ``last_sync`` (epoch of the last ok cycle),
    ``version`` and ``pid``. It is written atomically (temp + replace) so a
    reader never sees a half-written file.
    """
    import json

    state = {"last_sync": None, "progress": None}
    path = status_path(cfg)

    def write(payload: dict) -> None:
        try:
            event = payload.get("event")
            ok = payload.get("ok")
            if event == "cycle" and ok:
                state["last_sync"] = payload.get("ts", time.time())
            # Track the latest in-flight progress so the SERVICE-mode Dashboard
            # (which reads this file, not the in-process queue) can show a REAL
            # percentage bar. A completed / failed / stopped cycle clears it.
            if event == "progress":
                state["progress"] = {
                    "done": payload.get("done"),
                    "total": payload.get("total"),
                    "phase": payload.get("phase"),
                }
            elif event in ("cycle", "stopped", "error"):
                state["progress"] = None
            running = event not in ("stopped", "error")
            snapshot = {
                "running": bool(running),
                "event": event,
                "ok": bool(ok) if ok is not None else None,
                "cycle": payload.get("cycle"),
                "ts": payload.get("ts", time.time()),
                "last_sync": state["last_sync"],
                "progress": state["progress"],
                "version": getattr(cfg, "agent_version", ""),
                "pid": os.getpid(),
            }
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(snapshot, fh)
            os.replace(tmp, path)
        except Exception as exc:  # status writing must never break the loop.
            try:
                logger.debug("Status writer failed (ignored): %s", exc)
            except Exception:
                pass

    return write


def _interruptible_sleep(seconds: float, stop_event=None) -> bool:
    """Sleep up to ``seconds``, but wake early if ``stop_event`` is set.

    Returns ``True`` if the stop event fired (the caller should break the loop),
    ``False`` if the full sleep elapsed. With no event this is a plain
    :func:`time.sleep` so the console path is unchanged. Polls in short slices so
    a Stop from the GUI is honoured within a fraction of a second.
    """
    if stop_event is None:
        time.sleep(max(0.0, seconds))
        return False
    # threading.Event.wait() returns True as soon as the flag is set.
    return bool(stop_event.wait(timeout=max(0.0, seconds)))


def _sleep_until_next(cfg: Config, logger, stop_event=None) -> bool:
    """Sleep ``cfg.sync_interval`` seconds, waking early on stop OR a Sync-Now.

    Returns ``True`` only when ``stop_event`` fired (the caller should break the
    loop). A ``.sync_now`` trigger landing mid-sleep ALSO ends the sleep early
    but returns ``False`` (so the loop continues into its next, immediate cycle).
    Polls in ~0.5s slices so both a Stop and a Sync-Now are honoured promptly
    without busy-waiting. With no install dir / no trigger this behaves exactly
    like the plain interval sleep.
    """
    total = max(0.0, float(cfg.sync_interval))
    slice_s = 0.5
    waited = 0.0
    trigger = sync_now_path(cfg)
    while waited < total:
        remaining = total - waited
        step = slice_s if remaining > slice_s else remaining
        if stop_event is not None:
            if stop_event.wait(timeout=step):
                return True
        else:
            time.sleep(step)
        waited += step
        # A trigger file means "run now" -> end the sleep early (not a stop).
        try:
            if os.path.exists(trigger):
                return False
        except Exception:
            pass
    return False


def _send_go_offline(cfg: Config, logger, api: ApiClient) -> None:
    """Best-effort GRACEFUL "going offline" signal to the cloud.

    Called ONLY on a clean ``stop_event`` exit of :func:`run_sync_loop` (a
    deliberate stop — service Stop, GUI Stop, or an Uninstall-triggered service
    stop). It clears ``licenses.last_seen_at`` cloud-side so the dashboard shows
    Disconnected IMMEDIATELY instead of waiting out the ~150s connected window.

    Fully wrapped + non-blocking: ``ApiClient.go_offline`` already swallows every
    error and uses a short timeout, and this extra try/except guards even a token
    read so a failure can NEVER delay or break the shutdown. An UNGRACEFUL
    crash/force-kill does not reach here and falls back to the 150s window.
    """
    try:
        token = cfg.get_token()
        if not token:
            return
        api.go_offline(token)
    except Exception as exc:  # shutdown must never hang/fail on the cloud.
        try:
            logger.debug("Go-offline signal failed (ignored): %s", exc)
        except Exception:
            pass


def run_sync_loop(cfg: Config, logger, api: ApiClient,
                  on_status=None, stop_event=None) -> None:
    """Run the continuous heartbeat + sync loop (the SHARED engine entry point).

    This is the single loop body used by BOTH the console agent (``_run_loop``)
    and the GUI (which runs it in a daemon thread). Behaviour is identical to the
    original console loop; the only additions are two OPTIONAL hooks so a GUI can
    observe + stop it WITHOUT the engine ever importing tkinter:

    * ``on_status`` — a callback invoked with a small dict after each cycle
      (and on lifecycle events). It MUST be cheap + thread-safe: the GUI pushes
      the dict onto a ``queue.Queue`` and never touches widgets from here. Keys:
      ``event`` ('started'|'cycle'|'stopped'), ``ok`` (bool, for 'cycle'),
      ``cycle`` (int), ``ts`` (epoch float). Any exception it raises is swallowed
      so a buggy observer can never break the loop.
    * ``stop_event`` — a :class:`threading.Event`. When set, the loop finishes
      the current sleep (early) and returns cleanly. ``None`` keeps the original
      "run until KeyboardInterrupt" console behaviour.

    The FIRST cycle runs VERBOSE so the console operator can watch the whole
    process; afterwards VERBOSE drops to False. The file logger keeps its detail
    throughout. When driven from the GUI the console echo simply goes nowhere
    visible (no console window), which is harmless.
    """
    global VERBOSE, _PROGRESS_CB

    def _emit(**payload) -> None:
        """Best-effort status callback — never lets an observer break the loop."""
        if on_status is None:
            return
        try:
            on_status(payload)
        except Exception:  # a buggy GUI observer must never stop the engine.
            pass

    def _progress(done, total, phase) -> None:
        """Forward a per-record/company tick to the observer as a 'progress' event."""
        _emit(event="progress", done=done, total=total, phase=phase, ts=time.time())

    # Install the module-level progress hook so the push/pull loops stream REAL
    # percentages to the GUI. Only when a GUI is watching (on_status set); the
    # console path keeps it None so the headless agent is unchanged. Set on every
    # entry so a later console run resets a stale GUI callback.
    _PROGRESS_CB = _progress if on_status is not None else None

    logger.info(
        "Agent started (v=%s, interval=%ss, machine_id=%s...).",
        cfg.agent_version,
        cfg.sync_interval,
        cfg.machine_id[:12],
    )
    # Load what earlier runs learned about requests that kill Tally, before the
    # first cycle can ask for any of them.
    try:
        tally_connector.use_skip_store(skip_store_path(cfg))
    except Exception:                                       # noqa: BLE001
        pass
    _emit(event="started", ts=time.time())
    failed_retries = 0
    cycle = 0
    paused_logged = False   # so "idling" is said once, not every 10 seconds.
    # True only when the loop exits because stop_event was set (a deliberate
    # stop). On that clean path we send a best-effort GRACEFUL go-offline so the
    # cloud flips to Disconnected at once. A crash / KeyboardInterrupt leaves
    # this False (crash falls back to the 150s window; Ctrl+C is handled below).
    stopped_gracefully = False

    # Self-update: check ONCE at startup (best-effort). maybe_self_update raises
    # SystemExit to hand off to the detached updater when it applies an update,
    # which propagates out cleanly; otherwise it just returns.
    try:
        maybe_self_update(cfg, logger, api)
    except SystemExit:
        raise
    except Exception as exc:  # never let the update check stop the loop starting.
        logger.warning("Startup self-update check failed (ignored): %s", exc)

    try:
        while True:
            if stop_event is not None and stop_event.is_set():
                stopped_gracefully = True
                break
            # PAUSED BY THE OPERATOR? Re-read from disk each iteration rather
            # than trusting the cfg we were handed: the service is a SEPARATE
            # process from the Dashboard, so pressing Start/Stop there changes
            # the file, not this object. Reading it here is what lets Start
            # resume a running service instead of requiring a restart — and what
            # makes a boot into a stopped agent stay stopped, since the service
            # is registered auto-start and would otherwise just come back.
            if not _sync_is_enabled(cfg):
                if not paused_logged:
                    logger.info("Sync is STOPPED by the operator — idling. "
                                "Press Start in the Dashboard to resume.")
                    paused_logged = True
                _emit(event="paused", ts=time.time())
                if stop_event is not None:
                    stop_event.wait(min(10.0, max(1.0, cfg.sync_interval)))
                else:
                    time.sleep(min(10.0, max(1.0, cfg.sync_interval)))
                continue
            if paused_logged:
                logger.info("Sync RESUMED by the operator.")
                paused_logged = False

            # A "Sync Now" trigger consumed at the top of an iteration just means
            # we run this cycle now (clear it so it is a one-shot).
            _consume_sync_now(cfg, logger)
            cycle += 1
            first = cycle == 1
            VERBOSE = first  # show everything on the very first cycle only.
            try:
                ok = _run_cycle(cfg, logger, api)
            finally:
                VERBOSE = False

            # Periodic self-update check (every update_check_cycles cycles, after
            # the very first which is covered by the startup check above). Best-
            # effort; SystemExit hands off to the updater + exits cleanly.
            if (not first) and cfg.update_check_cycles > 0 \
                    and (cycle % cfg.update_check_cycles == 0):
                try:
                    maybe_self_update(cfg, logger, api)
                except SystemExit:
                    raise
                except Exception as exc:
                    logger.warning("Periodic self-update check failed (ignored): %s", exc)

            if first:
                echo("")
                echo(
                    f"[OK] First sync complete. Now running continuously "
                    f"(every {cfg.sync_interval}s). Press Ctrl+C to stop."
                )
            else:
                # One short, non-verbose console line per subsequent cycle.
                stamp = time.strftime("%H:%M:%S")
                echo(f"[{stamp}] cycle {cycle}: {'ok' if ok else 'retry'}")

            if ok:
                if failed_retries:
                    logger.info("Recovered after %d failed cycle(s).", failed_retries)
                failed_retries = 0
            else:
                failed_retries += 1
                level = (
                    logger.warning
                    if failed_retries >= _FAILED_RETRY_WARN_THRESHOLD
                    else logger.info
                )
                level("Cycle failed; consecutive failures=%d.", failed_retries)

            _emit(event="cycle", ok=bool(ok), cycle=cycle, ts=time.time())

            # Sleep until the next cycle, waking early on a stop request OR when
            # a ".sync_now" trigger lands (the Dashboard's "Sync Now" for a
            # service: it drops the file, the loop wakes and runs a cycle now).
            if _sleep_until_next(cfg, logger, stop_event):
                stopped_gracefully = True
                break
    except KeyboardInterrupt:
        logger.info("Agent stopped.")
        echo("")
        echo("Agent stopped.")

    # GRACEFUL stop (service Stop / GUI Stop / Uninstall-triggered service stop)
    # exits via stop_event. On that clean path ONLY, tell the cloud we are going
    # offline so the dashboard shows Disconnected immediately (best-effort + non-
    # blocking — never delays/breaks shutdown; a crash skips this and relies on
    # the ~150s connected window). Done before the 'stopped' status emit.
    if stopped_gracefully:
        _send_go_offline(cfg, logger, api)

    logger.info("Sync loop ended.")
    _emit(event="stopped", ts=time.time())


def _run_loop(cfg: Config, logger, api: ApiClient) -> None:
    """Console entry to the continuous sync loop (Ctrl+C to stop).

    Thin wrapper around :func:`run_sync_loop` with no observer/stop event so the
    console behaviour is byte-for-byte what it always was.
    """
    run_sync_loop(cfg, logger, api)


def _run_once(cfg: Config, logger, api: ApiClient) -> int:
    """Run exactly one cycle (for ``--once``); return a process exit code.

    Always VERBOSE so ``--once`` shows the operator the full step-by-step run.
    """
    global VERBOSE
    logger.info("Running a single cycle (--once).")
    VERBOSE = True
    try:
        ok = _run_cycle(cfg, logger, api)
    finally:
        VERBOSE = False
    if ok:
        logger.info("Single cycle complete.")
        echo("")
        echo("[OK] Single cycle complete.")
        return _EXIT_OK
    logger.warning("Single cycle reported a failure.")
    echo("")
    echo("[!] Single cycle reported a failure (see logs/agent.log for detail).")
    return 1


def _print_status(cfg: Config, logger) -> int:
    """Print config summary, token presence and Tally availability (--status)."""
    token = cfg.get_token()
    fingerprint = machine_fingerprint()

    print(f"{_APP_NAME} - status")
    print(f"  api_url        : {cfg.api_url}")
    print(f"  agent_version  : {cfg.agent_version}")
    print(f"  sync_interval  : {cfg.sync_interval}s")
    print(f"  log_level      : {cfg.log_level}")
    print(f"  machine_id     : {cfg.machine_id}")
    print(f"  fingerprint    : {fingerprint}")
    print(f"  id_matches     : {'yes' if cfg.machine_id == fingerprint else 'no (machine changed?)'}")
    print(f"  agent_token    : {'present (signed in)' if token else 'absent (not signed in)'}")

    # Tally availability - wrapped, must never crash a status print.
    tally_state = "unknown"
    try:
        tally = TallyConnector(_tally_url(cfg), logger)
        tally_state = "reachable" if tally.is_available() else "not reachable"
    except Exception as exc:
        tally_state = f"error ({exc})"
    print(f"  tally          : {tally_state}")

    return _EXIT_OK


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main(argv: Optional[list[str]] = None) -> int:
    """Program entry point. Returns a process exit code."""
    args = _parse_args(list(sys.argv[1:] if argv is None else argv))

    cfg, logger = _load_config()
    api = ApiClient(cfg.api_url, logger)

    # --status never activates or loops; it just reports.
    if args.status:
        return _print_status(cfg, logger)

    # Short startup banner (stdout) so the operator sees what they launched.
    echo(f"{_APP_NAME} v{cfg.agent_version}")
    echo("=" * (len(_APP_NAME) + len(cfg.agent_version) + 2))

    # Make sure we have a valid token (activates if needed / forced).
    _ensure_activated(args, cfg, logger, api)

    if args.once:
        return _run_once(cfg, logger, api)

    _run_loop(cfg, logger, api)
    return _EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except KeyboardInterrupt:
        # Catch a Ctrl+C that arrives before the loop installs its own handler.
        print("Agent stopped.")
        sys.exit(_EXIT_OK)
