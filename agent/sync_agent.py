"""Entry point for the Tally Cloud Sync Agent.

Runs on the customer's Windows PC alongside Tally Prime. It activates the
machine against the cloud (license key, machine-bound), heartbeats on an
interval, and — once the cloud sync-queue endpoints land in a later phase —
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
from typing import Optional

from config import Config, machine_fingerprint
from logger import get_logger
from api_client import ApiClient, ActivationError, AgentError
from tally_connector import TallyConnector, TallyUnavailable


# Exit codes (POSIX-ish): 0 ok, non-zero = startup/activation failure.
_EXIT_OK = 0
_EXIT_ACTIVATION = 2
_EXIT_CONFIG = 3

# How many consecutive failed cycles before we widen the log to a warning.
_FAILED_RETRY_WARN_THRESHOLD = 3


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
        # No logger yet — fall back to a default one so this is still recorded.
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


def _activate(cfg: Config, logger, api: ApiClient, license_key: str) -> None:
    """Activate against the cloud and persist the returned agent token.

    On :class:`ActivationError` the cloud's user-facing message is printed and
    the process exits non-zero — activation is a precondition for everything
    else, so there is nothing useful to loop on.
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


def _ensure_activated(args: _Args, cfg: Config, logger, api: ApiClient) -> None:
    """Activate if there is no saved token, or if ``--activate`` was passed."""
    if cfg.get_token() and not args.activate:
        logger.debug("Existing agent token found; skipping activation.")
        return
    license_key = _resolve_license_key(args, cfg, logger)
    _activate(cfg, logger, api, license_key)


# --------------------------------------------------------------------------- #
# One sync cycle
# --------------------------------------------------------------------------- #
def _run_cycle(cfg: Config, logger, api: ApiClient) -> bool:
    """Run a single heartbeat + sync cycle.

    Returns ``True`` if the cycle completed its work (or cleanly skipped),
    ``False`` if it failed in a way the caller should count as a retry. Never
    raises — every external call is wrapped so the loop survives.
    """
    token = cfg.get_token()
    if not token:
        # Should not happen after _ensure_activated, but be defensive.
        logger.error("No agent token available; cannot run cycle.")
        return False

    # 1) Heartbeat — tells the cloud we are alive and learns our license state.
    try:
        hb = api.heartbeat(token, cfg.agent_version)
    except AgentError as exc:
        logger.warning("Heartbeat failed (will retry next cycle): %s", exc)
        return False

    status = (hb.get("status") or "").lower()
    if status != "active":
        # Cloud has suspended/expired us — keep heartbeating but do not sync.
        logger.warning("license %s — pausing sync", status or "inactive")
        return True

    # 2) Tally reachability — if it is down, optionally AUTO-START it, then
    #    re-check. Tally serves its XML API only while open, so auto-start lets
    #    the agent run truly unattended (config [tally] auto_start, default on).
    tally = TallyConnector(_tally_url(cfg), logger)
    try:
        available = tally.is_available()
    except Exception as exc:  # never trust an external probe to behave.
        logger.warning("Tally probe error (treating as unreachable): %s", exc)
        available = False

    if not available and cfg.tally_auto_start:
        available = _start_tally(cfg, logger)

    if not available:
        logger.info("Tally not reachable — will retry")
        return True

    # 3) Push (cloud → Tally) then Pull (Tally → cloud). Push drives the
    #    pass result; the pull is best-effort + never fails the cycle.
    pushed = _sync_pass(cfg, logger, api, tally)
    _pull_pass(cfg, logger, api, tally)
    return pushed


