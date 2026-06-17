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
        )
    else:  # stock item
        resp = tally.create_stock_item(
            item["name"], unit=item.get("unit", "Nos"),
            hsn=item.get("hsn"), gst_rate=item.get("gst_rate"),
            company=company,
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
        resp = tally.create_sales_voucher(v["party"], v["date"], v.get("items", []),
                                          company=company, amount=v.get("amount"))
    elif kind == "purchase":
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
            resp = tally.create_company(cname)
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
            vouchers = tally.day_book(company=cname)
        except Exception as exc:
            logger.warning("Pull[%s]: reading from Tally failed: %s", cname, exc)
            if VERBOSE:
                echo(f"  [x] '{cname}': could not read from Tally ({exc})")
            continue

        try:
            counts = api.import_from_tally(token, ledgers, stock, vouchers, godowns,
                                           company_name=cname)
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
def _run_loop(cfg: Config, logger, api: ApiClient) -> None:
    """Run the continuous sync loop until interrupted.

    Heartbeats and syncs every ``cfg.sync_interval`` seconds, tracking a simple
    consecutive-failure counter so persistent problems are surfaced in the log.
    Ctrl+C exits cleanly.

    The FIRST cycle runs VERBOSE so the operator can watch the whole process
    (Tally check -> push -> pull) on the console; afterwards VERBOSE drops to
    False and each cycle prints just one short summary line (so the loop is
    neither silent nor spammy). The file logger keeps its detail throughout.
    """
    global VERBOSE
    logger.info(
        "Agent started (v=%s, interval=%ss, machine_id=%s...).",
        cfg.agent_version,
        cfg.sync_interval,
        cfg.machine_id[:12],
    )
    failed_retries = 0
    cycle = 0

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

            time.sleep(cfg.sync_interval)
    except KeyboardInterrupt:
        logger.info("Agent stopped.")
        echo("")
        echo("Agent stopped.")


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
