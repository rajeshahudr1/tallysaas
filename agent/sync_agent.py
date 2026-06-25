"""Entry point for the Tally Cloud Sync Agent.

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

import json
import os
import re
import subprocess
import sys
import time
from typing import Any, Optional

from config import Config, machine_fingerprint
from logger import get_logger
from api_client import ApiClient, ActivationError, AgentError
from tally_connector import TallyConnector, TallyUnavailable
import tally_control


# Exit codes (POSIX-ish): 0 ok, non-zero = startup/activation failure.
_EXIT_OK = 0
_EXIT_ACTIVATION = 2
_EXIT_CONFIG = 3

# How many consecutive failed cycles before we widen the log to a warning.
_FAILED_RETRY_WARN_THRESHOLD = 3

# How many times the interactive activation prompt re-asks on a bad key.
_MAX_ACTIVATION_ATTEMPTS = 5

# App banner shown at startup (stdout only).
_APP_NAME = "Tally Cloud Sync Agent"

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
        self.activate: bool = False
        self.activate_key: Optional[str] = None
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
        if token in ("--activate", "-a"):
            args.activate = True
            # An optional value may follow (the license key).
            if i + 1 < len(argv) and not argv[i + 1].startswith("-"):
                args.activate_key = argv[i + 1].strip()
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
        "Tally Cloud Sync Agent\n"
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


def _resolve_license_key(args: _Args, cfg: Config, logger) -> str:
    """Work out which license key to activate with.

    Priority: ``--activate <key>`` argument, then ``cfg.license_key`` from
    config.ini, then an interactive prompt as a last resort.
    """
    if args.activate_key:
        return args.activate_key
    if cfg.license_key:
        return cfg.license_key
    logger.info("No license key in config; prompting operator.")
    try:
        return input("Enter license key: ").strip()
    except (EOFError, KeyboardInterrupt):
        return ""


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


def _activate(cfg: Config, logger, api: ApiClient, license_key: str) -> None:
    """Activate against the cloud and persist the returned agent token.

    This is the NON-INTERACTIVE path (key supplied via --activate / config.ini,
    or stdin is not a tty). On :class:`ActivationError` the cloud's user-facing
    message is printed and the process exits non-zero - there is nothing useful
    to loop on without an operator at the keyboard.
    """
    if not license_key:
        msg = "No license key provided. Set license_key in config.ini or use --activate KEY."
        logger.error(msg)
        print(msg, file=sys.stderr)
        raise SystemExit(_EXIT_ACTIVATION)

    try:
        data = api.activate(license_key, cfg.machine_id, cfg.agent_version)
    except ActivationError as exc:
        # The message is the cloud's user-facing reason (bad key / bound /
        # suspended / expired / unreachable).
        logger.error("Activation failed: %s", exc)
        print(f"Activation failed: {exc}", file=sys.stderr)
        raise SystemExit(_EXIT_ACTIVATION) from exc

    _persist_token(cfg, logger, data)


def _activate_interactive(cfg: Config, logger, api: ApiClient) -> None:
    """Interactive activation with a VALIDATE-then-RETRY loop (stdout-driven).

    Prompts for the license key, validates it against the cloud, and on a bad /
    bound / suspended / expired / unreachable key SHOWS the cloud's reason and
    asks again - up to :data:`_MAX_ACTIVATION_ATTEMPTS`. The operator can abort
    with an empty line / Ctrl+C / EOF. Only reached when stdin IS a tty and no
    key was supplied another way, so it never hangs a scheduled task.
    """
    echo("")
    echo("STEP 1/4 - License activation")
    for attempt in range(1, _MAX_ACTIVATION_ATTEMPTS + 1):
        try:
            key = input("  Enter your license key: ").strip()
        except (EOFError, KeyboardInterrupt):
            echo("")
            echo("  [x] Activation cancelled. Exiting.")
            logger.info("Interactive activation aborted by operator.")
            raise SystemExit(_EXIT_ACTIVATION)

        if not key:
            echo("  [x] No key entered. Exiting.")
            logger.info("Interactive activation aborted (empty key).")
            raise SystemExit(_EXIT_ACTIVATION)

        echo("  [..] Validating with the cloud...")
        try:
            data = api.activate(key, cfg.machine_id, cfg.agent_version)
        except ActivationError as exc:
            # Cloud's user-facing reason (bad key / bound / suspended / expired
            # / unreachable). Show it and re-prompt.
            logger.warning("Activation attempt %d failed: %s", attempt, exc)
            echo(f"  [x] {exc} Please try again.")
            continue

        _persist_token(cfg, logger, data)
        echo(_activation_success_line(data))
        return

    msg = (
        f"Activation failed after {_MAX_ACTIVATION_ATTEMPTS} attempts. "
        "Check the license key and your internet connection, then run again."
    )
    logger.error(msg)
    echo(f"  [x] {msg}")
    raise SystemExit(_EXIT_ACTIVATION)


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
    """Activate if there is no saved token, or if ``--activate`` was passed.

    Picks the activation style:

    * A key supplied another way (``--activate KEY`` / ``cfg.license_key``), or a
      non-tty stdin (headless / scheduled), uses the NON-INTERACTIVE try-once-
      then-exit path (``_activate``) - so a scheduled task never hangs.
    * Otherwise (a real terminal with no key on hand) uses the INTERACTIVE
      prompt + validate + retry loop (``_activate_interactive``).
    """
    if cfg.get_token() and not args.activate:
        logger.debug("Existing agent token found; skipping activation.")
        return

    # A key supplied non-interactively keeps the original behaviour.
    if args.activate_key or cfg.license_key:
        license_key = _resolve_license_key(args, cfg, logger)
        _activate(cfg, logger, api, license_key)
        return

    # No key on hand. If there's an operator at the keyboard, prompt + retry;
    # otherwise fall back to the non-interactive (try-once) path so a headless
    # run fails fast with a clear message instead of blocking on input().
    if _stdin_is_tty():
        _activate_interactive(cfg, logger, api)
    else:
        _activate(cfg, logger, api, "")


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

    if available and VERBOSE:
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
    if ok:
        res["tally_guid"] = "synced"
    else:
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
    if ok:
        res["tally_guid"] = "tally"
    else:
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
    else:  # payment
        resp = tally.create_payment(v["party"], v["date"], v.get("amount", 0),
                                    mode=v.get("mode", "Cash"), company=company)
    ok, info = _interpret_tally(resp)
    res = {"record_type": v["record_type"], "record_id": v["id"],
           "company_id": v["company_id"], "status": "synced" if ok else "failed"}
    if ok:
        res["tally_voucher_no"] = v.get("voucher_no")
    else:
        res["message"] = info
    return res


def _echo_record(index: int, total: int, kind: str, name: str, res: dict) -> None:
    """Echo a single per-record push line to the console (verbose only).

    Shape: ``  [3/9] voucher  INV-2026-0001   [OK]`` on success, or
    ``  [3/9] voucher  INV-2026-0001   [x] <reason>`` on failure. No-op unless
    :data:`VERBOSE` so normal loop cycles stay quiet.
    """
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
        if ok:
            res["tally_guid"] = "tally"
        else:
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

    for cname in names:
        if VERBOSE:
            echo(f"  [..] '{cname}': reading ledgers / stock / vouchers from Tally...")
        try:
            ledgers = tally.ledger_list(company=cname)
            stock = tally.stock_summary(company=cname)
            godowns = tally.godown_list(company=cname)
            groups = tally.group_list(company=cname)
            cmaster = tally.company_full_info(company=cname)
            # Tally's EXACT Balance Sheet / P&L / Trial Balance — pulled verbatim
            # so the cloud mirrors every figure (no reconstruction drift). Best-
            # effort: never let a report miss block the masters/voucher import.
            try:
                freports = tally.financial_reports(company=cname)
            except Exception as _rexc:
                logger.warning("Pull[%s]: financial reports read failed: %s", cname, _rexc)
                freports = {}
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
                                           company_name=cname, financial_reports=freports)
            new = sum(counts.get(k, 0) for k in ("customers_new", "suppliers_new", "products_new"))
            linked = sum(counts.get(k, 0) for k in ("customers_linked", "suppliers_linked", "products_linked"))
            updated = counts.get("masters_updated", 0)
            vnew = counts.get("vouchers_new", 0)
            jnew = counts.get("journals_new", 0)
            lnew = counts.get("locations_new", 0)
            created = bool(counts.get("company_created"))
            logger.info("Pull[%s]: company %s - %d masters-new, %d linked, %d updated, "
                        "%d vouchers, %d journals, %d locations",
                        cname, "CREATED in cloud" if created else "updated",
                        new, linked, updated, vnew, jnew, lnew)
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
        try:
            vsent = _pull_vouchers(cfg, logger, api, tally, token, cname)
            if vsent and VERBOSE:
                echo(f"  [OK] '{cname}': {vsent} voucher(s) pushed to cloud this cycle.")
        except Exception as exc:
            logger.warning("Voucher backfill[%s] failed: %s", cname, exc)


VOUCHER_STATE_FILENAME = ".voucher_sync.json"
VOUCHER_CHUNK = 50000        # AlterID window per Tally fetch
VOUCHER_BATCH = 2000         # vouchers per cloud /agent/import POST
VOUCHER_MAX_FETCHES = 6      # AlterID windows per cycle (keeps a cycle bounded)
# If the backfill scans this far and finds NO voucher at all (max_seen == 0), the
# cursor likely overran the data while Tally was still loading (cold start) or the
# cloud was reset — re-scan from AlterID 0 ONCE so the vouchers are actually found
# instead of climbing empty high windows forever.
VOUCHER_RESCAN_CEILING = 300000
_voucher_rescan_done = set()     # companies already re-scanned this session (no loop)


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
    for _ in range(VOUCHER_MAX_FETCHES):
        lo, hi = through, through + VOUCHER_CHUNK
        try:
            vs = tally.voucher_list(company=cname, after_alterid=lo, upto_alterid=hi)
        except Exception as exc:
            logger.warning("Voucher pull[%s] %d-%d read failed: %s", cname, lo, hi, exc)
            break
        if vs:
            ok = True
            for i in range(0, len(vs), VOUCHER_BATCH):
                batch = vs[i:i + VOUCHER_BATCH]
                try:
                    c = api.import_from_tally(token, [], [], batch, [], company_name=cname)
                    sent += len(batch)
                    logger.debug("Voucher pull[%s] %d-%d: batch %d sent (cloud new=%s)",
                                 cname, lo, hi, len(batch), (c or {}).get("vouchers_new"))
                except Exception as exc:
                    logger.warning("Voucher import[%s] %d-%d failed: %s", cname, lo, hi, exc)
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
_EXE_BASENAME = "TallyCloudSyncAgent.exe"
_NEW_EXE_BASENAME = "TallyCloudSyncAgent.new.exe"
_UPDATER_BAT = "_agent_update.bat"
_STARTUP_VBS = "TallyCloudSyncAgent.vbs"


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
        'net stop "TallyCloudSync" >nul 2>&1',
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
        'net start "TallyCloudSync" >nul 2>&1',
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
        'net start "TallyCloudSync" >nul 2>&1',
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

    state = {"last_sync": None}
    path = status_path(cfg)

    def write(payload: dict) -> None:
        try:
            event = payload.get("event")
            ok = payload.get("ok")
            if event == "cycle" and ok:
                state["last_sync"] = payload.get("ts", time.time())
            running = event not in ("stopped", "error")
            snapshot = {
                "running": bool(running),
                "event": event,
                "ok": bool(ok) if ok is not None else None,
                "cycle": payload.get("cycle"),
                "ts": payload.get("ts", time.time()),
                "last_sync": state["last_sync"],
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
    global VERBOSE

    def _emit(**payload) -> None:
        """Best-effort status callback — never lets an observer break the loop."""
        if on_status is None:
            return
        try:
            on_status(payload)
        except Exception:  # a buggy GUI observer must never stop the engine.
            pass

    logger.info(
        "Agent started (v=%s, interval=%ss, machine_id=%s...).",
        cfg.agent_version,
        cfg.sync_interval,
        cfg.machine_id[:12],
    )
    _emit(event="started", ts=time.time())
    failed_retries = 0
    cycle = 0
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

    print("Tally Cloud Sync Agent - status")
    print(f"  api_url        : {cfg.api_url}")
    print(f"  agent_version  : {cfg.agent_version}")
    print(f"  sync_interval  : {cfg.sync_interval}s")
    print(f"  log_level      : {cfg.log_level}")
    print(f"  machine_id     : {cfg.machine_id}")
    print(f"  fingerprint    : {fingerprint}")
    print(f"  id_matches     : {'yes' if cfg.machine_id == fingerprint else 'no (machine changed?)'}")
    print(f"  license_key    : {'set' if cfg.license_key else 'not set'}")
    print(f"  agent_token    : {'present (activated)' if token else 'absent (not activated)'}")

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