def _interpret_tally(resp: str) -> tuple[bool, str]:
    """Interpret a Tally import response → (ok, info).

    Tally answers an IMPORT with <CREATED>/<ALTERED> counts on success and
    <LINEERROR>…</LINEERROR> / <EXCEPTIONS>n</EXCEPTIONS> on failure. We extract
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


def _push_master(tally: TallyConnector, item: dict, kind: str) -> dict:
    """Push one ledger/stock-item to Tally and shape a result row."""
    if kind == "ledger":
        resp = tally.create_ledger(
            item["name"], parent=item.get("parent", "Sundry Debtors"),
            gstin=item.get("gstin"), opening=item.get("opening", 0),
        )
    else:  # stock item
        resp = tally.create_stock_item(
            item["name"], unit=item.get("unit", "Nos"),
            hsn=item.get("hsn"), gst_rate=item.get("gst_rate"),
        )
    ok, info = _interpret_tally(resp)
    res = {"record_type": item["record_type"], "record_id": item["id"],
           "company_id": item["company_id"], "status": "synced" if ok else "failed"}
    if ok:
        res["tally_guid"] = "synced"
    else:
        res["message"] = info
    return res


def _push_voucher(tally: TallyConnector, v: dict) -> dict:
    """Push one voucher (sales/purchase/receipt/payment) and shape a result."""
    kind = v.get("voucher_kind")
    if kind == "sales":
        resp = tally.create_sales_voucher(v["party"], v["date"], v.get("items", []))
    elif kind == "purchase":
        resp = tally.create_purchase_voucher(v["party"], v["date"], v.get("items", []))
    elif kind == "receipt":
        resp = tally.create_receipt(v["party"], v["date"], v.get("amount", 0), mode=v.get("mode", "Cash"))
    elif kind == "journal":
        resp = tally.create_journal(v["dr_ledger"], v["cr_ledger"], v["date"],
                                    v.get("amount", 0), v.get("narration", ""),
                                    vch_type=v.get("vch_type", "Journal"))
    else:  # payment
        resp = tally.create_payment(v["party"], v["date"], v.get("amount", 0), mode=v.get("mode", "Cash"))
    ok, info = _interpret_tally(resp)
    res = {"record_type": v["record_type"], "record_id": v["id"],
           "company_id": v["company_id"], "status": "synced" if ok else "failed"}
    if ok:
        res["tally_voucher_no"] = v.get("voucher_no")
    else:
        res["message"] = info
    return res


def _sync_pass(cfg: Config, logger, api: ApiClient, tally: TallyConnector) -> bool:
    """One sync pass: pull pending from cloud → push to Tally → report results.

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
    total = len(ledgers) + len(items) + len(vouchers)
    if total == 0:
        logger.info("sync pass: nothing pending — all caught up.")
        return True

    logger.info("sync pass: %d ledger(s), %d stock item(s), %d voucher(s) to push.",
                len(ledgers), len(items), len(vouchers))

    results: list[dict] = []
    interrupted = False
    try:
        for lg in ledgers:
            results.append(_push_master(tally, lg, "ledger"))
        # Units must exist before the stock items that reference them.
        units = sorted({(it.get("unit") or "Nos") for it in items})
        for u in units:
            try:
                tally.create_unit(u)
            except Exception as exc:        # a unit that already exists is fine.
                logger.debug("create_unit(%s): %s", u, exc)
        for it in items:
            results.append(_push_master(tally, it, "stock"))
        for v in vouchers:
            results.append(_push_voucher(tally, v))
    except TallyUnavailable as exc:
        # Tally went away mid-pass; report what we have, retry the rest later.
        logger.warning("Tally became unavailable during sync: %s", exc)
        interrupted = True
    except Exception as exc:  # never let one bad record kill the loop.
        logger.error("Unexpected error pushing to Tally: %s", exc)
        interrupted = True

    # Report whatever we managed to push.
    if results:
        try:
            ack = api.report_results(token, results)
            ok = sum(1 for r in results if r["status"] == "synced")
            logger.info("sync pass: reported %d result(s) (%d synced, %d failed).",
                        ack.get("processed", len(results)), ok, len(results) - ok)
        except AgentError as exc:
            logger.warning("Could not report sync results (will resend next pass): %s", exc)
            return False

    return not interrupted


