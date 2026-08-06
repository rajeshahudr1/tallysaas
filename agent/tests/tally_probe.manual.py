"""MANUAL probe: find the ONE Tally request that kills Tally.

TallyPrime can die on a request it dislikes — it shows "Internal Error. Contact
Tally Solutions. Incorrect Object Type!" and closes. From the agent's side that
looks only like the socket dropping (RemoteDisconnected), and a full pull sends
around twenty different requests, so the culprit is unfindable from the log
alone.

This script sends the pull's requests ONE AT A TIME, in the same order the real
pull uses, printing each name BEFORE it is sent and the outcome after. The last
name printed without an outcome is the request that killed Tally. Each step is
independently guarded, so a request that merely FAILS (unsupported collection,
empty result) is reported and the probe carries on — only a death stops it.

Not part of the automated suite: it needs a live Tally with a company open.

Usage (from the agent folder, Tally running with the company open):

    python tests/tally_probe.manual.py                     # first open company
    python tests/tally_probe.manual.py "SHREE DEVPURI SALES"
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import logging  # noqa: E402

from tally_connector import TallyConnector  # noqa: E402


def _log():
    log = logging.getLogger("probe")
    log.setLevel(logging.DEBUG)
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(logging.Formatter("        %(message)s"))
    log.addHandler(h)
    return log


def main(argv):
    url = os.environ.get("TALLY_URL", "http://localhost:9000")
    tally = TallyConnector(url, _log())

    print("Probing " + url)
    if not tally.is_available():
        print("[x] Tally is not answering. Open Tally (F1 > Settings > "
              "Connectivity: Server, port 9000) and run again.")
        return 2

    company = argv[1] if len(argv) > 1 else None
    if not company:
        info = tally.company_info()
        names = [c.get("name") for c in (info.get("companies") or []) if c.get("name")]
        if not names:
            print("[x] No company is open in Tally.")
            return 2
        company = names[0]
    print("Company: " + company)
    print("")

    # The SAME order _pull_pass uses. Each entry: (label, callable).
    steps = [
        ("company_full_info",        lambda: tally.company_full_info(company=company)),
        ("ledger_list",              lambda: tally.ledger_list(company=company)),
        ("stock_summary",            lambda: tally.stock_summary(company=company)),
        ("godown_list",              lambda: tally.godown_list(company=company)),
        ("group_list",               lambda: tally.group_list(company=company)),
        ("fetch_all_masters",        lambda: tally.fetch_all_masters(company=company)),
        ("financial_reports",        lambda: tally.financial_reports(company=company)),
        ("financial_reports_by_year", lambda: tally.financial_reports_by_year(company=company, years=1)),
        ("party_ledger_names",       lambda: tally.party_ledger_names(company=company)),
        ("voucher_type_names",       lambda: tally.voucher_type_names(company=company)),
        ("voucher_ids",              lambda: tally.voucher_ids(company=company)),
    ]

    dead_at = None
    for name, fn in steps:
        # Printed BEFORE the call and flushed, so a Tally death leaves this name
        # as the last thing on screen — that IS the answer.
        print("[..] " + name + " ...", flush=True)
        started = time.monotonic()
        try:
            out = fn()
        except Exception as exc:
            took = time.monotonic() - started
            print("     [x] %s FAILED after %.1fs: %s" % (name, took, exc))
            # A death shows up as the connection dropping; anything else is a
            # request Tally REFUSED, which is survivable — keep probing.
            if "not reachable" in str(exc).lower():
                if not tally.is_available():
                    dead_at = name
                    break
            continue
        took = time.monotonic() - started
        size = len(out) if hasattr(out, "__len__") else 1
        print("     [OK] %s -> %s item(s) in %.1fs" % (name, size, took))

    print("")
    if dead_at:
        print("=" * 68)
        print("TALLY DIED ON: " + dead_at)
        print("Check Tally's window for the error dialog it showed.")
        print("=" * 68)
        return 1
    print("All requests completed - Tally survived the whole pull sequence.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
