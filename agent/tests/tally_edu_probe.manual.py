"""MANUAL probe: which requests does THIS TallyPrime refuse to serve?

WHY THIS EXISTS. "Internal Error. Contact Tally Solutions. Incorrect Object
Type!" is TallyPrime refusing a request so hard it takes itself down. Which
requests do it depends on the build, the edition (Educational lacks whole object
types) and on the company's own data — so it cannot be answered by reading code,
only by asking. The agent already discovers this at runtime and writes what it
finds to .tally_skip.json, but only ONE crash per run: the customer meets the
error box once per offender, spread over days.

This script asks all of them deliberately, in one sitting, so the list is known.

HOW IT BEHAVES. One request at a time. After each, it checks Tally is still
answering. The moment one kills Tally it STOPS and prints exactly where to
resume — because everything after a dead Tally would report a meaningless
failure. Restart Tally, re-run with --from <n>, and it continues.

It is deliberately NOT a unittest: it needs a running Tally with a real company
open, it changes nothing, and it is read by a person, not by CI. Hence the
.manual.py suffix (see tally_probe.manual.py alongside).

USAGE
    python agent/tests/tally_edu_probe.manual.py --company "SHREE DEVPURI SALES"
    python agent/tests/tally_edu_probe.manual.py --company "..." --from 7
"""

import argparse
import logging
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402
from tally_schema import MASTERS            # noqa: E402

URL = "http://localhost:9000"


def alive(conn) -> bool:
    """Is Tally still answering at all? The cheapest possible question."""
    try:
        conn.company_info()
        return True
    except Exception:
        return False


def checks(conn, company):
    """Every distinct thing the agent asks Tally for, as (label, callable)."""
    out = [
        ("company_full_info", lambda: conn.company_full_info(company=company)),
        ("ledger_list", lambda: conn.ledger_list(company=company)),
        ("group_list", lambda: conn.group_list(company=company)),
        ("godown_list", lambda: conn.godown_list(company=company)),
        ("stock_summary", lambda: conn.stock_summary(company=company)),
    ]
    # Every registered master collection, by its own name — the gate is skipped
    # on purpose: the question here is what Tally CAN serve, not what the F11
    # flags say it should.
    for spec in MASTERS:
        out.append(("master:" + spec.collection_type,
                    (lambda s=spec: conn.fetch_master(s.kind, company=company,
                                                      features={s.requires_feature: "Yes"}
                                                      if s.requires_feature else None))))
    out += [
        ("report:financial_reports", lambda: conn.financial_reports(company=company)),
        ("report:extra_reports", lambda: conn.extra_reports(company=company)),
        ("party_ledger_names", lambda: conn.party_ledger_names(company=company)),
    ]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--company", required=True)
    ap.add_argument("--from", dest="start", type=int, default=0,
                    help="resume at this index after restarting Tally")
    ap.add_argument("--url", default=URL)
    args = ap.parse_args()

    logging.basicConfig(level=logging.CRITICAL)      # the probe does its own talking
    conn = TallyConnector(url=args.url)
    conn.log = logging.getLogger("probe")
    # The skip store must NOT hide an offender from this run — finding them is
    # the entire point.
    conn._poison = set()

    if not alive(conn):
        print("Tally is not answering on " + args.url +
              ". Start it (and close any error box) first.")
        return 1

    items = checks(conn, args.company)
    print("%d requests to try, starting at %d\n" % (len(items), args.start))
    ok, dead = [], None
    for i, (label, call) in enumerate(items):
        if i < args.start:
            continue
        print("[%2d] %-34s " % (i, label), end="", flush=True)
        t0 = time.time()
        try:
            call()
            note = "ok"
        except Exception as exc:                    # noqa: BLE001
            note = "raised: " + str(exc)[:70]
        took = time.time() - t0
        if not alive(conn):
            print("KILLED TALLY  (%.1fs)" % took)
            dead = (i, label)
            break
        print("%-14s %.1fs" % (note.split(":")[0], took))
        ok.append(label)

    print("\n---- result ----")
    print("served without killing Tally: %d" % len(ok))
    if dead:
        i, label = dead
        print("KILLED TALLY: %s" % label)
        print("Restart TallyPrime, then continue with:  --from %d" % (i + 1))
        return 2
    print("nothing here killed Tally.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