def _pull_pass(cfg: Config, logger, api: ApiClient, tally: TallyConnector) -> None:
    """Tally → Cloud: read masters from the open Tally company + upsert to cloud.

    Reads ledgers (→ customers/suppliers) + stock items (→ products) and posts
    them to /agent/import. Best-effort: any error is logged, never raised. The
    import is idempotent (already-linked records are skipped cloud-side).
    Target company = the FIRST company under this license (single-company is the
    common case; multi-company name-matching is a later refinement).
    """
    token = cfg.get_token()
    if not token:
        return
    try:
        companies = (api.get_pending(token) or {}).get("companies") or []
    except Exception as exc:
        logger.warning("Pull: could not resolve target company: %s", exc)
        return
    if not companies:
        logger.info("Pull: no company under this license — skipping.")
        return
    company_id = companies[0].get("id")

    try:
        ledgers = tally.ledger_list()
        stock = tally.stock_summary()
        vouchers = tally.day_book()
    except Exception as exc:
        logger.warning("Pull: reading from Tally failed: %s", exc)
        return

    try:
        counts = api.import_from_tally(token, company_id, ledgers, stock, vouchers)
        new = sum(counts.get(k, 0) for k in ("customers_new", "suppliers_new", "products_new"))
        linked = sum(counts.get(k, 0) for k in ("customers_linked", "suppliers_linked", "products_linked"))
        vnew = counts.get("vouchers_new", 0)
        if new or linked or vnew:
            logger.info("Pull (Tally→Cloud): %d masters-new, %d linked, %d vouchers %s", new, linked, vnew, counts)
    except Exception as exc:
        logger.warning("Pull: import to cloud failed: %s", exc)


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
    """Return the TallyPrime executable path: config override → known install
    folders → Windows registry (App Paths). None if it can't be located."""
    if cfg.tally_exe and os.path.isfile(cfg.tally_exe):
        return cfg.tally_exe
    for path in _TALLY_EXE_CANDIDATES:
        if os.path.isfile(path):
            return path
    return _tally_exe_from_registry()


def _start_tally(cfg: Config, logger) -> bool:
    """Launch TallyPrime if it is installed, then wait for its gateway (:9000).

    Tally only serves its XML API while the app is open, so when it is down the
    agent starts it (config [tally] auto_start, default on) and polls until the
    port answers — up to ~60s. Returns True once Tally is reachable. Best-effort
    and never raises (a missing exe / launch error is logged + returns False).
    Windows-only in practice; on other OSes it just reports the exe wasn't found.
    """
    exe = _find_tally_exe(cfg)
    if not exe:
        logger.warning(
            "Auto-start: TallyPrime executable not found. Set [tally] tally_exe in "
            "config.ini to its full path (e.g. C:\\Program Files\\TallyPrime\\tally.exe)."
        )
        return False

    logger.info("Auto-start: launching Tally — %s", exe)
    try:
        # Detached so Tally keeps running independently of the agent process.
        flags = 0x00000008 if os.name == "nt" else 0  # DETACHED_PROCESS
        subprocess.Popen([exe], cwd=os.path.dirname(exe) or None, close_fds=True,
                         creationflags=flags)
    except Exception as exc:  # launch failure must not kill the loop.
        logger.warning("Auto-start: failed to launch Tally: %s", exc)
        return False

    # Poll the gateway — Tally + its company take a little while to come up.
    tally = TallyConnector(_tally_url(cfg), logger)
    for _ in range(30):                 # 30 × 2s ≈ 60s
        time.sleep(2)
        try:
            if tally.is_available():
                logger.info("Auto-start: Tally is up and reachable.")
                return True
        except Exception:
            pass
    logger.warning(
        "Auto-start: launched Tally but the gateway (:9000) did not respond in time. "
        "Open the company + enable Gateway > F1 > Connectivity (port 9000)."
    )
    return False


# --------------------------------------------------------------------------- #
# Loop + sub-commands
# --------------------------------------------------------------------------- #
def _run_loop(cfg: Config, logger, api: ApiClient) -> None:
    """Run the continuous sync loop until interrupted.

    Heartbeats and syncs every ``cfg.sync_interval`` seconds, tracking a simple
    consecutive-failure counter so persistent problems are surfaced in the log.
    Ctrl+C exits cleanly.
    """
    logger.info(
        "Agent started (v=%s, interval=%ss, machine_id=%s…).",
        cfg.agent_version,
        cfg.sync_interval,
        cfg.machine_id[:12],
    )
    failed_retries = 0
    try:
        while True:
            ok = _run_cycle(cfg, logger, api)
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


def _run_once(cfg: Config, logger, api: ApiClient) -> int:
    """Run exactly one cycle (for ``--once``); return a process exit code."""
    logger.info("Running a single cycle (--once).")
    ok = _run_cycle(cfg, logger, api)
    if ok:
        logger.info("Single cycle complete.")
        return _EXIT_OK
    logger.warning("Single cycle reported a failure.")
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

    # Tally availability — wrapped, must never crash a status print.
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
