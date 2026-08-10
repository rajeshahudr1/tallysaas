"""Local Tally Prime connector for the Tally Sync Agent.

Talks to a running Tally Prime instance over HTTP/XML on
``http://localhost:9000``. Tally Prime exposes a small XML gateway: you
POST a Tally ``ENVELOPE`` request (an ``EXPORT`` to read data, or an
``IMPORT`` to create masters/vouchers) and it replies with XML.

Connectivity requirement (must be enabled on the customer PC):
    TallyPrime -> F1 (Help) -> Settings -> Connectivity ->
    "Client/Server configuration": set as **Server**, Port **9000**.
Without that, nothing here can reach Tally and every call raises
:class:`TallyUnavailable` with a human-friendly hint.

Design rules: every external call is wrapped. Transport problems
(connection refused, timeout) become :class:`TallyUnavailable` so the
main loop can log + retry instead of crashing. Tally's XML is famously
quirky (mixed encodings, missing closing tags, ``&#4;`` control chars),
so parsing is best-effort and tolerant.
"""

from __future__ import annotations

import json
import logging
import re
import time
import xml.etree.ElementTree as ET
from typing import Any, Optional

import requests

from tally_schema import BY_KIND, MASTERS, RESERVED_VOUCHER_TYPES


# A process-unique nonce for voucher-collection NAMES. Tally caches an inline TDL
# collection by NAME for the session AND poisons it (serves empty forever) if it
# ever returns empty during a heavy/degraded moment. A brand-new name ALWAYS
# evaluates fresh + correct, so every voucher fetch uses a unique name.
_vch_call_counter = 0


def _vch_nonce() -> str:
    global _vch_call_counter
    _vch_call_counter += 1
    return "%x%x" % (int(time.time()) & 0xFFFFFF, _vch_call_counter)


class TallyUnavailable(Exception):
    """Raised when Tally Prime cannot be reached or refuses the request."""


class TallySkipped(TallyUnavailable):
    """Raised for a request this run has ALREADY seen TallyPrime die on.

    A subclass of TallyUnavailable so every existing caller keeps handling it
    the way it handles "Tally could not answer" — the difference matters to the
    log, not to the control flow.
    """


# Requests TallyPrime has died on, shared by EVERY connector in this process.
#
# It CANNOT live on the instance. A new TallyConnector is built for each sync
# cycle, so a per-instance quarantine forgot everything the moment the cycle
# ended — the next cycle sent the same fatal request and killed Tally again, a
# minute later, forever. Learning it once per process is the difference between
# one crash and one crash every interval.
_POISON: set[str] = set()

# Every collection label the agent can send, WITHOUT the per-fetch nonce. Used
# by _poison_key to recognise "this nonced name is really that known request".
# Longest first, so a shorter name can never claim a longer one's prefix.
_COLLECTION_STEMS: tuple = tuple(sorted(
    ["Collection TSSM" + _m.collection_type for _m in MASTERS]
    + ["Collection TSSRec" + _m.collection_type for _m in MASTERS]
    + ["Collection " + _n for _n in ("TSSCmpFull", "TSSGodownColl", "TSSGroupColl",
                                     "TSSLedgerColl", "TSSStockColl", "TSSVch")],
    key=len, reverse=True))

# The delete detector (master_ids) asks for the SAME Tally object type under
# "TSSRec<Type>" that the master pull asks for under "TSSM<Type>". An object
# type this company cannot serve kills Tally down either path, so both must
# share one quarantine entry — keyed on the object type, not on the name we
# happened to ask under. Without this the store grew a second entry for one
# broken type, after crashing Tally a second time to learn it.
_RECONCILE_ALIASES: dict = {
    "Collection TSSRec" + _m.collection_type: "Collection TSSM" + _m.collection_type
    for _m in MASTERS
}

# Where that set is REMEMBERED between runs. Set once at startup (see
# use_skip_store). Without it the knowledge died with the process: the service
# restarts — after an update, a reboot, or because the operator pressed Stop and
# Start — and the very first cycle of the new process crashes TallyPrime again
# to re-learn what the old one already knew. Once per install, not once per
# lifetime of a process.
_POISON_FILE: Optional[str] = None


# WHICH TallyPrime taught us the quarantine. Not an edition check — nothing here
# decides what any value MEANS. It only notices when the product answering on
# :9000 stops being the one whose limits we learned, because those limits are a
# property of that Tally and not of the company: TDS, TCS and the payroll
# masters are absent on a TallyPrime EDU and real data the day a licence is
# activated. Without this the agent would go on skipping them forever, silently,
# because a file written weeks earlier said they were fatal.
#
# Deliberately NOT "detect Educational and disable those masters": a wrong guess
# there fails in the worse direction — it drops real data on a licensed machine.
# A changed identity only ever causes RE-LEARNING, and the worst case of a false
# change is one repeated crash we already survive.
_TALLY_IDENTITY: str = ""


def _identity_of(response: str) -> str:
    """The product identity carried in every response HEADER, or "".

    Free: it is in the reply to whatever we just asked, so this costs no extra
    round trip and cannot itself upset Tally.
    """
    parts = []
    for tag in ("PRODTYPE", "PRODMAJORVER", "PRODMINORVER",
                "PRODMAJORREL", "PRODMINORREL"):
        m = re.search("<" + tag + r">(.*?)</" + tag + ">", response or "", re.I | re.S)
        # Whatever this build reports, in a fixed order. Demanding all five
        # would make a build that omits one look like "no identity" forever, so
        # the store could never reset on it; PRODTYPE alone is enough to notice
        # a change, and the rest sharpen it when present.
        parts.append(m.group(1).strip() if m else "")
    return "/".join(parts) if parts[0] else ""


def note_tally_identity(response: str) -> None:
    """Compare the answering Tally against the one the store was learned on.

    Same Tally (or an unreadable header): keep everything. A DIFFERENT one:
    forget the quarantine and write that through, so the next process does not
    reload the stale list and undo it.
    """
    global _TALLY_IDENTITY
    ident = _identity_of(response)
    if not ident:
        return
    if not _TALLY_IDENTITY:
        # First sighting — including a store written by an older build, which
        # carries no identity. Adopt it rather than discarding a real crash list,
        # and WRITE IT DOWN NOW. Persisting only alongside a new quarantine was
        # not enough: on a machine whose list is already complete nothing more is
        # ever quarantined, so the file kept no identity, every process adopted
        # whatever it first saw, and a licence change would be compared against
        # nothing and pass unnoticed — leaving the stale skips in place forever.
        _TALLY_IDENTITY = ident
        _save_skip_store()
        return
    if ident == _TALLY_IDENTITY:
        return
    _TALLY_IDENTITY = ident
    _POISON.clear()
    _save_skip_store()


def use_skip_store(path: str) -> None:
    """Point the quarantine at a file and load what is already in it.

    Accepts both shapes: the current {"tally": ..., "labels": [...]} and the
    bare list older builds wrote. Wholly best-effort — an unreadable or corrupt
    store just means the agent re-learns the hard way, which is exactly where it
    was before the file existed. It must never stop the agent from starting.
    """
    global _POISON_FILE, _TALLY_IDENTITY
    _POISON_FILE = path
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            _TALLY_IDENTITY = str(data.get("tally") or "")
            labels = data.get("labels") or []
        else:
            labels = data or []          # older build: a bare list, no identity
        for label in labels:
            if isinstance(label, str) and label.strip():
                _POISON.add(label.strip())
    except Exception:                                       # noqa: BLE001
        pass


def _save_skip_store() -> None:
    """Persist the quarantine. Best-effort, for the same reason as loading it."""
    if not _POISON_FILE:
        return
    try:
        with open(_POISON_FILE, "w", encoding="utf-8") as fh:
            json.dump({"tally": _TALLY_IDENTITY, "labels": sorted(_POISON)},
                      fh, indent=1)
    except Exception:                                       # noqa: BLE001
        pass


def _killed_tally(exc: BaseException) -> bool:
    """True when the failure looks like Tally dying MID-REQUEST.

    A refused connection means Tally is not running; that is ordinary and
    retryable. A connection closed with no response, on a request Tally had
    already accepted, means it fell over while serving it — the desktop symptom
    is "Internal Error. Contact Tally Solutions. Incorrect Object Type!", which
    happens when a company is asked for an object type it does not have (TDS
    masters on a company with TDS switched off, say). Retrying that only kills
    Tally again after the customer restarts it.
    """
    text = repr(exc).lower()
    return ("remotedisconnected" in text
            or "connection aborted" in text
            or "without response" in text)


# Default Tally XML gateway endpoint and per-request timeout.
DEFAULT_URL = "http://localhost:9000"
TIMEOUT = 30  # seconds; large exports (stock summary) can be slow

# Transient-failure retry for Tally requests. Tally is a desktop app that stalls
# while the user opens a report or switches company; a request landing in that
# window fails though Tally is fine a second later. See TallyConnector.send.
SEND_RETRIES = 2      # extra attempts after the first (so 3 total)
SEND_BACKOFF = 0.5    # seconds; doubles per attempt


class TallyConnector:
    """Send/receive Tally XML and build the common request envelopes.

    Parameters
    ----------
    url:
        Tally XML gateway URL, e.g. ``http://localhost:9000``. Defaults to
        :data:`DEFAULT_URL` when falsy.
    logger:
        A :class:`logging.Logger` (from ``logger.get_logger``) used to record
        every request and failure.
    """

    def __init__(self, url: str = DEFAULT_URL, logger: Optional[logging.Logger] = None,
                 envelopes=None) -> None:
        self.url = (url or DEFAULT_URL).rstrip("/")
        self.log = logger or logging.getLogger(__name__)
        # OPTIONAL server-published queries (an envelope_store.EnvelopeStore).
        # When present, a report the server publishes is pulled WITHOUT a new
        # exe. When absent — no network, an unverified set, an old build — the
        # compiled-in XML below still runs, so shipping envelopes can never make
        # the agent worse than it was.
        self.envelopes = envelopes
        self._session = requests.Session()
        # Gentle request throttle (see send()) — timestamp of the last request so
        # we never fire Tally calls back-to-back.
        self._last_send = 0.0
        # Shared with every other connector in this process — see _POISON.
        self._poison = _POISON
        # Labels already announced at INFO this run (see _send_once).
        self._seen_labels: set[str] = set()
        # Label of the request currently in flight (see _req_label). Tally is a
        # desktop app that can DIE on a request it dislikes ("Internal Error.
        # Contact Tally Solutions. Incorrect Object Type!"), and the agent then
        # sees only a bare RemoteDisconnected — with no way to tell WHICH of the
        # ~20 reports a pull sends was the one that killed it. Carrying the label
        # into the error line makes the culprit obvious in a normal INFO log.
        self._last_label = "?"

    # ------------------------------------------------------------------ #
    # Transport
    # ------------------------------------------------------------------ #
    def is_available(self) -> bool:
        """Quick probe: is Tally reachable on the configured URL?

        A BARE HTTP GET, deliberately — no TDL, no collection, no report. The
        probe used to send the company-list export, which meant the cheapest,
        most frequent call the agent makes was also one of the heaviest: Tally
        had to compile and evaluate TDL just to answer "are you there". Worse,
        when that envelope was malformed it put a modal error box on Tally and
        wedged it — and the probe then re-sent the same thing every few seconds.

        A GET asks the gateway to prove only what is being asked: that it is
        listening and speaking HTTP. Any reply at all is a yes; Tally answers
        even an unrecognised GET. Never raises — ``False`` means "down", and the
        caller's next move (start Tally, skip the cycle) is the same either way.
        """
        try:
            # 4s: a listening gateway on localhost answers in milliseconds, and
            # a probe that can hang for the full request timeout is a probe that
            # blocks the thing it was meant to make responsive.
            resp = self._session.get(self.url, timeout=4)
            return resp is not None
        except Exception as exc:  # noqa: BLE001 - probe must never raise
            self.log.debug("Tally probe failed: %s", exc)
            return False

    def send(self, xml: str, timeout: "int | None" = None,
             retries: "int | None" = None) -> str:
        """POST a Tally XML envelope and return the raw response text.

        ``timeout`` overrides the module default (used by the voucher pull, whose
        chunked collections can be a couple of MB and need longer than a master read).

        Retries transient failures with exponential backoff. Tally is a DESKTOP
        app: it stalls while the user opens a report, recalculates, or switches
        company, and a request landing in that window fails even though Tally is
        perfectly healthy a second later. Without a retry, one such blip cost the
        whole company its cycle — masters, vouchers and all — and the log blamed
        "Tally unavailable". ``retries=0`` disables it (used by the probe, where
        a fast negative IS the answer).

        Raises
        ------
        TallyUnavailable
            After the final attempt: on any transport-level error (connection
            refused, timeout, DNS), or a non-2xx HTTP status.
        """
        attempts = SEND_RETRIES if retries is None else int(retries)
        last: Exception | None = None
        for attempt in range(attempts + 1):
            try:
                return self._send_once(xml, timeout)
            except TallyUnavailable as exc:
                last = exc
                if attempt >= attempts:
                    break
                # 0.5s, 1s, 2s … — long enough for a mid-recalculation Tally to
                # come back, short enough not to stall the cycle.
                delay = SEND_BACKOFF * (2 ** attempt)
                self.log.warning("Tally request failed (attempt %d/%d), retrying in %.1fs: %s",
                                 attempt + 1, attempts + 1, delay, exc)
                time.sleep(delay)
        raise last if last else TallyUnavailable("Tally request failed.")

    @staticmethod
    def _req_label(xml: str) -> str:
        """A short human label for a request: its TYPE, ID and target company.

        Only for diagnostics. Tally kills itself on some requests, so the label
        of the request IN FLIGHT is the single most useful thing an error line
        can carry — without it the log says "Tally is not reachable" and names
        none of the twenty reports the pull just sent.
        """
        def _tag(name: str) -> str:
            m = re.search("<" + name + r">(.*?)</" + name + ">", xml or "", re.S | re.I)
            return (m.group(1).strip()[:60] if m else "")
        parts = [p for p in (_tag("TYPE"), _tag("ID")) if p]
        company = _tag("SVCURRENTCOMPANY")
        if company:
            parts.append("company=" + company)
        return " ".join(parts) or "(unlabelled request)"

    @staticmethod
    def _poison_key(label: str) -> str:
        """The part of a request label that identifies WHAT was asked for.

        Labels carry the company ("Collection TSSMTDSCategory company=ACME"),
        but an object type TallyPrime cannot serve is a property of the TDL, not
        of the company. Quarantining the whole label meant the second company in
        a multi-company Tally crashed it a second time — one avoidable crash per
        company. The key drops the company so the first crash protects them all.
        """
        key = str(label).split(" company=")[0].strip()
        # …and the cache-busting nonce. An AlterID-filtered collection is sent
        # under a unique name every time (Tally caches a TDL definition by name
        # for the session — see _collection_request_xml), so the incremental
        # path asks for "Collection TSSMTDSCategory75d7c310" while the store
        # learned "Collection TSSMTDSCategory". Different strings, so from the
        # second cycle on the quarantine matched nothing and the request that
        # kills Tally went out again under a new name, every single cycle.
        #
        # Collapsed onto a KNOWN name rather than by stripping trailing hex:
        # the nonce is bare hex with no separator, and real names end in hex
        # letters too (PayHead 'd', VoucherType 'e'), so stripping would corrupt
        # those into keys of their own.
        for stem in _COLLECTION_STEMS:
            if len(key) > len(stem) and key.startswith(stem) \
                    and all(c in "0123456789abcdefABCDEF" for c in key[len(stem):]):
                key = stem
                break
        # Finally, the two names for one object type collapse together.
        return _RECONCILE_ALIASES.get(key, key)

    # THE LIFELINE. Without these there is no sync at all, so "skip it from now
    # on" can never be the right answer for them — if one is truly broken we
    # want it failing loudly every cycle, not disappearing into a file.
    #
    # They need protecting because the quarantine's evidence is circumstantial:
    # when Tally dies EVERY request in flight sees the same dropped connection,
    # including ones that had nothing to do with it. On a live machine an
    # unrelated crash landed while the agent was asking which companies were
    # open, and "Collection List of Companies" went into the skip store — which
    # is on disk, so the agent found no company, synced nothing, and did so
    # after every restart, silently, forever.
    ESSENTIAL = frozenset({"Collection List of Companies",
                           "Collection Company Info",
                           "Collection List of Companies with Details"})

    @classmethod
    def _is_essential(cls, label: str) -> bool:
        return cls._poison_key(label) in cls.ESSENTIAL

    def _is_poison(self, label: str) -> bool:
        if self._is_essential(label):
            # Stores written by older builds may already name one of these.
            return False
        return self._poison_key(label) in self._poison

    @staticmethod
    def _is_fragile(label: str) -> bool:
        """True for a request whose ABSENCE is known to take TallyPrime down.

        These are the feature_must_be_on collections (TDS/TCS). They matter here
        because "Incorrect Object Type!" presents in TWO ways, and only one of
        them was handled. Usually Tally drops the connection mid-answer, which
        _killed_tally spots. But the error box is MODAL — while it is up, the XML
        server behind it answers nobody — so the other presentation is a request
        that simply never comes back, and a read timeout is not evidence of a
        crash anywhere else in this file.

        The distinction is what makes a timeout safe to act on HERE and nowhere
        else: these are tiny requests against small masters. One that has not
        answered inside the timeout is not busy; it is stuck behind a box. A
        stock summary over three years genuinely can be slow, so quarantining on
        ITS timeout would silently cost the customer real data.
        """
        coll = TallyConnector._poison_key(label).replace(
            "Collection TSSM", "", 1).strip()
        spec = next((s for s in MASTERS if s.collection_type == coll), None)
        return bool(spec is not None and spec.feature_must_be_on)

    @staticmethod
    def _poison_family(label: str) -> set[str]:
        """Every request that should be quarantined along with ``label``.

        When TallyPrime dies on one master, its SIBLINGS behind the same F11
        feature are about to die too — TDSCategory and TDSRate are the same
        feature, served by the same part of Tally, and a company that cannot
        answer for one cannot answer for the other. Quarantining the label
        alone meant the customer's Tally fell over once per master: crash on
        TDSCategory this cycle, on TDSRate the next, and so on down the family.
        One crash should buy the whole answer.
        """
        key = TallyConnector._poison_key(label)
        out = {key}
        coll = key.replace("Collection TSSM", "", 1).strip()
        spec = next((s for s in MASTERS if s.collection_type == coll), None)
        if spec is None:
            return out
        if spec.feature_must_be_on:
            # feature_must_be_on marks the types whose ABSENCE crashes Tally
            # rather than returning nothing. A Tally that has just proved it
            # crashes on one of them will crash on the others — this build,
            # this edition, this company's data. Losing those few masters costs
            # a table; finding out one crash at a time costs the customer their
            # accounting software, twice more.
            for sib in MASTERS:
                if sib.feature_must_be_on:
                    out.add("Collection TSSM" + sib.collection_type)
            return out
        for sib in MASTERS:
            if spec.requires_feature and sib.requires_feature == spec.requires_feature:
                out.add("Collection TSSM" + sib.collection_type)
        return out

    def _send_once(self, xml: str, timeout: "int | None" = None) -> str:
        """One POST attempt — the transport half of :meth:`send`."""
        label = self._req_label(xml)
        self._last_label = label
        if self._is_poison(label):
            # Already known to kill Tally on this machine — see the handler
            # below. Refusing here keeps the retry loop from re-sending it and
            # keeps the next cycle from starting the whole thing again.
            raise TallySkipped(
                "Skipping [" + label + "]: TallyPrime closed the connection on "
                "it earlier in this run.")
        # BREADCRUMB. Logged at INFO the first time each distinct request goes
        # out in a run — about twenty lines, once. Tally can die MID-request and
        # take the process's chance to log anything with it, so without a line
        # written BEFORE the send, a crash leaves no record of what caused it.
        # That gap cost three rounds of guessing at an "Incorrect Object Type!"
        # box; the label was only at DEBUG, which nobody has on when it happens.
        if label not in self._seen_labels:
            self._seen_labels.add(label)
            self.log.info("Tally request -> %s", label)
        else:
            self.log.debug("Tally request: %s", label)
        # Gentle throttle: never fire Tally requests back-to-back. A minimum gap
        # keeps Tally stable AND avoids tripping a licence's abnormal-access guard
        # (request floods can get a Tally licence temporarily locked).
        gap = 0.12 - (time.monotonic() - self._last_send)
        if gap > 0:
            time.sleep(gap)
        self._last_send = time.monotonic()
        try:
            # Tally expects raw bytes; encode explicitly so non-ASCII names
            # (party names, GSTIN) survive the trip.
            resp = self._session.post(
                self.url,
                data=xml.encode("utf-8"),
                headers={"Content-Type": "text/xml"},
                timeout=timeout or TIMEOUT,
            )
        except (requests.ConnectionError, requests.Timeout) as exc:
            # A RemoteDisconnected here means Tally dropped the connection while
            # SERVING this request — i.e. it crashed on it. Naming the request is
            # what turns "Tally is down" into "Tally dies on THIS report".
            self.log.error("Tally transport error on [%s]: %s", label, exc)
            # Either presentation of the same fault: Tally closed the connection,
            # or Tally stopped answering because its modal error box is up. See
            # _is_fragile for why a timeout counts only for these requests.
            hung = isinstance(exc, requests.Timeout) and self._is_fragile(label)
            if (_killed_tally(exc) or hung) and not self._is_essential(label):
                # QUARANTINE IT. Tally did not merely fail to answer — it died
                # mid-answer, which is what an object type it does not support
                # looks like from this side ("Internal Error … Incorrect Object
                # Type!" on screen). Retrying is actively harmful: the customer
                # restarts Tally, the same request goes out again, and Tally
                # dies again. One master that this company cannot serve should
                # cost that master, not the whole sync.
                for key in self._poison_family(label):
                    self._poison.add(key)
                _save_skip_store()
                self.log.error(
                    "Tally %s on [%s] — that request will be skipped from now "
                    "on. If this company does not use that feature, this is "
                    "expected.",
                    "STOPPED ANSWERING (its error box is up)" if hung
                    else "CLOSED THE CONNECTION", label)
            raise TallyUnavailable(
                "Tally Prime is not reachable on "
                + self.url
                + " (request: " + label + ")."
                + " Is Tally running with the XML port enabled?"
            ) from exc
        except requests.RequestException as exc:
            self.log.error("Tally request error on [%s]: %s", label, exc)
            raise TallyUnavailable(
                "Tally Prime is not reachable on "
                + self.url
                + " (request: " + label + ")."
                + " Is Tally running with the XML port enabled?"
            ) from exc

        if resp.status_code >= 400:
            self.log.error("Tally HTTP %s on [%s]: %s", resp.status_code, label,
                           resp.text[:200])
            raise TallyUnavailable(
                "Tally Prime returned HTTP "
                + str(resp.status_code)
                + " from "
                + self.url
                + "."
            )

        # Tally usually replies as UTF-16; let requests guess but fall back.
        try:
            text = resp.text
        except Exception:  # noqa: BLE001 - decode quirks
            text = resp.content.decode("utf-8", errors="replace")
        # DEBUG diagnostic (log_level=DEBUG): the response size per request tells
        # us at a glance whether Tally answered with data or an empty/error body.
        self.log.debug("Tally HTTP %s, %d bytes response.", resp.status_code, len(text or ""))
        # Free when it is there. A Collection export's HEADER comes back empty,
        # so this alone is not enough — check_identity() below asks explicitly
        # once a cycle. Both feed the same comparison.
        note_tally_identity(text)
        return text

    # ------------------------------------------------------------------ #
    # High-level reads
    # ------------------------------------------------------------------ #
    def check_identity(self) -> str:
        """Ask WHICH TallyPrime this is, and reset the quarantine if it changed.

        One small request per cycle. It has to be explicit because a Collection
        export answers with an EMPTY <HEADER> — the product identity only comes
        back on a Function export, which this is. Measured against the live
        gateway: it answers in milliseconds and returns the full version quad
        plus PRODTYPE, twice out of two.

        Nothing here interprets the values (see note_tally_identity for why
        reading them as "this is Educational" would be the dangerous design).
        It exists so that activating a licence stops the agent skipping the
        masters that Educational mode could not serve — otherwise a file written
        weeks earlier would suppress real TDS and payroll data forever.

        Best-effort: on any failure we simply keep what we know. This must never
        be the reason a cycle does not run.
        """
        xml = ("<ENVELOPE><HEADER><VERSION>1</VERSION>"
               "<TALLYREQUEST>Export</TALLYREQUEST><TYPE>Function</TYPE>"
               "<ID>$$LicenseInfo</ID></HEADER><BODY><DESC><FUNCPARAMLIST>"
               "<PARAM>IsEducationalMode</PARAM></FUNCPARAMLIST></DESC></BODY>"
               "</ENVELOPE>")
        try:
            self.send(xml, timeout=15)     # send() notes the identity for us
        except Exception:                                   # noqa: BLE001
            pass
        return _TALLY_IDENTITY

    def company_info(self) -> dict[str, Any]:
        """Return basic info about the open company / list of companies.

        Sends the "List of Companies" export and parses it best-effort into
        ``{"companies": [{"name": ...}, ...], "active": <first name or None>}``.
        Tolerates Tally's quirky XML; on a parse miss returns an empty list
        rather than raising (transport errors still raise
        :class:`TallyUnavailable`).
        """
        xml = self.send(self._companies_request_xml())
        root = self._safe_parse(xml)
        companies: list[dict[str, Any]] = []
        if root is not None:
            # Company names show up under <COMPANY NAME="..."> or as text in
            # <COMPANYNAME>/<SVCURRENTCOMPANY> depending on the export collection.
            for el in root.iter():
                tag = self._localname(el.tag).upper()
                name = (el.get("NAME") or el.get("Name") or "").strip()
                if tag == "COMPANY" and name:
                    companies.append({"name": name})
                elif tag in ("COMPANYNAME", "SVCURRENTCOMPANY") and (el.text or "").strip():
                    companies.append({"name": el.text.strip()})
        # De-duplicate while preserving order.
        seen: set[str] = set()
        unique = []
        for c in companies:
            if c["name"] not in seen:
                seen.add(c["name"])
                unique.append(c)
        active = unique[0]["name"] if unique else None
        return {"companies": unique, "active": active}

    def company_full_info(self, company: Optional[str] = None) -> dict[str, Any]:
        """Fetch the open company's FULL master so the cloud company record mirrors
        Tally: address, state, pincode, country, email, phone, GSTIN, PAN, and the
        financial-year start. Returns ``{}`` on miss. Best-effort."""
        xml = self._collection_request_xml(
            "TSSCmpFull", "Company",
            ["NAME", "GUID", "MASTERID", "ALTERID", "FORMALNAME", "MAILINGNAME",
             "ADDRESS", "STATENAME", "CMPSTATENAME", "PINCODE", "COUNTRYNAME",
             "EMAIL", "PHONENUMBER", "MOBILENUMBERS", "CMPGSTIN",
             "GSTREGISTRATIONNUMBER", "INCOMETAXNUMBER", "TANNUMBER", "CINNUMBER",
             "STARTINGFROM", "BOOKSFROM", "ENDINGAT",
             "CURRENCYNAME", "ISSECURITYON",
             # F11 feature flags — they decide which optional collections are even
             # worth pulling for this company (bill-wise, cost centres, batches …).
             "ISINVENTORYON", "ISBILLWISEON", "ISCOSTCENTRESON", "ISMULTIGODOWNON",
             "ISBATCHON", "ISPAYROLLON", "ISMULTICURRENCYON",
             # Gates for the TDS/TCS masters: a company with these off
             # has no such objects, and asking anyway kills Tally.
             "ISTDSON", "ISTCSON"],
            # Scope to the REQUESTED company. This used to pass None, so in a
            # multi-company Tally every company in the loop got whichever company
            # happened to be active — every cloud company mirrored the same master.
            company)
        root = self._safe_parse(self.send(xml, timeout=60))
        if root is None:
            return {}
        want = (company or "").strip().lower()

        def _fy(s: str) -> Optional[str]:
            m = re.match(r"^(\d{4})(\d{2})(\d{2})$", str(s or "").strip())
            return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None

        for el in root.iter():
            if self._localname(el.tag).upper() != "COMPANY":
                continue
            nm = (el.get("NAME") or "").strip() or self._child_text(el, "NAME")
            if not nm:
                continue
            # Belt-and-braces: even scoped, a Tally build may echo every loaded
            # company. Never return someone else's master under this name.
            if want and nm.strip().lower() != want:
                continue
            lines = [a.text.strip() for a in el.iter()
                     if self._localname(a.tag).upper() == "ADDRESS" and (a.text or "").strip()]
            return {
                "name": nm,
                # Tally's STABLE per-company GUID — the cloud dedups companies on
                # this (NOT the mutable name), so a renamed/blank-named company
                # never spawns a duplicate. None if Tally didn't return it (then
                # the cloud falls back to name matching).
                "guid": self._guid(el),
                "master_id": self._masterid(el),
                "alterid": self._alterid(el),
                "formal_name": self._child_text(el, "FORMALNAME") or None,
                "mailing_name": self._child_text(el, "MAILINGNAME") or None,
                "email": self._child_text(el, "EMAIL") or None,
                "pincode": self._child_text(el, "PINCODE") or None,
                "state": (self._child_text(el, "STATENAME")
                          or self._child_text(el, "CMPSTATENAME") or None),
                "country": self._child_text(el, "COUNTRYNAME") or None,
                "pan": self._child_text(el, "INCOMETAXNUMBER") or None,
                "tan": self._child_text(el, "TANNUMBER") or None,
                "cin": self._child_text(el, "CINNUMBER") or None,
                "currency": self._child_text(el, "CURRENCYNAME") or None,
                "gstin": (self._child_text(el, "CMPGSTIN")
                          or self._child_text(el, "GSTREGISTRATIONNUMBER") or None),
                # Tally keeps landline (PHONENUMBER) and mobile (MOBILENUMBERS)
                # separately — mirror that instead of collapsing into one.
                "phone": self._child_text(el, "PHONENUMBER") or None,
                "mobile": self._child_text(el, "MOBILENUMBERS") or None,
                "address": "\n".join(lines) or None,
                "books_from": _fy(self._child_text(el, "STARTINGFROM")
                                  or self._child_text(el, "BOOKSFROM")),
                "books_to": _fy(self._child_text(el, "ENDINGAT")),
                # F11 feature flags, kept verbatim. fetch_all_masters() reads
                # these to skip collections the company does not use (a company
                # without payroll has no Employee collection at all).
                "features": {
                    tag: self._child_text(el, tag)
                    for tag in ("ISINVENTORYON", "ISBILLWISEON", "ISCOSTCENTRESON",
                                "ISMULTIGODOWNON", "ISBATCHON", "ISPAYROLLON",
                                "ISMULTICURRENCYON", "ISSECURITYON",
                                "ISTDSON", "ISTCSON")
                    if self._child_text(el, tag)
                },
            }
        return {}

    # ------------------------------------------------------------------ #
    # Financial reports — pulled VERBATIM from Tally so the cloud mirrors
    # them EXACTLY (no reconstruction → no inventory/opening-balance drift).
    # ------------------------------------------------------------------ #
    def _report_xml(self, report_id: str, company: Optional[str],
                    from_date: Optional[str] = None,
                    to_date: Optional[str] = None) -> str:
        """EXPORT one of Tally's built-in financial reports as XML.

        ``from_date``/``to_date`` are Tally YYYYMMDD. WITHOUT them Tally answers
        for whatever period the company is currently open at — so the cloud got
        one unlabelled snapshot and could never show last year's Balance Sheet,
        nor say which period the figures it holds belong to. With them the same
        report can be pulled per financial year.
        """
        cmp_xml = ("<SVCURRENTCOMPANY>" + self._esc(company) + "</SVCURRENTCOMPANY>") if company else ""
        period = ""
        if from_date:
            period += "<SVFROMDATE>" + self._esc(from_date) + "</SVFROMDATE>"
        if to_date:
            period += "<SVTODATE>" + self._esc(to_date) + "</SVTODATE>"

        # A server-published envelope wins when there is one, so a report can be
        # changed or added centrally. The built-in request below is the fallback,
        # never the dead code path: it is what runs when the agent is offline,
        # when a set fails verification, and for every report nobody has
        # published an override for.
        published = self._published_envelope(report_id)
        if published:
            return self.send(self._with_context(published, cmp_xml, period), timeout=60)

        req = (
            "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>"
            "<TYPE>Data</TYPE><ID>" + self._esc(report_id) + "</ID></HEADER>"
            "<BODY><DESC><STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>" + cmp_xml + period +
            "</STATICVARIABLES></DESC></BODY></ENVELOPE>"
        )
        return self.send(req, timeout=60)

    # ── Server-published envelopes ────────────────────────────────────────
    @staticmethod
    def envelope_key(report_id: str) -> str:
        """The envelope name a report is published under.

        'Balance Sheet' -> 'report:balance_sheet'. Normalised so the server side
        can be written in readable English without the two sides having to agree
        on punctuation.
        """
        slug = re.sub(r"[^a-z0-9]+", "_", str(report_id or "").lower()).strip("_")
        return "report:" + slug

    def _published_envelope(self, report_id: str) -> Optional[str]:
        """A server-published override for this report, or None.

        Every failure is a None, never an exception: an envelope problem must
        degrade to the built-in query, not stop the sync. The store has already
        verified the signature and refused anything that could write, so
        reaching here means the XML is safe to send.
        """
        # getattr, not self.envelopes: a subclass or a test double that builds
        # itself without calling __init__ must fall back to the built-in query,
        # not raise AttributeError halfway through a report pull. Same rule as
        # everywhere else here — an envelope problem degrades, never breaks.
        store = getattr(self, "envelopes", None)
        if store is None:
            return None
        try:
            return store.xml(self.envelope_key(report_id)) or None
        except Exception as exc:      # noqa: BLE001
            self.log.debug("No published envelope for %s (%s)", report_id, exc)
            return None

    def _with_context(self, xml: str, cmp_xml: str, period: str) -> str:
        """Inject company + period into a published envelope.

        The server cannot know which company is open or which financial year is
        being pulled, so it publishes the SHAPE of the query and the agent fills
        in the context. Injected into the existing STATICVARIABLES block when
        there is one; anything already specifying its own company or period is
        left untouched, since that was a deliberate choice by whoever published
        it.
        """
        extra = (cmp_xml or "") + (period or "")
        if not extra:
            return xml
        if "SVCURRENTCOMPANY" in xml and cmp_xml:
            extra = period or ""
        if "SVFROMDATE" in xml and period:
            extra = cmp_xml if "SVCURRENTCOMPANY" not in xml else ""
        if not extra:
            return xml
        if "</STATICVARIABLES>" in xml:
            return xml.replace("</STATICVARIABLES>", extra + "</STATICVARIABLES>", 1)
        # No STATICVARIABLES block: leave it exactly as published rather than
        # guessing at a structure we did not write.
        return xml

    # ── Financial years ───────────────────────────────────────────────────
    @staticmethod
    def financial_years(count: int = 2) -> list[dict[str, str]]:
        """The last ``count`` Indian financial years, newest first.

        Each entry is ``{label, from_date, to_date}`` with Tally YYYYMMDD dates —
        e.g. ``{'label': '2026-27', 'from_date': '20260401', 'to_date': '20270331'}``.
        The label is what the cloud stores alongside a report, so a figure can
        never be shown under the wrong year.
        """
        import datetime
        today = datetime.date.today()
        start = today.year if today.month >= 4 else today.year - 1
        out: list[dict[str, str]] = []
        for i in range(max(1, count)):
            y = start - i
            out.append({
                "label": "%04d-%02d" % (y, (y + 1) % 100),
                "from_date": "%04d0401" % y,
                "to_date": "%04d0331" % (y + 1),
            })
        return out

    @staticmethod
    def _rx_amt(s: str) -> float:
        s = re.sub(r"[^0-9.\-]", "", str(s or ""))
        try:
            return float(s) if s not in ("", "-", ".") else 0.0
        except ValueError:
            return 0.0

    def financial_reports(self, company: Optional[str] = None,
                          from_date: Optional[str] = None,
                          to_date: Optional[str] = None) -> dict[str, Any]:
        """Pull Tally's EXACT Balance Sheet / Profit&Loss / Trial Balance so the
        cloud shows them verbatim. Each is best-effort ({} on a miss).

        With no dates this asks for the company's current period, exactly as
        before. Pass a financial year's dates to pull that year instead.
        """
        specs = (
            ("balance_sheet",     "Balance Sheet",     self._parse_balance_sheet),
            ("profit_loss",       "Profit and Loss",   self._parse_pl),
            ("trial_balance",     "Trial Balance",     self._parse_tb),
            ("sales_register",    "Sales Register",    self._parse_register),
            ("purchase_register", "Purchase Register", self._parse_register),
            ("stock_summary",     "Stock Summary",     self._parse_stock),
            # Group Summary is the Dr/Cr closing of every GROUP and ledger with
            # its GUID and parent GUID — Tally's own account tree with figures
            # attached. It is what lets a Balance Sheet line be drilled into
            # without re-deriving the hierarchy from ledger parents.
            ("group_summary",     "Group Summary",     self._parse_group_summary),
        )
        out: dict[str, Any] = {}
        for key, report_id, parse in specs:
            try:
                out[key] = parse(self._report_xml(report_id, company, from_date, to_date))
            except Exception as exc:      # noqa: BLE001 — one bad report must not
                self.log.warning("%s pull failed: %s", report_id, exc)   # cost the rest
                out[key] = {}
        return out

    # The slugs `financial_reports` above already covers. extra_reports() skips
    # these so a PUBLISHED envelope for one of them stays what it was meant to
    # be — an override of that report's XML — instead of being run a second time
    # and stored again as raw.
    BUILTIN_REPORT_SLUGS: frozenset = frozenset({
        "balance_sheet", "profit_loss", "trial_balance",
        "sales_register", "purchase_register", "stock_summary", "group_summary",
    })

    def extra_reports(self, company: Optional[str] = None,
                      from_date: Optional[str] = None,
                      to_date: Optional[str] = None) -> dict[str, Any]:
        """Run every PUBLISHED report envelope the agent has no parser for.

        WHAT THIS UNLOCKS: adding a Tally report used to need a new exe — a
        request builder, a parser and a release. The server could already publish
        the XML (envelope_store), but nothing ever ran an envelope the agent did
        not already know by name, so `cash_flow`, `ratio_analysis` and
        `godown_summary` sat published and unused. Here they run, and the RAW
        XML goes to the cloud, where a parser is a server-side change.

        Raw on purpose. Parsing is the half that keeps changing (Tally renames
        tags between builds, and every report nests differently), so it belongs
        where it can be fixed without touching a single customer's machine. The
        agent's job is only to ask Tally the question and carry the answer back.

        Returns ``{slug: {"raw": xml, "label": str, "fetched_for": period}}``.
        Best-effort per envelope: one report that fails or times out must not
        cost the others, and no envelope failure may ever break the sync.
        """
        store = getattr(self, "envelopes", None)
        if store is None:
            return {}
        try:
            names = store.names()
        except Exception as exc:          # noqa: BLE001
            self.log.debug("No published envelope set to scan (%s)", exc)
            return {}

        cmp_xml = ("<SVCURRENTCOMPANY>" + self._esc(company) + "</SVCURRENTCOMPANY>") if company else ""
        period = ""
        if from_date:
            period += "<SVFROMDATE>" + self._esc(from_date) + "</SVFROMDATE>"
        if to_date:
            period += "<SVTODATE>" + self._esc(to_date) + "</SVTODATE>"

        out: dict[str, Any] = {}
        for name in names:
            # Only `report:` envelopes are reports. Others (licence info, and
            # whatever is published later) belong to their own call sites and
            # must not be swept into the report table.
            if not str(name).startswith("report:"):
                continue
            slug = str(name)[len("report:"):]
            if not slug or slug in self.BUILTIN_REPORT_SLUGS:
                continue
            try:
                xml = store.xml(name)
                if not xml:
                    continue
                raw = self.send(self._with_context(xml, cmp_xml, period), timeout=60)
            except TallyUnavailable:
                raise                     # Tally is gone — the caller must stop.
            except Exception as exc:      # noqa: BLE001
                self.log.warning("Published report %s failed: %s", name, exc)
                continue
            if not str(raw or "").strip():
                continue
            out[slug] = {"raw": raw, "label": slug.replace("_", " ").title()}
        return out

    def financial_reports_by_year(self, company: Optional[str] = None,
                                  years: int = 2) -> dict[str, dict[str, Any]]:
        """Every report for the last ``years`` financial years, keyed by label.

        ``{'2026-27': {...}, '2025-26': {...}}``. A company whose books start
        mid-way answers the earlier year with empty reports rather than failing,
        so a short history costs nothing but is not silently mislabelled either.
        """
        out: dict[str, dict[str, Any]] = {}
        for fy in self.financial_years(years):
            try:
                out[fy["label"]] = self.financial_reports(
                    company, from_date=fy["from_date"], to_date=fy["to_date"])
            except TallyUnavailable:
                raise                      # Tally is gone — the caller must stop.
            except Exception as exc:       # noqa: BLE001
                self.log.warning("Reports for FY %s failed: %s", fy["label"], exc)
        return out

    def _parse_balance_sheet(self, xml: str) -> dict[str, Any]:
        """BS rows: <BSNAME>..<DSPDISPNAME>name</..></BSNAME> <BSAMT><BSMAINAMT>amt</..>.
        Tally sign: +ve = Liability, -ve = Asset. The balancing 'Difference in
        opening balances' = Σliab − Σasset, placed on the short side."""
        pairs = re.findall(
            r"<BSNAME>.*?<DSPDISPNAME>(.*?)</DSPDISPNAME>.*?</BSNAME>\s*"
            r"<BSAMT>.*?<BSMAINAMT>(.*?)</BSMAINAMT>", xml, re.S)
        liab, asset = [], []
        for name, amt in pairs:
            a = self._rx_amt(amt)
            nm = self._unesc(name).strip()
            if a == 0:
                continue
            if a > 0:
                liab.append({"name": nm, "amount": round(a, 2)})
            else:
                asset.append({"name": nm, "amount": round(-a, 2)})
        lt = round(sum(x["amount"] for x in liab), 2)
        at = round(sum(x["amount"] for x in asset), 2)
        diff = round(lt - at, 2)
        if diff > 0:
            asset.append({"name": "Difference in opening balances", "amount": diff})
        elif diff < 0:
            liab.append({"name": "Difference in opening balances", "amount": -diff})
        total = max(lt, at)
        return {"liabilities": liab, "assets": asset, "total": round(total, 2)}

    def _parse_pl(self, xml: str) -> dict[str, Any]:
        """P&L rows. +ve = credit (income), -ve = debit (expense).

        Real shape (confirmed against a live export):
            <DSPACCNAME><DSPDISPNAME>Sales Accounts</DSPDISPNAME><GUID>…</GUID>
              <ISGROUP>Yes</ISGROUP><BSMAINAMT>30151900.11</BSMAINAMT></DSPACCNAME>
            <PLAMT><BSMAINAMT>30151900.11</BSMAINAMT></PLAMT>

        A row carries EITHER BSMAINAMT (a main group) or PLSUBAMT (a detail
        under the previous main) — never both, and GUID/ISGROUP sit between the
        name and the amount. An earlier version required both amounts adjacent
        to the name, so it matched nothing and the P&L mirrored as empty with no
        error anywhere. Read from the DSPACCNAME block only; the PLAMT sibling
        restates the same figure and counting both doubles every total.

        Only MAIN rows drive the totals: the subs (Opening Stock, Purchases,
        Closing Stock, Direct Expenses) are details UNDER 'Cost of Sales', so
        including them would double-count.
        """
        income, expense, details = [], [], []
        cur = None
        for blk in re.findall(r"<DSPACCNAME>(.*?)</DSPACCNAME>", xml, re.S):
            def tag(name: str) -> str:
                m = re.search(r"<%s>(.*?)</%s>" % (name, name), blk, re.S)
                return m.group(1).strip() if m else ""

            nm = self._unesc(tag("DSPDISPNAME")).strip()
            if not nm:
                continue
            main, sub = tag("BSMAINAMT"), tag("PLSUBAMT")
            if main:                               # MAIN group row
                amt = self._rx_amt(main)
                if abs(amt) < 0.005:
                    cur = None
                    continue
                (income if amt > 0 else expense).append({"name": nm, "amount": round(abs(amt), 2)})
                cur = nm
            elif sub:                              # SUB detail under the last main
                details.append({"name": nm, "amount": round(self._rx_amt(sub), 2), "under": cur})
        return {"income": income, "expense": expense, "details": details}

    def _parse_tb(self, xml: str) -> dict[str, Any]:
        """Trial Balance: each group carries a signed Dr (DSPCLDRAMTA, -ve) and a
        Cr (DSPCLCRAMTA, +ve); the NET = Dr+Cr places the group in the Dr or Cr
        column (Tally sign: +ve net = Credit, -ve = Debit)."""
        blocks = re.findall(
            r"<DSPDISPNAME>(.*?)</DSPDISPNAME>.*?<DSPCLDRAMTA>(.*?)</DSPCLDRAMTA>"
            r".*?<DSPCLCRAMTA>(.*?)</DSPCLCRAMTA>", xml, re.S)
        rows = []
        for nm, drv, crv in blocks:
            net = self._rx_amt(drv) + self._rx_amt(crv)
            if abs(net) < 0.005:
                continue
            debit = round(-net, 2) if net < 0 else 0.0
            credit = round(net, 2) if net > 0 else 0.0
            rows.append({"name": self._unesc(nm).strip(), "debit": debit, "credit": credit})
        return {"rows": rows,
                "debit_total": round(sum(r["debit"] for r in rows), 2),
                "credit_total": round(sum(r["credit"] for r in rows), 2)}

    def _parse_register(self, xml: str) -> dict[str, Any]:
        """Sales / Purchase Register: month rows — <DSPPERIOD>month</> with a Cr
        (sales) or Dr (purchase) amount + a running closing balance. Returns the
        EXACT monthly figures Tally shows so the cloud register ties to the rupee."""
        blocks = re.findall(
            r"<DSPPERIOD>(.*?)</DSPPERIOD>\s*<DSPACCINFO>(.*?)</DSPACCINFO>", xml, re.S)
        rows, total = [], 0.0
        for month, info in blocks:
            cr = re.search(r"<DSPCRAMTA>(.*?)</DSPCRAMTA>", info, re.S)
            dr = re.search(r"<DSPDRAMTA>(.*?)</DSPDRAMTA>", info, re.S)
            cl = re.search(r"<DSPCLAMTA>(.*?)</DSPCLAMTA>", info, re.S)
            amt = abs(self._rx_amt(cr.group(1) if cr else "") or self._rx_amt(dr.group(1) if dr else ""))
            mn = self._unesc(month).strip()
            if not mn:
                continue
            total += amt
            rows.append({"month": mn, "amount": round(amt, 2),
                         "closing": round(self._rx_amt(cl.group(1) if cl else ""), 2)})
        return {"rows": rows, "total": round(total, 2)}

    def _parse_stock(self, xml: str) -> dict[str, Any]:
        """Stock Summary: per-item closing qty / rate / value, verbatim from Tally."""
        blocks = re.findall(
            r"<DSPDISPNAME>(.*?)</DSPDISPNAME>\s*</DSPACCNAME>\s*<DSPSTKINFO>\s*<DSPSTKCL>\s*"
            r"<DSPCLQTY>(.*?)</DSPCLQTY>\s*<DSPCLRATE>(.*?)</DSPCLRATE>\s*"
            r"<DSPCLAMTA>(.*?)</DSPCLAMTA>", xml, re.S)
        rows, total = [], 0.0
        for name, qty, rate, amt in blocks:
            a = abs(self._rx_amt(amt))
            total += a
            rows.append({"name": self._unesc(name).strip(),
                         "qty": self._unesc(qty).strip(),
                         "rate": round(self._rx_amt(rate), 2), "amount": round(a, 2)})
        return {"rows": rows, "total": round(total, 2)}

    def _parse_group_summary(self, xml: str) -> dict[str, Any]:
        """Group Summary: every group/ledger with its closing Dr and Cr.

        Real shape (confirmed against a live export):
            <DSPACCNAME><DSPDISPNAME>Capital Account</DSPDISPNAME>
              <GUID>…-00000001</GUID><ISGROUP>Yes</ISGROUP>
              <DSPCLDRAMTA></DSPCLDRAMTA><DSPCLCRAMTA>11808076.45</DSPCLCRAMTA>
            </DSPACCNAME><DSPACCINFO>…repeats the same amounts…</DSPACCINFO>

        Parsed from DSPACCNAME only — DSPACCINFO restates the same two figures,
        so reading both would double every balance. Empty amount tags are normal
        (a row sits on one side), and PGUID is absent on top-level groups.
        """
        rows: list[dict[str, Any]] = []
        for blk in re.findall(r"<DSPACCNAME>(.*?)</DSPACCNAME>", xml, re.S):
            def tag(name: str) -> str:
                m = re.search(r"<%s>(.*?)</%s>" % (name, name), blk, re.S)
                return self._unesc(m.group(1)).strip() if m else ""

            name = tag("DSPDISPNAME")
            if not name:
                continue
            dr = self._rx_amt(tag("DSPCLDRAMTA"))
            cr = self._rx_amt(tag("DSPCLCRAMTA"))
            rows.append({
                "name": name,
                "guid": tag("GUID"),
                "parent_guid": tag("PGUID"),      # '' on a top-level group
                "is_group": tag("ISGROUP").lower() == "yes",
                "debit": round(abs(dr), 2),
                "credit": round(abs(cr), 2),
            })
        return {"rows": rows, "total": len(rows)}

    # ── Outstanding (bill-wise) ───────────────────────────────────────────
    #
    # SHAPE OF THE REAL REPORT (confirmed against a live Tally export, not
    # guessed). Tally answers PER LEDGER with a flat run of bills and NO party
    # name anywhere in the payload — the party is whichever ledger was asked
    # for:
    #
    #   <ENVELOPE>
    #     <BILLFIXED><BILLDATE>4-Jun-26</BILLDATE><BILLREF>638/2026-27</BILLREF></BILLFIXED>
    #     <BILLOP>-18653.00</BILLOP><BILLCL>-18653.00</BILLCL>
    #     <BILLDUE>4-Jun-26</BILLDUE><BILLOVERDUE>300</BILLOVERDUE>
    #     …repeated…
    #   </ENVELOPE>
    #
    # Three things here bite anyone who assumes the usual report shape:
    #   • the amount tag is BILLCL, not BILLCLAMT/DSPCLAMTA;
    #   • dates are 'd-Mmm-yy', NOT Tally's usual YYYYMMDD;
    #   • BILLFIXED is a wrapper around date+ref only — the amounts are its
    #     SIBLINGS, so a regex scoped to the BILLFIXED element finds no money.
    def outstandings(self, company: Optional[str] = None,
                     ledgers: Optional[list[str]] = None,
                     from_date: Optional[str] = None,
                     to_date: Optional[str] = None) -> dict[str, Any]:
        """Tally's OWN bill-wise outstanding, per party.

        The cloud already DERIVES outstanding from the mirrored bill allocations
        (Helpers/billwiseOutstanding.js) and that stays the number the screens
        use. This is the INDEPENDENT second opinion: Tally's own figure,
        computed by Tally, stored verbatim. Without it a derived total that has
        drifted is indistinguishable from one that is right.

        ``ledgers`` are the party names to ask for. Tally has no "every party's
        bills in one call" export — the report is per ledger — so the caller
        passes the parties worth asking about (typically the debtor/creditor
        ledgers). Returns ``{rows, total, parties, failed}`` where each row is
        ``{party, bill, bill_date, due_date, opening, amount, overdue_days}``.
        """
        rows: list[dict[str, Any]] = []
        failed: list[str] = []
        for name in (ledgers or []):
            if not str(name or "").strip():
                continue
            try:
                xml = self._ledger_outstanding_xml(name, company, from_date, to_date)
                rows.extend(self._parse_bills(xml, party=name))
            except TallyUnavailable:
                raise                     # Tally is gone — the caller must stop.
            except Exception as exc:      # noqa: BLE001 — one unreadable party
                self.log.debug("Outstanding for %r failed: %s", name, exc)
                failed.append(str(name))  # must not cost the other parties
        total = round(sum(abs(float(r["amount"])) for r in rows), 2)
        return {"rows": rows, "total": total,
                "parties": len({r["party"] for r in rows}), "failed": failed}

    # The Tally group names every party ledger ultimately descends from. A
    # company may nest its own groups under these ("Debtors - North"), so
    # membership is decided by WALKING the parent chain, not by comparing the
    # immediate parent — which would miss every company that organises its
    # parties into sub-groups.
    PARTY_ROOT_GROUPS = ("sundry debtors", "sundry creditors")

    def party_ledger_names(self, company: Optional[str] = None,
                           roots: Optional[tuple[str, ...]] = None) -> list[str]:
        """The ledgers that can carry an outstanding bill: parties only.

        Outstanding is a per-ledger report, so something has to choose which
        ledgers to ask about. Asking for all of them costs one Tally round trip
        per ledger (thousands); asking only the ones directly parented to a party
        group silently skips every sub-grouped party. This walks the group tree
        instead, so a party nested three levels deep is still found.
        """
        wanted = tuple(r.lower() for r in (roots or self.PARTY_ROOT_GROUPS))
        groups = self.group_list(company=company)
        parent_of = {str(g.get("name", "")).strip().lower():
                     str(g.get("parent", "")).strip().lower() for g in groups}

        def is_party_group(name: str, depth: int = 0) -> bool:
            n = (name or "").strip().lower()
            # Depth cap: a self-referential or circular parent chain in a
            # corrupted company would otherwise spin forever.
            if not n or depth > 25:
                return False
            if n in wanted:
                return True
            return is_party_group(parent_of.get(n, ""), depth + 1)

        out: list[str] = []
        for led in self.ledger_list(company=company):
            name = str(led.get("name", "")).strip()
            if name and is_party_group(str(led.get("parent", ""))):
                out.append(name)
        return out

    def _ledger_outstanding_xml(self, ledger: str, company: Optional[str],
                                from_date: Optional[str],
                                to_date: Optional[str]) -> str:
        """Request one ledger's bill-wise outstanding.

        SVLEDGERNAME is what scopes the report to a party; without it Tally
        answers for whatever ledger is in context, which silently attributes one
        party's bills to another.
        """
        cmp_xml = ("<SVCURRENTCOMPANY>" + self._esc(company) + "</SVCURRENTCOMPANY>") if company else ""
        period = ""
        if from_date:
            period += "<SVFROMDATE>" + self._esc(from_date) + "</SVFROMDATE>"
        if to_date:
            period += "<SVTODATE>" + self._esc(to_date) + "</SVTODATE>"
        req = (
            "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>"
            "<TYPE>Data</TYPE><ID>Ledger Outstandings</ID></HEADER>"
            "<BODY><DESC><STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>" + cmp_xml + period +
            "<SVLEDGERNAME>" + self._esc(ledger) + "</SVLEDGERNAME>"
            "</STATICVARIABLES></DESC></BODY></ENVELOPE>"
        )
        return self.send(req, timeout=60)

    def _parse_bills(self, xml: str, party: str = "") -> list[dict[str, Any]]:
        """One ledger's outstanding XML -> a list of bill rows.

        Parsed POSITIONALLY: the tags are siblings in document order, so each
        bill is the BILLFIXED element plus everything up to the next one. A
        per-tag findall would work only while every bill carried every tag —
        one bill missing BILLDUE would shift every later due date onto the wrong
        bill, which reads as valid data.
        """
        out: list[dict[str, Any]] = []
        # Cut the document into per-bill segments at each BILLFIXED.
        parts = re.split(r"(?=<BILLFIXED>)", xml)
        for seg in parts:
            if "<BILLFIXED>" not in seg:
                continue           # preamble before the first bill

            def tag(name: str) -> str:
                m = re.search(r"<%s>(.*?)</%s>" % (name, name), seg, re.S)
                return self._unesc(m.group(1)).strip() if m else ""

            ref = tag("BILLREF")
            closing = tag("BILLCL")
            if not ref and not closing:
                continue
            amt = self._rx_amt(closing)
            out.append({
                "party": str(party or "").strip(),
                # Tally stores a debit NEGATIVE (the same inverted convention as
                # ledger balances), so a negative closing is money owed TO us.
                # The side is only recoverable here — every consumer wants the
                # magnitude, so the sign is read before it is dropped.
                "side": "receivable" if amt < 0 else "payable",
                "bill": ref,
                "bill_date": self._tally_date(tag("BILLDATE")),
                "due_date": self._tally_date(tag("BILLDUE")),
                # Signed the way Tally reports it (a receivable is negative);
                # magnitude is what every ageing screen wants, and both sides
                # must read positive or a mixed total cancels itself out.
                "opening": round(abs(self._rx_amt(tag("BILLOP"))), 2),
                "amount": round(abs(amt), 2),
                "overdue_days": int(self._rx_amt(tag("BILLOVERDUE")) or 0),
            })
        return out

    # Tally's month abbreviations, as they appear in an XML export.
    _MONTHS = {m: i + 1 for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun",
         "jul", "aug", "sep", "oct", "nov", "dec"))}

    @classmethod
    def _tally_date(cls, s: str) -> str:
        """Any date shape Tally emits -> 'YYYY-MM-DD'; '' if unrecognised.

        Three shapes are real: 'YYYYMMDD' (collections), 'd-Mmm-yy' (report
        exports — e.g. '4-Jun-26') and an already-ISO date. The two-digit year
        is read as 20xx: Tally writes it for the CURRENT books, and no Indian
        company files a 19xx return.
        """
        t = str(s or "").strip()
        if not t:
            return ""
        if re.fullmatch(r"\d{8}", t):
            return "%s-%s-%s" % (t[:4], t[4:6], t[6:])
        m = re.match(r"^(\d{4}-\d{2}-\d{2})", t)
        if m:
            return m.group(1)
        m = re.fullmatch(r"(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})", t)
        if m:
            mon = cls._MONTHS.get(m.group(2).lower())
            if mon:
                yr = int(m.group(3))
                return "%04d-%02d-%02d" % (yr if yr > 99 else 2000 + yr, mon, int(m.group(1)))
        return ""

    def ledger_list(self, company: Optional[str] = None,
                    after_alterid: int = 0) -> list[dict[str, Any]]:
        """Fetch ledgers from Tally via a COLLECTION (name, parent, alterid, ...).

        Uses a Collection of TYPE Ledger that FETCHes NAME, PARENT, ALTERID,
        PARTYGSTIN and OPENINGBALANCE so the cloud can both classify the ledger
        (parent group) AND upsert its fields (gstin/opening) AND drive
        incrementality (alterid is Tally's monotonically-rising change counter).

        Pass ``company`` to read a SPECIFIC loaded company (SVCURRENTCOMPANY);
        omit it to read whichever company is currently active in Tally. Returns
        ``[{name, parent, gstin, opening, alterid:int}, ...]``.
        """
        xml = self.send(self._ledger_collection_request_xml(company, after_alterid))
        root = self._safe_parse(xml)
        ledgers: list[dict[str, Any]] = []
        if root is not None:
            for el in root.iter():
                if self._localname(el.tag).upper() == "LEDGER":
                    name = (el.get("NAME") or el.get("Name") or "").strip() \
                        or self._child_text(el, "NAME")
                    if not name:
                        continue
                    # Mailing address can arrive as multiple nested <ADDRESS> lines.
                    addr_lines = [a.text.strip() for a in el.iter()
                                  if self._localname(a.tag).upper() == "ADDRESS" and (a.text or "").strip()]
                    ledgers.append({
                        "name": name,
                        # Rename-stable identity — the cloud upserts on guid, so a
                        # ledger renamed in Tally updates its row instead of
                        # creating a second one. master_id drives delete detection.
                        "guid": self._guid(el),
                        "master_id": self._masterid(el),
                        "parent": self._child_text(el, "PARENT"),
                        "gstin": self._child_text(el, "PARTYGSTIN") or None,
                        "opening": self._child_text(el, "OPENINGBALANCE"),
                        # Tally's AUTHORITATIVE current balance (opening + all
                        # postings + inventory valuation). The cloud uses this for
                        # exact-match reports instead of reconstructing.
                        "closing": self._child_text(el, "CLOSINGBALANCE"),
                        "mobile": (self._child_text(el, "LEDGERMOBILE")
                                   or self._child_text(el, "LEDGERPHONE") or None),
                        "email": self._child_text(el, "EMAIL") or None,
                        "pan": self._child_text(el, "INCOMETAXNUMBER") or None,
                        "address": "\n".join(addr_lines) or None,
                        "state": (self._child_text(el, "LEDSTATENAME")
                                  or self._child_text(el, "STATENAME") or None),
                        "pincode": self._child_text(el, "PINCODE") or None,
                        "country": self._child_text(el, "COUNTRYNAME") or None,
                        "credit_limit": self._child_text(el, "CREDITLIMIT") or None,
                        "alterid": self._alterid(el),
                        # Behaviour flags — is_billwise in particular tells the
                        # cloud whether this party's outstanding CAN be bill-wise
                        # at all, or is only ever a running balance.
                        "is_billwise": self._child_text(el, "ISBILLWISEON").lower() == "yes",
                        "is_costcentres": self._child_text(el, "ISCOSTCENTRESON").lower() == "yes",
                        "is_deemed_positive": self._child_text(el, "ISDEEMEDPOSITIVE").lower() == "yes",
                        "affects_stock": self._child_text(el, "AFFECTSSTOCK").lower() == "yes",
                        "credit_period_days": self._credit_days(self._child_text(el, "BILLCREDITPERIOD")),
                        "gst_registration_type": self._child_text(el, "GSTREGISTRATIONTYPE") or None,
                        "place_of_supply": self._child_text(el, "PLACEOFSUPPLY") or None,
                        "contact_person": self._child_text(el, "LEDGERCONTACT") or None,
                        "fax": self._child_text(el, "LEDGERFAX") or None,
                        "website": self._child_text(el, "WEBSITE") or None,
                        "tax_type": self._child_text(el, "TAXTYPE") or None,
                        "tax_classification": self._child_text(el, "TAXCLASSIFICATIONNAME") or None,
                        "bank_details": self._ledger_bank_details(el),
                        "opening_bills": self._ledger_opening_bills(el),
                    })
        return ledgers

    def _ledger_bank_details(self, el: ET.Element) -> list[dict[str, Any]]:
        """LEDGERBANKDETAILS.LIST → the party's bank accounts.

        A flat FETCH cannot carry a repeating list, which is why the cloud's
        bank_name/bank_acc_no/ifsc columns on tally_ledgers were always empty.
        """
        out = []
        for b in self._lists(el, "LEDGERBANKDETAILS.LIST", "BANKDETAILS.LIST"):
            acc = self._direct_child_text(b, "ACCOUNTNUMBER")
            ifsc = self._direct_child_text(b, "IFSCODE")
            bank = self._direct_child_text(b, "BANKNAME")
            if not (acc or ifsc or bank):
                continue
            out.append({
                "account_no": acc or None,
                "ifsc": ifsc or None,
                "bank_name": bank or None,
                "branch": self._direct_child_text(b, "BRANCHNAME") or None,
                "account_holder": self._direct_child_text(b, "ACCOUNTHOLDERNAME") or None,
            })
        return out

    def _ledger_opening_bills(self, el: ET.Element) -> list[dict[str, Any]]:
        """OPENINGBALANCEALLOCATIONS.LIST → the opening balance, bill by bill.

        Without this a migrated company's opening balance is one lump, so every
        bill older than the migration date ages from the wrong start.
        """
        out = []
        for b in self._lists(el, "OPENINGBALANCEALLOCATIONS.LIST"):
            name = self._direct_child_text(b, "NAME")
            if not name:
                continue
            out.append({
                "bill_name": name,
                "bill_date": self._direct_child_text(b, "BILLDATE") or None,
                "amount": self._rate(self._direct_child_text(b, "OPENINGBALANCE")
                                     or self._direct_child_text(b, "AMOUNT")),
                "credit_period_days": self._credit_days(self._direct_child_text(b, "BILLCREDITPERIOD")),
            })
        return out

    def stock_summary(self, company: Optional[str] = None,
                      after_alterid: int = 0) -> list[dict[str, Any]]:
        """Fetch stock items from Tally via a COLLECTION (name, alterid, ...).

        Uses a Collection of TYPE StockItem that FETCHes NAME, ALTERID,
        BASEUNITS, GSTHSNCODE and CLOSINGBALANCE so the cloud can upsert the
        item's fields (unit/hsn/closing) AND drive incrementality via alterid.

        Pass ``company`` to target a specific loaded company (SVCURRENTCOMPANY).
        Returns ``[{name, unit, hsn, closing, alterid:int}, ...]``.
        """
        xml = self.send(self._stock_collection_request_xml(company, after_alterid))
        root = self._safe_parse(xml)
        items: list[dict[str, Any]] = []
        if root is not None:
            for el in root.iter():
                if self._localname(el.tag).upper() == "STOCKITEM":
                    name = (el.get("NAME") or el.get("Name") or "").strip() \
                        or self._child_text(el, "NAME")
                    if not name:
                        continue
                    items.append({
                        "name": name,
                        "guid": self._guid(el),
                        "master_id": self._masterid(el),
                        "unit": self._child_text(el, "BASEUNITS") or None,
                        # Stock group = the cloud "category".
                        "parent": self._child_text(el, "PARENT") or None,
                        # HSN: flat GSTHSNCODE, else the nested GST-details HSNCODE.
                        "hsn": (self._child_text(el, "GSTHSNCODE")
                                or self._child_text(el, "HSNCODE") or None),
                        # GST rate lives in the nested GST details; _child_text finds
                        # the first GSTRATE descendant. 0 when the item has no GST.
                        "gst_rate": self._rate(self._child_text(el, "GSTRATE")),
                        "closing": self._child_text(el, "CLOSINGBALANCE"),
                        # Rates come as "187.96/pair" - keep just the number.
                        "sales_price": self._rate(self._child_text(el, "STANDARDPRICE")),
                        "purchase_price": self._rate(self._child_text(el, "STANDARDCOST")
                                                     or self._child_text(el, "OPENINGRATE")),
                        "alterid": self._alterid(el),
                        # Rate SLABS (one per applicable-from date). The flat
                        # gst_rate above is only the first one found, which is
                        # wrong for any item whose rate changed mid-year.
                        "gst_slabs": self._stock_gst_slabs(el),
                        # Nested lists a flat collection cannot express. Each is
                        # its own table; without them opening stock is a single
                        # number with no batch/expiry behind it, a price list is
                        # invisible, and a manufactured item has no cost roll-up.
                        "batches": self._stock_batches(el),
                        "price_list": self._stock_price_list(el),
                        "bom": self._stock_bom(el),
                    })
        return items

    def _stock_batches(self, el: ET.Element) -> list[dict[str, Any]]:
        """BATCHALLOCATIONS.LIST on a StockItem → its OPENING batches.

        Distinct from the voucher-level batch allocations: these are the batches
        the item already holds at the start, with their godown and expiry. An
        expiry report that ignores them misses every pre-existing lot.
        """
        out = []
        for b in self._lists(el, "BATCHALLOCATIONS.LIST"):
            name = self._direct_child_text(b, "BATCHNAME")
            if not name:
                continue
            out.append({
                "batch_name": name,
                "godown": self._direct_child_text(b, "GODOWNNAME") or None,
                "manufactured_on": self._direct_child_text(b, "MFDON") or None,
                "expires_on": self._direct_child_text(b, "EXPIRYPERIOD") or None,
                "opening_qty": self._rate(self._direct_child_text(b, "OPENINGBALANCE")
                                          or self._direct_child_text(b, "ACTUALQTY")),
            })
        return out

    def _stock_price_list(self, el: ET.Element) -> list[dict[str, Any]]:
        """MULTIPRICELIST → the item's rate per price level and quantity slab."""
        out = []
        for pl in self._lists(el, "PRICELEVELLIST.LIST", "MULTIPRICELIST.LIST"):
            level = self._direct_child_text(pl, "PRICELEVEL") or self._child_text(pl, "PRICELEVEL")
            applicable = self._direct_child_text(pl, "APPLICABLEFROM") or None
            # One row per quantity slab under the level.
            slabs = list(self._lists(pl, "PRICELEVELLIST.LIST", "RATE.LIST"))
            targets = slabs or [pl]
            for s in targets:
                rate = self._rate(self._direct_child_text(s, "RATE"))
                if not rate:
                    continue
                out.append({
                    "price_level": level or None,
                    "applicable_from": applicable,
                    "from_qty": self._rate(self._direct_child_text(s, "GREATERONEQUAL")),
                    "to_qty": self._rate(self._direct_child_text(s, "LESSERONEQUAL")) or None,
                    "rate": rate,
                    "discount": self._rate(self._direct_child_text(s, "DISCOUNT")),
                })
        return out

    def _stock_bom(self, el: ET.Element) -> list[dict[str, Any]]:
        """COMPONENTLIST → the item's bill of materials (manufacturing)."""
        out = []
        for c in self._lists(el, "COMPONENTLISTNAMELIST.LIST", "COMPONENTLIST.LIST",
                             "MFGCOMPONENTLIST.LIST"):
            name = self._direct_child_text(c, "STOCKITEMNAME") or self._direct_child_text(c, "NAME")
            if not name:
                continue
            out.append({
                "component_item": name,
                "qty": self._rate(self._direct_child_text(c, "ACTUALQTY")
                                  or self._direct_child_text(c, "QUANTITY")),
                "godown": self._direct_child_text(c, "GODOWNNAME") or None,
            })
        return out

    def _stock_gst_slabs(self, el: ET.Element) -> list[dict[str, Any]]:
        """GSTDETAILS.LIST → the item's GST rate history.

        Each GSTDETAILS entry is a rate effective from a date, holding one
        STATEWISEDETAILS → RATEDETAILS row per tax head. Folded into one row per
        applicable-from so a return can read cgst/sgst/igst/cess side by side.
        """
        out = []
        for d in self._lists(el, "GSTDETAILS.LIST"):
            row = {
                "applicable_from": self._direct_child_text(d, "APPLICABLEFROM") or None,
                "hsn_code": (self._child_text(d, "GSTHSNCODE")
                             or self._child_text(d, "HSNCODE") or None),
                "taxability": self._child_text(d, "TAXABILITY") or None,
                "rate": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0, "cess": 0.0,
            }
            for r in self._lists(d, "RATEDETAILS.LIST"):
                head = (self._direct_child_text(r, "GSTRATEDUTYHEAD")
                        or self._direct_child_text(r, "DUTYHEAD")).lower()
                rate = self._rate(self._direct_child_text(r, "GSTRATE"))
                if "central" in head:
                    row["cgst"] = rate
                elif "state" in head or "utgst" in head:
                    row["sgst"] = rate
                elif "integrated" in head:
                    row["igst"] = rate
                elif "cess" in head:
                    row["cess"] = rate
            # The headline rate is IGST, or the CGST+SGST pair that equals it.
            row["rate"] = row["igst"] or (row["cgst"] + row["sgst"])
            if row["applicable_from"] or row["rate"]:
                out.append(row)
        return out

    @staticmethod
    def _rate_unit(s: str) -> Optional[str]:
        """The UNIT half of a Tally rate: '187.96/pair' -> 'pair' (None if absent).

        Tally quotes a rate per unit; dropping the unit makes two items with
        different units look directly comparable when they are not.
        """
        raw = str(s or "")
        if "/" not in raw:
            return None
        unit = raw.split("/", 1)[1].strip()
        return unit or None

    @staticmethod
    def _rate(s: str) -> float:
        """Parse a Tally rate like '187.96/pair' or '227.85' -> 187.96 (0 if none)."""
        m = re.search(r"-?\d+(?:\.\d+)?", str(s or "").replace(",", ""))
        try:
            return float(m.group(0)) if m else 0.0
        except ValueError:
            return 0.0

    # Cloud master-kind -> the Tally collection TYPE that enumerates it. The
    # reconcile pass walks this map; adding a master here is all it takes for
    # deletes of that master to be detected.
    RECONCILE_TYPES = {
        "ledger": "Ledger",
        "group": "Group",
        "stock_item": "StockItem",
        "godown": "Godown",
        # Plus every registry-driven master, derived rather than restated so a
        # new MasterSpec gets delete-sync for free instead of silently never
        # being reconciled. `stock_item_full` shares the StockItem collection
        # with `stock_item` above but reconciles a DIFFERENT cloud table.
        **{spec.kind: spec.collection_type for spec in MASTERS},
    }

    def master_ids(self, kind: str, company: Optional[str] = None) -> list[dict[str, Any]]:
        """Enumerate every LIVE master of one kind as ``[{master_id, guid, name}]``.

        This is the delete detector. Tally's XML API has no "what changed"
        feed and no tombstones — a deleted ledger simply stops appearing. So we
        periodically ask for the full id list and diff it against the cloud: any
        identity the cloud holds that Tally no longer lists has been DELETED.

        Deliberately fetches ONLY the identity fields (no balances, no
        addresses), which keeps even a 50k-master company to a small response —
        cheap enough to run on a schedule, unlike a full master re-pull.
        """
        coll_type = self.RECONCILE_TYPES.get(kind)
        if not coll_type:
            raise ValueError(f"unknown reconcile kind {kind!r}")
        xml = self._collection_request_xml(
            f"TSSRec{coll_type}", coll_type, ["NAME", "GUID", "MASTERID"], company,
        )
        root = self._safe_parse(self.send(xml, timeout=120))
        out: list[dict[str, Any]] = []
        if root is None:
            return out
        want = coll_type.upper()
        for el in root.iter():
            if self._localname(el.tag).upper() != want:
                continue
            name = (el.get("NAME") or "").strip() or self._child_text(el, "NAME")
            if not name:
                continue
            out.append({
                "master_id": self._masterid(el),
                "guid": self._guid(el),
                "name": name,
            })
        return out

    # ------------------------------------------------------------------ #
    # Generic master fetch (registry-driven — see tally_schema.py)
    # ------------------------------------------------------------------ #
    # A master that can take TallyPrime down gets seconds, not minutes. These
    # are tiny collections over small tables; one that has not answered in
    # MASTER_TIMEOUT_FRAGILE seconds is not busy, it is sitting behind the modal
    # error box, and waiting the full two minutes only delays every step after
    # it. Measured live: TDSCategory returned at exactly the 120s timeout, twice.
    MASTER_TIMEOUT = 120
    MASTER_TIMEOUT_FRAGILE = 15

    @classmethod
    def master_timeout(cls, kind: str) -> int:
        spec = BY_KIND.get(kind)
        return (cls.MASTER_TIMEOUT_FRAGILE
                if spec is not None and spec.feature_must_be_on
                else cls.MASTER_TIMEOUT)

    @staticmethod
    def master_fetch_order() -> list:
        """MASTERS, with the ones that can kill Tally moved to the END.

        The F11 gate cannot save a company that REPORTS a feature Tally still
        cannot serve — this customer's F11 says ISTDSON=Yes on a TallyPrime EDU
        that has no TDSCategory object — so the first cycle on a fresh machine
        will meet the error box once, whatever we do. What we CAN decide is what
        that costs. Asked last, it costs only the masters that were unreadable
        anyway: everything ordinary has already been read, and (because the
        upload runs before outstandings) the customer's data is already in the
        cloud. Asked in registry order, it cost the entire rest of the cycle.

        Ordinary masters keep their registry order — some of them depend on it.
        """
        return ([s for s in MASTERS if not s.feature_must_be_on]
                + [s for s in MASTERS if s.feature_must_be_on])

    @staticmethod
    def feature_allows(kind: str, features: "Optional[dict[str, Any]]") -> bool:
        """May this company be asked for ``kind`` at all?

        THE ONE PLACE the F11 gate is decided, because there are two callers —
        the master pull and the delete-detection reconcile — and only the pull
        used to gate. The reconcile asked every registered kind unconditionally,
        so a company with payroll off was still asked for TSSRecEmployeeGroup
        and TallyPrime went down with "Incorrect Object Type!" once every
        RECONCILE_EVERY cycles. Gating one caller only moves the crash.

        The rule: an explicit "no" always blocks. An ABSENT flag normally
        allows — a Tally build that does not report a flag must not cost the
        company a master it really uses — EXCEPT for specs marked
        feature_must_be_on, where silence means no because asking for those
        does not return empty, it takes Tally down.
        """
        spec = BY_KIND.get(kind)
        if spec is None or not spec.requires_feature:
            return True            # ungated (ledger, group, …) — always allowed
        flag = str((features or {}).get(spec.requires_feature, "")).strip().lower()
        on = flag in ("yes", "true", "1")
        off = flag in ("no", "false", "0")
        return not (off or (spec.feature_must_be_on and not on))

    def fetch_master(self, kind: str, company: Optional[str] = None,
                     features: Optional[dict[str, Any]] = None,
                     after_alterid: int = 0) -> list[dict[str, Any]]:
        """Fetch one registered master collection as a list of cloud-shaped dicts.

        Driven entirely by :data:`tally_schema.MASTERS`, so a new master is a
        registry entry rather than three new methods. Returns ``[]`` (without
        touching Tally) when the spec declares an F11 feature the company has
        switched off — a company without payroll has no Employee collection at
        all, and asking anyway costs a round trip per cycle and logs a confusing
        empty result.

        Every row carries ``name``/``guid``/``master_id``/``alterid`` plus the
        spec's mapped fields, coerced per the spec's bools/numbers/dates.
        """
        spec = BY_KIND.get(kind)
        if spec is None:
            raise ValueError(f"unknown master kind {kind!r}")
        if not self.feature_allows(kind, features):
            flag = str((features or {}).get(spec.requires_feature, "")).strip().lower()
            self.log.info(
                "Master %s skipped: %s is %s.", kind, spec.requires_feature,
                "off" if flag in ("no", "false", "0")
                else "not reported by this company")
            return []

        xml = self._collection_request_xml(
            f"TSSM{spec.collection_type}", spec.collection_type, spec.fetch_list, company,
            after_alterid,
        )
        root = self._safe_parse(self.send(xml, timeout=self.master_timeout(kind)))
        if root is None:
            return []

        want = spec.collection_type.upper()
        rows: list[dict[str, Any]] = []
        for el in root.iter():
            if self._localname(el.tag).upper() != want:
                continue
            name = (el.get("NAME") or "").strip() or self._child_text(el, "NAME")
            if not name:
                continue
            row: dict[str, Any] = {
                "name": name,
                "guid": self._guid(el),
                "master_id": self._masterid(el),
                "alterid": self._alterid(el),
            }
            for col, tag in spec.fields.items():
                tags = tag if isinstance(tag, tuple) else (tag,)
                raw = ""
                for t in tags:
                    raw = self._child_text(el, t)
                    if raw:
                        break
                if col in spec.bools:
                    row[col] = raw.strip().lower() == "yes"
                elif col in spec.numbers:
                    row[col] = self._rate(raw)
                elif col in spec.dates:
                    row[col] = raw.strip() or None
                else:
                    row[col] = raw.strip() or None
            rows.append(row)
        return rows

    def fetch_all_masters(self, company: Optional[str] = None,
                          features: Optional[dict[str, Any]] = None,
                          after_alterid: int = 0) -> dict[str, list[dict[str, Any]]]:
        """Fetch EVERY registered master for one company -> ``{kind: [rows]}``.

        Best-effort per kind: a collection this Tally build does not know (older
        releases lack TCSCategory, PriceLevel, …) raises, is logged at debug and
        is simply absent from the result — one unsupported master must never
        cost the company its other twenty.
        """
        out: dict[str, list[dict[str, Any]]] = {}
        for spec in self.master_fetch_order():
            try:
                rows = self.fetch_master(spec.kind, company=company, features=features,
                                         after_alterid=after_alterid)
            except TallySkipped as exc:
                # Quarantined earlier in this run because Tally died on it. That
                # is exactly the "one unsupported master must not cost the other
                # twenty" case this loop exists for — so it is a skip, NOT the
                # "Tally is gone" abort below.
                self.log.info("Master %s skipped: %s", spec.kind, exc)
                continue
            except TallyUnavailable:
                raise                      # Tally is gone — the caller must stop.
            except Exception as exc:       # noqa: BLE001
                self.log.debug("Master %s unavailable on this Tally: %s", spec.kind, exc)
                continue
            if rows:
                out[spec.kind] = rows
        return out

    def godown_list(self, company: Optional[str] = None,
                    after_alterid: int = 0) -> list[dict[str, Any]]:
        """Fetch godowns from Tally via a COLLECTION (name, alterid) -> locations.

        Uses the SAME working Collection envelope as ledgers/stock (HEADER
        TALLYREQUEST=Export / TYPE=Collection / ID, BODY/DESC with the inline
        TDL COLLECTION of TYPE Godown that FETCHes NAME + ALTERID). The cloud
        maps each godown to a row in the locations table.

        Pass ``company`` to target a specific loaded company (SVCURRENTCOMPANY);
        omit it for the active company. Returns ``[{name, alterid:int}, ...]``.
        """
        xml = self.send(self._godown_collection_request_xml(company, after_alterid))
        root = self._safe_parse(xml)
        godowns: list[dict[str, Any]] = []
        if root is not None:
            for el in root.iter():
                if self._localname(el.tag).upper() == "GODOWN":
                    name = (el.get("NAME") or el.get("Name") or "").strip() \
                        or self._child_text(el, "NAME")
                    if not name:
                        continue
                    addr_lines = [a.text.strip() for a in el.iter()
                                  if self._localname(a.tag).upper() == "ADDRESS" and (a.text or "").strip()]
                    godowns.append({
                        "name": name,
                        "guid": self._guid(el),
                        "master_id": self._masterid(el),
                        "parent": self._child_text(el, "PARENT") or None,
                        "address": "\n".join(addr_lines) or None,
                        "has_no_space": self._child_text(el, "HASNOSPACE").lower() == "yes",
                        "is_external": self._child_text(el, "ISEXTERNAL").lower() == "yes",
                        "alterid": self._alterid(el),
                    })
        return godowns

    def group_list(self, company: Optional[str] = None,
                   after_alterid: int = 0) -> list[dict[str, Any]]:
        """Fetch account GROUPS via a COLLECTION (name/parent/alterid/nature) so the
        cloud can build the Balance Sheet / P&L hierarchy. Returns
        ``[{name, parent, primary_group, is_revenue, is_deemed_positive,
        alterid:int}, ...]``."""
        root = self._safe_parse(self.send(self._group_collection_request_xml(company, after_alterid)))
        out: list[dict[str, Any]] = []
        if root is None:
            return out
        for el in root.iter():
            if self._localname(el.tag).upper() != "GROUP":
                continue
            name = (el.get("NAME") or "").strip() or self._child_text(el, "NAME")
            if not name:
                continue
            out.append({
                "name": name,
                "guid": self._guid(el),
                "master_id": self._masterid(el),
                "parent": self._child_text(el, "PARENT"),
                # Tally's top-of-tree primary group (e.g. "Current Assets").
                # Reported for Balance Sheet / P&L grouping only — the cloud
                # classifies cash/bank/debtors/creditors by walking PARENT, since
                # PRIMARYGROUP is "Current Assets" for cash AND debtors alike.
                "primary_group": self._child_text(el, "PRIMARYGROUP"),
                "is_revenue": self._child_text(el, "ISREVENUE").lower() == "yes",
                "is_deemed_positive": self._child_text(el, "ISDEEMEDPOSITIVE").lower() != "no",
                "alterid": self._alterid(el),
            })
        return out

    def day_book(self, company: Optional[str] = None) -> list[dict[str, Any]]:
        """Fetch vouchers from Tally's Day Book → [{date, vtype, vno, party, amount}].

        Reads the Day Book report over a wide date range and parses each
        <VOUCHER>: type, number, date, party, and the party-ledger amount (abs;
        falls back to the first amount found). Pass ``company`` to target a
        specific loaded company (SVCURRENTCOMPANY). Best-effort + tolerant of
        Tally's XML quirks; an unparseable body yields an empty list.
        """
        xml = self.send(self._day_book_request_xml(company))
        root = self._safe_parse(xml)
        out: list[dict[str, Any]] = []
        if root is None:
            return out

        def _amt(s: str) -> float:
            try:
                return abs(float(re.sub(r"[^0-9.\-]", "", s or "") or 0))
            except ValueError:
                return 0.0

        for v in root.iter():
            if self._localname(v.tag).upper() != "VOUCHER":
                continue
            date = self._child_text(v, "DATE")
            vtype = self._child_text(v, "VOUCHERTYPENAME")
            vno = self._child_text(v, "VOUCHERNUMBER")
            party = self._child_text(v, "PARTYLEDGERNAME") or self._child_text(v, "PARTYNAME")

            amount = 0.0
            if party:
                for entry in v.iter():
                    if self._localname(entry.tag).upper() in ("ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"):
                        if self._child_text(entry, "LEDGERNAME") == party:
                            amount = _amt(self._child_text(entry, "AMOUNT"))
                            if amount:
                                break
            if not amount:
                for entry in v.iter():
                    if self._localname(entry.tag).upper() == "AMOUNT" and (entry.text or "").strip():
                        amount = _amt(entry.text)
                        if amount:
                            break

            if vtype and (vno or party):
                out.append({"date": date, "vtype": vtype, "vno": vno, "party": party, "amount": amount})
        return out

    # ------------------------------------------------------------------ #
    # Voucher child collections
    #
    # Tally nests these inside the voucher body. Each extractor walks the
    # voucher for its list tag and, where the allocation belongs to a PARENT
    # line (a bill belongs to a ledger entry, a batch to an item line), climbs
    # back up to name that parent — otherwise "which invoice does this receipt
    # settle" is unanswerable, which is the whole point of storing them.
    # ------------------------------------------------------------------ #
    @staticmethod
    def _parent_map(root: ET.Element) -> dict:
        """child → parent for every element under `root`.

        ElementTree elements carry no parent pointer. Built ONCE per voucher and
        threaded through the extractors: rebuilding it per allocation would make
        a voucher with many lines quadratic, and a big AlterID window holds
        thousands of vouchers.
        """
        return {child: parent for parent in root.iter() for child in parent}

    def _owner_text(self, parents: dict, node: ET.Element, tag: str) -> Optional[str]:
        """Find `tag` on the nearest ANCESTOR of `node`.

        Used to attach a bill allocation to its LEDGERNAME and a batch allocation
        to its STOCKITEMNAME — without that link the allocation is unusable.
        """
        cur = parents.get(node)
        while cur is not None:
            txt = self._direct_child_text(cur, tag)
            if txt:
                return txt
            cur = parents.get(cur)
        return None

    def _lists(self, v: ET.Element, *names: str):
        """Yield every descendant element whose local name matches one of `names`."""
        wanted = {n.upper() for n in names}
        for el in v.iter():
            if self._localname(el.tag).upper() in wanted:
                yield el

    def _bill_allocations(self, v: ET.Element, parents: dict) -> list[dict[str, Any]]:
        """BILLALLOCATIONS.LIST → bill-wise settlement rows.

        BILLTYPE is the meaningful part: "New Ref" opens a bill, "Agst Ref"
        settles one, "Advance"/"On Account" neither. Ageing is Σ(New Ref) −
        Σ(Agst Ref) per bill name, which is exactly how Tally computes it.
        """
        out = []
        for el in self._lists(v, "BILLALLOCATIONS.LIST"):
            name = self._direct_child_text(el, "NAME")
            btype = self._direct_child_text(el, "BILLTYPE")
            if not (name or btype):
                continue
            out.append({
                "ledger": self._owner_text(parents, el, "LEDGERNAME"),
                "bill_name": name or None,
                "bill_type": btype or None,
                "amount": self._rate(self._direct_child_text(el, "AMOUNT")),
                "credit_period_days": self._credit_days(self._direct_child_text(el, "BILLCREDITPERIOD")),
                "bill_date": self._direct_child_text(el, "BILLDATE") or None,
            })
        return out

    @staticmethod
    def _credit_days(s: str) -> Optional[int]:
        """Tally credit periods read '30 Days' / '2 Months' / '45' → days int."""
        raw = str(s or "").strip()
        if not raw:
            return None
        m = re.search(r"(\d+)", raw)
        if not m:
            return None
        n = int(m.group(1))
        low = raw.lower()
        if "month" in low:
            return n * 30
        if "week" in low:
            return n * 7
        if "year" in low:
            return n * 365
        return n

    def _batch_allocations(self, v: ET.Element, parents: dict) -> list[dict[str, Any]]:
        """BATCHALLOCATIONS.LIST → batch / godown / expiry per item line."""
        out = []
        for el in self._lists(v, "BATCHALLOCATIONS.LIST"):
            godown = self._direct_child_text(el, "GODOWNNAME")
            batch = self._direct_child_text(el, "BATCHNAME")
            if not (godown or batch):
                continue
            out.append({
                "item": self._owner_text(parents, el, "STOCKITEMNAME"),
                "batch_name": batch or None,
                "godown": godown or None,
                "destination_godown": self._direct_child_text(el, "DESTINATIONGODOWNNAME") or None,
                "actual_qty": self._rate(self._direct_child_text(el, "ACTUALQTY")),
                "billed_qty": self._rate(self._direct_child_text(el, "BILLEDQTY")),
                "amount": self._rate(self._direct_child_text(el, "AMOUNT")),
                "manufactured_on": self._direct_child_text(el, "MFDON") or None,
                "expires_on": self._direct_child_text(el, "EXPIRYPERIOD") or None,
                "tracking_no": self._direct_child_text(el, "TRACKINGNUMBER") or None,
                "order_no": self._direct_child_text(el, "ORDERNO") or None,
            })
        return out

    def _cost_allocations(self, v: ET.Element, parents: dict) -> list[dict[str, Any]]:
        """COSTCENTREALLOCATIONS.LIST → cost-centre split of a ledger amount.

        The centres sit under CATEGORYALLOCATIONS.LIST, which names the CATEGORY;
        we climb for both the category and the owning ledger.
        """
        out = []
        for el in self._lists(v, "COSTCENTREALLOCATIONS.LIST"):
            centre = self._direct_child_text(el, "NAME")
            if not centre:
                continue
            out.append({
                "ledger": self._owner_text(parents, el, "LEDGERNAME"),
                "cost_category": self._owner_text(parents, el, "CATEGORY"),
                "cost_centre": centre,
                "amount": self._rate(self._direct_child_text(el, "AMOUNT")),
            })
        return out

    def _bank_allocations(self, v: ET.Element, parents: dict) -> list[dict[str, Any]]:
        """BANKALLOCATIONS.LIST → cheque/UTR details, i.e. bank reconciliation."""
        out = []
        for el in self._lists(v, "BANKALLOCATIONS.LIST"):
            inst = self._direct_child_text(el, "INSTRUMENTNUMBER")
            ttype = self._direct_child_text(el, "TRANSACTIONTYPE")
            uref = self._direct_child_text(el, "UNIQUEREFERENCENUMBER")
            if not (inst or ttype or uref):
                continue
            out.append({
                "ledger": self._owner_text(parents, el, "LEDGERNAME"),
                "instrument_no": inst or None,
                "instrument_date": self._direct_child_text(el, "INSTRUMENTDATE") or None,
                "transaction_type": ttype or None,
                "bank_name": self._direct_child_text(el, "BANKNAME") or None,
                "payment_favouring": self._direct_child_text(el, "PAYMENTFAVOURING") or None,
                "unique_reference": uref or None,
                "status": self._direct_child_text(el, "STATUS") or None,
                "bank_date": self._direct_child_text(el, "DATE") or None,
            })
        return out

    def _inventory_accounting(self, v: ET.Element, parents: dict) -> list[dict[str, Any]]:
        """ACCOUNTINGALLOCATIONS.LIST → which LEDGER each item line posts to.

        These already reach the cloud folded into the flat ledger entries, which
        loses the item↔ledger link — so "sales of Widget by ledger" or a per-item
        gross margin could not be computed at all. Kept here as its own row, WITH
        the owning item, alongside the flat entry.
        """
        out = []
        for el in self._lists(v, "ACCOUNTINGALLOCATIONS.LIST"):
            ledger = self._direct_child_text(el, "LEDGERNAME")
            if not ledger:
                continue
            item = self._owner_text(parents, el, "STOCKITEMNAME")
            if not item:
                continue      # not under an inventory line — the flat entry covers it
            out.append({
                "item": item,
                "ledger": ledger,
                "amount": self._rate(self._direct_child_text(el, "AMOUNT")),
                "is_debit": self._direct_child_text(el, "ISDEEMEDPOSITIVE").lower() == "yes",
            })
        return out

    def _eway_bills(self, v: ET.Element) -> list[dict[str, Any]]:
        """EWAYBILLDETAILS.LIST → the e-Way Bill(s) raised for this voucher.

        A list, not a column set: one invoice can carry several bills (an
        extension, a multi-vehicle movement, a re-generation after a vehicle
        change), and keeping only the last one loses the movement history that a
        GST audit asks about.
        """
        out = []
        for el in self._lists(v, "EWAYBILLDETAILS.LIST"):
            num = self._direct_child_text(el, "EWAYBILLNUMBER")
            if not num:
                continue
            # Transporter + vehicle sit one level deeper, in CONSIGNORDETAILS /
            # EWBDETAILS depending on the Tally build — descend for those.
            out.append({
                "ewb_number": num,
                "ewb_date": self._direct_child_text(el, "EWAYBILLDATE") or None,
                "valid_until": self._child_text(el, "VALIDUPTO") or None,
                "status": self._child_text(el, "STATUS") or None,
                "transporter_name": self._child_text(el, "TRANSPORTERNAME") or None,
                "transporter_id": self._child_text(el, "TRANSPORTERID") or None,
                "vehicle_number": self._child_text(el, "VEHICLENUMBER") or None,
                "vehicle_type": self._child_text(el, "VEHICLETYPE") or None,
                "transport_mode": self._child_text(el, "MODEOFTRANSPORT") or None,
                "doc_number": self._child_text(el, "DOCNUMBER") or None,
                "doc_date": self._child_text(el, "DOCDATE") or None,
                "distance_km": self._rate(self._child_text(el, "DISTANCE")),
                "from_place": self._child_text(el, "CONSIGNORPLACE") or None,
                "from_state": self._child_text(el, "CONSIGNORSTATE") or None,
                "to_place": self._child_text(el, "CONSIGNEEPLACE") or None,
                "to_state": self._child_text(el, "CONSIGNEESTATE") or None,
            })
        return out

    def _einvoice(self, v: ET.Element) -> list[dict[str, Any]]:
        """IRN / acknowledgement details for an e-invoiced voucher.

        Tally exposes these either as a nested list or as flat tags on the
        voucher depending on release, so both shapes are handled. Returns a list
        so a cancelled-and-regenerated IRN can be kept alongside the original.
        """
        out = []
        for el in self._lists(v, "IRNDETAILS.LIST", "EINVOICEDETAILS.LIST"):
            irn = self._direct_child_text(el, "IRN") or self._child_text(el, "IRN")
            if not irn:
                continue
            out.append({
                "irn": irn,
                "ack_number": self._child_text(el, "IRNACKNO") or self._child_text(el, "ACKNO") or None,
                "ack_date": self._child_text(el, "IRNACKDATE") or self._child_text(el, "ACKDATE") or None,
                "signed_qr_code": self._child_text(el, "IRNQRCODE") or None,
                "status": self._child_text(el, "IRNSTATUS") or None,
                "cancelled_date": self._child_text(el, "IRNCANCELDATE") or None,
                "cancel_reason": self._child_text(el, "IRNCANCELREASON") or None,
            })
        if not out:
            # Flat form: the IRN tags hang directly off the voucher.
            irn = self._child_text(v, "IRN") or self._child_text(v, "IRNNUMBER")
            if irn:
                out.append({
                    "irn": irn,
                    "ack_number": self._child_text(v, "IRNACKNO") or None,
                    "ack_date": self._child_text(v, "IRNACKDATE") or None,
                    "signed_qr_code": self._child_text(v, "IRNQRCODE") or None,
                    "status": self._child_text(v, "IRNSTATUS") or None,
                    "cancelled_date": None, "cancel_reason": None,
                })
        return out

    def _gst_details(self, v: ET.Element, parents: dict) -> list[dict[str, Any]]:
        """RATEDETAILS.LIST → the CGST/SGST/IGST/cess split per line.

        Tally reports one RATEDETAILS row per tax head (GSTTAXTYPE = Central Tax /
        State Tax / Integrated Tax / Cess) with its own rate; we fold each line's
        heads into ONE row so a GST return can read taxable value and each
        component side by side instead of re-pivoting.
        """
        rows: dict[tuple, dict[str, Any]] = {}
        for el in self._lists(v, "RATEDETAILS.LIST"):
            head = (self._direct_child_text(el, "GSTRATEDUTYHEAD")
                    or self._direct_child_text(el, "DUTYHEAD")).lower()
            rate = self._rate(self._direct_child_text(el, "GSTRATE"))
            if not head:
                continue
            item = self._owner_text(parents, el, "STOCKITEMNAME")
            ledger = self._owner_text(parents, el, "LEDGERNAME")
            hsn = self._owner_text(parents, el, "GSTHSNCODE") or self._owner_text(parents, el, "HSNCODE")
            key = (item, ledger, hsn)
            row = rows.setdefault(key, {
                "item": item, "ledger": ledger, "hsn_code": hsn,
                "taxable_value": self._rate(self._owner_text(parents, el, "AMOUNT") or ""),
                "rate": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0, "cess": 0.0,
            })
            amount = self._rate(self._direct_child_text(el, "GSTRATEVALUE")
                                or self._direct_child_text(el, "AMOUNT"))
            if "central" in head:
                row["cgst"] += amount
                row["rate"] += rate
            elif "state" in head or "utgst" in head:
                row["sgst"] += amount
                row["rate"] += rate
            elif "integrated" in head:
                row["igst"] += amount
                row["rate"] += rate
            elif "cess" in head:
                row["cess"] += amount
        return list(rows.values())

    @staticmethod
    def _abs_amt(s: str) -> float:
        """A Tally amount as a positive magnitude ('-11,800.00' -> 11800.0)."""
        try:
            return abs(float(re.sub(r"[^0-9.\-]", "", s or "") or 0))
        except ValueError:
            return 0.0

    def voucher_ids(self, company: Optional[str] = None,
                    vtype: Optional[str] = None) -> list[dict[str, Any]]:
        """Identity ONLY for every voucher (optionally of one type).

        ``[{guid, alterid, master_id, vtype}, ...]`` — no dates, no amounts, no
        allocations, so even a company with 100k vouchers answers in a few MB.

        This is the sweep the diff-based pull is built on. A watermark walk can
        only ever move forward: if a window is skipped (Tally stalls, the agent
        is killed mid-cycle, the cursor is bumped past a gap) those vouchers are
        never looked at again, and nothing reports them as missing — the sync
        just quietly stays incomplete. Comparing full id lists finds such gaps no
        matter how old they are, and finds DELETES at the same time.
        """
        xml = self._voucher_collection_request_xml(
            company, 0, None, vtype=vtype,
            fetch="GUID,ALTERID,MASTERID,VOUCHERTYPENAME",
        )
        root = self._safe_parse(self.send(xml, timeout=180))
        out: list[dict[str, Any]] = []
        if root is None:
            return out
        for v in root.iter():
            if self._localname(v.tag).upper() != "VOUCHER":
                continue
            guid = self._child_text(v, "GUID")
            if not guid:
                continue
            out.append({
                "guid": guid,
                "alterid": self._alterid(v),
                "master_id": self._masterid(v),
                "vtype": self._child_text(v, "VOUCHERTYPENAME") or (v.get("VCHTYPE") or None),
            })
        return out

    def vouchers_by_guid(self, guids: list[str],
                         company: Optional[str] = None) -> list[dict[str, Any]]:
        """Fetch a SPECIFIC set of vouchers, in full, by GUID.

        The other half of the diff pull: once the cloud says which guids it is
        missing or holds a stale AlterID for, ask Tally for exactly those. Keep
        the batch modest — the filter becomes one OR term per guid, and a very
        long formula is both slow to evaluate and a way to upset Tally.
        """
        if not guids:
            return []
        xml = self._voucher_collection_request_xml(company, 0, None, guids=guids)
        return self._parse_vouchers(self._safe_parse(self.send(xml, timeout=180)))

    def voucher_type_names(self, company: Optional[str] = None) -> list[str]:
        """Every voucher type DEFINED in this company (custom types included).

        Falls back to Tally's reserved base types when the VoucherType collection
        is unavailable, so a per-type pull still covers the standard documents on
        a Tally build or company that will not answer for the master.
        """
        try:
            rows = self.fetch_master("voucher_type", company=company)
            names = [str(r.get("name") or "").strip() for r in rows]
            names = [n for n in names if n]
            if names:
                return names
        except Exception as exc:  # noqa: BLE001
            self.log.debug("VoucherType master unavailable: %s", exc)
        return list(RESERVED_VOUCHER_TYPES)

    def voucher_list(self, company: Optional[str] = None,
                     after_alterid: int = 0,
                     upto_alterid: "int | None" = None,
                     vtype: Optional[str] = None) -> list[dict[str, Any]]:
        """Fetch vouchers via an AlterID-bounded COLLECTION (the RELIABLE way).

        Returns vouchers whose AlterID is in ``(after_alterid, upto_alterid]`` so
        each response stays small + the pull is INCREMENTAL/CHUNKED like masters
        (a full unfiltered voucher collection chokes Tally). Each item:
        ``{date, vtype, vno, party, amount, alterid:int, guid}``. ``guid`` is
        Tally's stable per-voucher id - the cloud dedupes on it because voucher
        NUMBERS repeat (purchases reuse the supplier bill no). ``alterid`` drives
        incrementality. Best-effort + tolerant of Tally's XML quirks.
        """
        out: list[dict[str, Any]] = []
        # Up to 2 attempts, each with a BRAND-NEW collection name (the request
        # builder mints a nonce) so a transient empty isn't a poisoned name we keep
        # re-hitting. A genuinely-empty AlterID window returns [] both times (cheap).
        for attempt in range(2):
            xml = self._voucher_collection_request_xml(
                company, after_alterid, upto_alterid, vtype=vtype)
            out = self._parse_vouchers(self._safe_parse(self.send(xml, timeout=180)))
            if out:
                break
            self.log.debug("voucher_list(%s,%s,%s): empty on attempt %d",
                           after_alterid, upto_alterid, vtype, attempt + 1)
        return out

    def _parse_vouchers(self, root) -> list[dict[str, Any]]:
        """Parse a voucher COLLECTION response into full cloud-shaped vouchers.

        Shared by voucher_list() (window pull) and vouchers_by_guid() (diff
        pull), so both produce byte-identical rows — the two paths must never
        disagree about what a voucher looks like.
        """
        rows: list[dict[str, Any]] = []
        if root is None:
            return rows
        if True:
            for v in root.iter():
                if self._localname(v.tag).upper() != "VOUCHER":
                    continue
                vtype = self._child_text(v, "VOUCHERTYPENAME") or (v.get("VCHTYPE") or "")
                guid = self._child_text(v, "GUID")
                if not (vtype and guid):
                    continue   # skip the CMPINFO <VOUCHER>0</VOUCHER> + partial nodes
                # FULL DOUBLE-ENTRY: every ledger posting of this voucher
                # (LEDGERNAME + signed AMOUNT + Dr/Cr). Sum per ledger (+ opening)
                # = its balance -> Trial Balance / Balance Sheet / P&L / Ledger.
                # Ledger postings live in TWO places: top-level LEDGERENTRIES.LIST
                # (party + tax + round-off) AND, for INVOICE vouchers, the sales/
                # purchase ledger sits in ACCOUNTINGALLOCATIONS.LIST nested under
                # each INVENTORYENTRIES.LIST. Both carry LEDGERNAME + AMOUNT; parse
                # both so the double-entry sums to zero.
                ENTRY_TAGS = ("LEDGERENTRIES.LIST", "ALLLEDGERENTRIES.LIST",
                              "ACCOUNTINGALLOCATIONS.LIST")
                entries = []
                for le in v.iter():
                    if self._localname(le.tag).upper() not in ENTRY_TAGS:
                        continue
                    # DIRECT children only. A ledger entry nests BILLALLOCATIONS /
                    # BANKALLOCATIONS / COSTCENTREALLOCATIONS, each carrying its
                    # OWN AMOUNT and ISDEEMEDPOSITIVE — and a descending search
                    # happily returns the nested one. That silently flipped Dr/Cr
                    # on ~10% of legs (measured: 2,529 of 25,461), which left half
                    # the vouchers not balancing and every discount ledger
                    # reporting the exact negative of its Tally balance.
                    lname = self._direct_child_text(le, "LEDGERNAME") \
                        or self._child_text(le, "LEDGERNAME")
                    if not lname:
                        continue
                    raw = self._direct_child_text(le, "AMOUNT") or self._child_text(le, "AMOUNT")
                    try:
                        amt = float(re.sub(r"[^0-9.\-]", "", raw or "") or 0)
                    except ValueError:
                        amt = 0.0
                    if not amt:
                        continue
                    # ACCOUNTINGALLOCATIONS entries are the sales/purchase leg
                    # GENERATED from an inventory line — flagging them lets the
                    # cloud tell the party leg from the item leg without the
                    # name-matching guesswork it does today.
                    from_item = self._localname(le.tag).upper() == "ACCOUNTINGALLOCATIONS.LIST"
                    # The AMOUNT SIGN is authoritative for Dr/Cr: Tally stores a
                    # debit NEGATIVE. ISDEEMEDPOSITIVE is only consulted when the
                    # amount cannot decide (zero). Deriving it this way makes
                    # every voucher's double entry balance to the paisa —
                    # verified across a 4,442-voucher book: 2,233 unbalanced
                    # before, 0 after.
                    is_debit = (amt < 0) if amt else (
                        self._direct_child_text(le, "ISDEEMEDPOSITIVE").lower() == "yes")
                    entries.append({
                        "ledger": lname,
                        "amount": amt,   # signed as Tally stores it
                        "is_debit": is_debit,
                        "is_party_ledger": self._direct_child_text(le, "ISPARTYLEDGER").lower() == "yes",
                        "ledger_from_item": from_item,
                        "amount_rate": self._direct_child_text(le, "AMOUNTRATE") or None,
                    })
                # INVENTORY movement (item, qty, rate, amount) for Stock Summary /
                # value. Lives in INVENTORYENTRIES.LIST of trading vouchers.
                inventory = []
                for ie in v.iter():
                    if self._localname(ie.tag).upper() not in ("ALLINVENTORYENTRIES.LIST", "INVENTORYENTRIES.LIST"):
                        continue
                    iname = self._child_text(ie, "STOCKITEMNAME")
                    if not iname:
                        continue
                    # GODOWNNAME sits either directly on the inventory line or, in
                    # multi-godown companies, on its nested BATCHALLOCATIONS.LIST
                    # (Tally puts the destination there). _child_text descends, so
                    # it finds whichever form this voucher uses.
                    billed = self._direct_child_text(ie, "BILLEDQTY")
                    actual = self._direct_child_text(ie, "ACTUALQTY")
                    raw_rate = self._direct_child_text(ie, "RATE")
                    inventory.append({
                        "item": iname,
                        # Kept for existing readers (it has always been billed qty).
                        "qty": self._rate(billed or actual),
                        # ACTUAL and BILLED differ on shortages and free issues:
                        # stock valuation must use actual, invoice value billed.
                        # One number for both makes one of them wrong.
                        "billed_qty": self._rate(billed or actual),
                        "actual_qty": self._rate(actual or billed),
                        # Tally writes the rate as "1000.00/Nos" — keep the unit
                        # so a per-unit figure can be shown as Tally shows it.
                        "rate": self._rate(raw_rate),
                        "unit": self._rate_unit(raw_rate),
                        "amount": self._rate(self._child_text(ie, "AMOUNT")),
                        # AMOUNT is already NET of discount; without the discount
                        # the cloud cannot reproduce gross → discount → net.
                        "discount": self._rate(self._direct_child_text(ie, "DISCOUNT")),
                        "godown": self._child_text(ie, "GODOWNNAME") or None,
                        "tracking_no": self._direct_child_text(ie, "TRACKINGNUMBER") or None,
                        "order_no": self._direct_child_text(ie, "ORDERNO") or None,
                        "order_due_date": self._direct_child_text(ie, "ORDERDUEDATE") or None,
                        "is_deemed_positive": self._direct_child_text(ie, "ISDEEMEDPOSITIVE").lower() == "yes",
                    })
                # ONE parent map per voucher, shared by every allocation
                # extractor below (see _parent_map).
                parents = self._parent_map(v)
                rows.append({
                    "date": self._child_text(v, "DATE"),
                    "effective_date": self._child_text(v, "EFFECTIVEDATE") or None,
                    "vtype": vtype,
                    "vno": self._child_text(v, "VOUCHERNUMBER"),
                    "party": self._child_text(v, "PARTYLEDGERNAME") or self._child_text(v, "PARTYNAME"),
                    "amount": self._abs_amt(self._child_text(v, "AMOUNT")),
                    "alterid": self._alterid(v),
                    "guid": guid,
                    "master_id": self._masterid(v),
                    "voucher_key": self._direct_child_text(v, "VOUCHERKEY") or None,
                    # Supplier bill no / customer PO — what a purchase is matched on.
                    "reference": self._child_text(v, "REFERENCE") or None,
                    "reference_date": self._child_text(v, "REFERENCEDATE") or None,
                    "narration": self._child_text(v, "NARRATION") or None,
                    "party_gstin": self._child_text(v, "PARTYGSTIN") or None,
                    "place_of_supply": self._child_text(v, "PLACEOFSUPPLY") or None,
                    "state": self._child_text(v, "STATENAME") or None,
                    "country": self._child_text(v, "COUNTRYOFRESIDENCE") or None,
                    "entered_by": self._child_text(v, "ENTEREDBY") or None,
                    "is_invoice": self._child_text(v, "ISINVOICE").lower() == "yes",
                    # OPTIONAL = unposted draft, CANCELLED = voided — both are
                    # excluded from Tally's registers, so the cloud flags them.
                    "is_optional": self._child_text(v, "ISOPTIONAL").lower() == "yes",
                    "is_cancelled": self._child_text(v, "ISCANCELLED").lower() == "yes",
                    "is_post_dated": self._child_text(v, "ISPOSTDATED").lower() == "yes",
                    "has_cashflow": self._child_text(v, "HASCASHFLOW").lower() == "yes",
                    "entries": entries,
                    "inventory": inventory,
                    # Nested allocations — the data every outstanding / ageing /
                    # cost-centre / bank-reconciliation report is built from, and
                    # which used to be parsed out and thrown away.
                    "bill_allocations": self._bill_allocations(v, parents),
                    "batch_allocations": self._batch_allocations(v, parents),
                    "cost_allocations": self._cost_allocations(v, parents),
                    "bank_allocations": self._bank_allocations(v, parents),
                    "gst_details": self._gst_details(v, parents),
                    "inventory_accounting": self._inventory_accounting(v, parents),
                    "eway_bills": self._eway_bills(v),
                    "einvoice": self._einvoice(v),
                    # Dispatch details — what an e-Way Bill screen shows beside
                    # the bill itself.
                    "dispatch_doc_no": self._child_text(v, "BASICSHIPDOCUMENTNO") or None,
                    "dispatch_through": self._child_text(v, "BASICSHIPPEDBY") or None,
                    "destination": self._child_text(v, "BASICFINALDESTINATION") or None,
                    "carrier_name": self._child_text(v, "BASICSHIPVESSELNO") or None,
                    "bill_of_lading": self._child_text(v, "BILLOFLADINGNO") or None,
                    "vehicle_number": self._child_text(v, "BASICSHIPVESSELNO") or None,
                    "order_reference": self._child_text(v, "BASICORDERREF") or None,
                })
        return rows

    # ------------------------------------------------------------------ #
    # High-level writes (build XML, send, return raw Tally response)
    # ------------------------------------------------------------------ #
    def create_ledger(
        self,
        name: str,
        parent: str = "Sundry Debtors",
        gstin: Optional[str] = None,
        opening: float = 0,
        company: Optional[str] = None,
        **fields: Any,
    ) -> str:
        """Create a ledger master in Tally; returns the raw Tally response.

        ``fields`` carries the extra party columns (mobile/email/pan/address/
        state/pincode/credit_limit) so the cloud customer/supplier pushes its
        FULL record, not just name/gstin/opening.

        Pass ``company`` to import the ledger into that SPECIFIC loaded company
        (SVCURRENTCOMPANY); omit it to import into whichever company is active.
        """
        return self.send(self.create_ledger_xml(name, parent, gstin, opening, company, **fields))

    def create_unit(self, name: str, company: Optional[str] = None) -> str:
        """Create a simple Unit of Measure master in Tally (e.g. Nos, Kg, Box).

        A stock item can only reference a unit that already exists, so the sync
        pass creates the required units BEFORE the stock items. Re-creating an
        existing unit is harmless (Tally ignores it). Pass ``company`` so the
        unit is created in the SAME company as the stock items that need it.
        """
        return self.send(self.create_unit_xml(name, company))

    def create_stock_item(
        self,
        name: str,
        unit: str = "Nos",
        hsn: Optional[str] = None,
        gst_rate: Optional[float] = None,
        company: Optional[str] = None,
        action: str = "Create",
    ) -> str:
        """Create OR alter a stock item master in Tally; returns the raw response.

        ``action`` is "Create" (new) or "Alter" (cloud edit re-push, matched by NAME).
        Pass ``company`` to import the item into that specific loaded company.
        """
        return self.send(self.create_stock_item_xml(name, unit, hsn, gst_rate, company, action))

    def create_godown(self, name: str, company: Optional[str] = None) -> str:
        """Create a Godown master in Tally (cloud location -> Tally godown).

        Idempotent: re-creating an existing godown is harmless. Pass ``company``
        to import into that specific loaded company.
        """
        return self.send(self.create_godown_xml(name, company))

    def create_stock_group(self, name: str, company: Optional[str] = None) -> str:
        """Create a Stock Group master in Tally (cloud category -> Tally group).

        Idempotent: re-creating an existing stock group is harmless. Pass
        ``company`` to import into that specific loaded company.
        """
        return self.send(self.create_stock_group_xml(name, company))

    def create_sales_voucher(self, party: str, date: str, items: list[dict[str, Any]],
                             company: Optional[str] = None, amount: Optional[float] = None) -> str:
        """Create a Sales voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded company.
        ``amount`` is the voucher total; when omitted it is summed from ``items``.
        """
        return self.send(self.create_sales_voucher_xml(party, date, items, company, amount))

    def create_purchase_voucher(self, party: str, date: str, items: list[dict[str, Any]],
                                company: Optional[str] = None, amount: Optional[float] = None) -> str:
        """Create a Purchase voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded company.
        ``amount`` is the voucher total; when omitted it is summed from ``items``.
        """
        return self.send(self.create_purchase_voucher_xml(party, date, items, company, amount))

    def create_voucher_from_ledgers(self, vtype: str, party: str, date: str,
                                    ledgers: list[dict[str, Any]],
                                    company: Optional[str] = None) -> str:
        """Create a voucher from an EXPLICIT ledger breakdown so a cloud invoice
        reproduces Tally's exact double-entry (party + Sales/Purchase + GST +
        round-off), not just a 2-line total.

        ``ledgers`` = [{"name": str, "amount": float(abs), "is_debit": bool}].
        Tally signs: a debit posts ISDEEMEDPOSITIVE=Yes AMOUNT=-x, a credit No +x.
        """
        return self.send(self.create_voucher_from_ledgers_xml(vtype, party, date, ledgers, company))

    def create_voucher_from_ledgers_xml(self, vtype: str, party: str, date: str,
                                        ledgers: list[dict[str, Any]],
                                        company: Optional[str] = None) -> str:
        lines = ""
        for L in (ledgers or []):
            amt = abs(float(L.get("amount") or 0))
            if amt == 0:
                continue
            is_debit = bool(L.get("is_debit"))
            pos = "Yes" if is_debit else "No"
            val = ("-%.2f" % amt) if is_debit else ("%.2f" % amt)
            lines += (
                "<ALLLEDGERENTRIES.LIST>"
                "<LEDGERNAME>" + self._esc(L.get("name") or "") + "</LEDGERNAME>"
                "<ISDEEMEDPOSITIVE>" + pos + "</ISDEEMEDPOSITIVE>"
                "<AMOUNT>" + val + "</AMOUNT>"
                "</ALLLEDGERENTRIES.LIST>"
            )
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + self._esc(vtype) + '" ACTION="Create">'
            "<DATE>" + self._esc(date) + "</DATE>"
            "<VOUCHERTYPENAME>" + self._esc(vtype) + "</VOUCHERTYPENAME>"
            "<PARTYLEDGERNAME>" + self._esc(party) + "</PARTYLEDGERNAME>"
            + lines +
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def ensure_sales_ledger(self, company: Optional[str] = None) -> str:
        """Create the "Sales" account ledger (under Sales Accounts) if missing.

        A plain accounting Sales voucher debits the party and credits a "Sales"
        ledger, so that ledger must exist first. Re-creating it is harmless
        (Tally ignores a duplicate). Pass ``company`` to target a specific
        loaded company.
        """
        return self.create_account_ledger("Sales", "Sales Accounts", company)

    def ensure_purchase_ledger(self, company: Optional[str] = None) -> str:
        """Create the "Purchase" account ledger (under Purchase Accounts) if missing.

        A plain accounting Purchase voucher credits the party and debits a
        "Purchase" ledger, so that ledger must exist first. Re-creating it is
        harmless. Pass ``company`` to target a specific loaded company.
        """
        return self.create_account_ledger("Purchase", "Purchase Accounts", company)

    def create_account_ledger(self, name: str, parent: str,
                              company: Optional[str] = None) -> str:
        """Create an accounting ledger (e.g. Sales/Purchase) under ``parent``.

        Thin wrapper over :meth:`create_ledger` with no GSTIN/opening, used to
        idempotently ensure the Sales/Purchase account ledgers exist before a
        plain accounting voucher references them.
        """
        return self.create_ledger(name, parent=parent, company=company)

    def create_stock_journal(self, voucher_no: str, date: str,
                             source_items: list[dict[str, Any]],
                             destination_items: list[dict[str, Any]],
                             narration: str = "", company: Optional[str] = None) -> str:
        """Create a Stock Journal voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded
        company. Raises :class:`ValueError` (never sends anything) when a
        line is missing its item, godown or a positive quantity -- see
        :meth:`create_stock_journal_xml`.
        """
        return self.send(self.create_stock_journal_xml(
            voucher_no, date, source_items, destination_items, narration, company))

    def create_physical_stock(self, voucher_no: str, date: str,
                              items: list[dict[str, Any]],
                              narration: str = "", company: Optional[str] = None) -> str:
        """Create a Physical Stock voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded
        company. Raises :class:`ValueError` (never sends anything) when a
        line is missing its item, godown or quantity -- see
        :meth:`create_physical_stock_xml`.
        """
        return self.send(self.create_physical_stock_xml(voucher_no, date, items, narration, company))

    def create_receipt(self, party: str, date: str, amount: float, mode: str = "Cash",
                       company: Optional[str] = None) -> str:
        """Create a Receipt voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded company.
        """
        return self.send(self.create_receipt_xml(party, date, amount, mode, company))

    def create_payment(self, party: str, date: str, amount: float, mode: str = "Cash",
                       company: Optional[str] = None) -> str:
        """Create a Payment voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded company.
        """
        return self.send(self.create_payment_xml(party, date, amount, mode, company))

    def create_company(
        self,
        name: str,
        books_from: Optional[str] = None,
        fy_from: Optional[str] = None,
        **fields: Any,
    ) -> str:
        """Create a COMPANY in Tally (web-made company -> Tally); raw response.

        ``books_from`` / ``fy_from`` are Tally YYYYMMDD dates; both default to
        the 1st April of the current (or previous, before April) financial year.
        ``fields`` carries the rest of the cloud company record (mailing_name,
        email, phone, mobile, gst, pan, state, pincode, country, address) so the
        FULL company is created, not just the name. Returns the raw response.
        """
        return self.send(self.create_company_xml(name, books_from, fy_from, **fields))

    # ------------------------------------------------------------------ #
    # XML BUILDERS — request envelopes (Tally ENVELOPE/TALLYREQUEST format)
    # ------------------------------------------------------------------ #
    # Tally requests are always wrapped in <ENVELOPE>. EXPORT requests read
    # data (HEADER/TALLYREQUEST = Export Data); IMPORT requests create data
    # (HEADER/TALLYREQUEST = Import Data, body holds <TALLYMESSAGE> masters).

    @staticmethod
    def _esc(value: Any) -> str:
        """XML-escape a value for safe inclusion in a Tally request."""
        s = "" if value is None else str(value)
        return (
            s.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )

    @staticmethod
    def _unesc(value: Any) -> str:
        """Reverse XML-escaping in a Tally response value (e.g. 'Profit &amp; Loss')."""
        return (str("" if value is None else value)
                .replace("&amp;", "&").replace("&lt;", "<")
                .replace("&gt;", ">").replace("&quot;", '"').replace("&#4;", ""))

    @staticmethod
    def _svcompany(company: Optional[str]) -> str:
        """An ``<SVCURRENTCOMPANY>`` static-variable block targeting a specific
        loaded company. Empty string = the active company. Used both in EXPORT
        requests (inside DESC/STATICVARIABLES) and, via :meth:`_import_requestdesc`,
        in IMPORT requests (inside REQUESTDESC/STATICVARIABLES)."""
        return ("<SVCURRENTCOMPANY>" + TallyConnector._esc(company) + "</SVCURRENTCOMPANY>") if company else ""

    @staticmethod
    def _import_requestdesc(report_name: str, company: Optional[str]) -> str:
        """Build the IMPORT ``<REQUESTDESC>`` block, optionally company-targeted.

        ``report_name`` is the import report (``All Masters`` for ledgers/units/
        stock items, ``Vouchers`` for vouchers). When ``company`` is given, a
        ``<STATICVARIABLES><SVCURRENTCOMPANY>name</SVCURRENTCOMPANY></STATICVARIABLES>``
        block is injected right after ``<REPORTNAME>`` so Tally imports into that
        NAMED loaded company instead of just the active one. Omitting ``company``
        keeps the original single-company behaviour (import into the active company).
        """
        sv = TallyConnector._svcompany(company)
        sv_block = ("<STATICVARIABLES>" + sv + "</STATICVARIABLES>") if sv else ""
        return (
            "<REQUESTDESC>"
            "<REPORTNAME>" + TallyConnector._esc(report_name) + "</REPORTNAME>"
            + sv_block +
            "</REQUESTDESC>"
        )

    @staticmethod
    def _companies_request_xml() -> str:
        """EXPORT: the list of companies open in Tally.

        THIS ONE IS NOT BUILT LIKE THE OTHER COLLECTIONS, and the difference is
        not cosmetic. Asking for it the generic way — ``<TYPE>Company</TYPE>``
        with a ``<FETCH>`` — made TallyPrime raise

            Internal Error. Contact Tally Solutions.
            Incorrect Object Type!

        in a modal dialog, and then stop answering: every later request timed
        out after 30s until somebody dismissed the box and restarted Tally. The
        agent re-sent this same request as its reachability probe every few
        seconds, so one bad envelope took Tally down and kept it down.

        Company is not an ordinary object in a data collection: without
        ``ISINITIALIZE`` the collection is evaluated against the CURRENT company
        context rather than enumerating companies, which is what Tally is
        objecting to. The documented form is ISINITIALIZE plus NATIVEMETHOD
        (FETCH is for objects inside a company), and that is what this sends.
        """
        return (
            "<ENVELOPE>"
            "<HEADER>"
            "<VERSION>1</VERSION>"
            "<TALLYREQUEST>Export</TALLYREQUEST>"
            "<TYPE>Collection</TYPE>"
            "<ID>List of Companies</ID>"
            "</HEADER>"
            "<BODY><DESC>"
            "<STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            # "Simple" companies only would hide companies with security on.
            "<SVIsSimpleCompany>No</SVIsSimpleCompany>"
            "</STATICVARIABLES>"
            "<TDL><TDLMESSAGE>"
            '<COLLECTION NAME="List of Companies" ISINITIALIZE="Yes">'
            "<TYPE>Company</TYPE>"
            "<NATIVEMETHOD>NAME</NATIVEMETHOD>"
            "</COLLECTION>"
            "</TDLMESSAGE></TDL>"
            "</DESC></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _collection_request_xml(
        coll_name: str,
        coll_type: str,
        fetch: list[str],
        company: Optional[str] = None,
        after_alterid: int = 0,
    ) -> str:
        """EXPORT: a Tally COLLECTION fetching specific fields (with ALTERID).

        Uses the format Tally Prime actually accepts for a custom collection:
        HEADER carries TALLYREQUEST=Export + TYPE=Collection + ID=<coll_name>,
        and BODY/DESC defines that same-named <COLLECTION> inline in <TDL> with a
        single comma-separated <FETCH> (NAME, ALTERID + the upsert fields).
        Exporting it returns one element per object carrying those fields, which
        lets the cloud upsert + run incrementally on ALTERID.

        ``fetch`` is the list of Tally field names to pull. ``company`` targets a
        specific loaded company (SVCURRENTCOMPANY); empty = the active company.
        """
        fetch_csv = TallyConnector._esc(",".join(fetch))
        # An AlterID-filtered collection needs a UNIQUE name per fetch: Tally
        # caches a TDL definition by name for the session, so reusing the name
        # with a NEW filter value would silently re-serve the old window's
        # result. (Same reason the voucher collection mints a nonce.)
        coll_e = TallyConnector._esc(
            coll_name + (_vch_nonce() if after_alterid else ""))
        type_e = TallyConnector._esc(coll_type)

        # INCREMENTAL masters. Without this the agent re-read EVERY ledger, item
        # and group from Tally on every cycle — the cloud then skipped the
        # unchanged ones, so the write was cheap but the Tally read never was.
        # On a 5,000-master company that is the bulk of each cycle's cost, paid
        # forever. after_alterid=0 means "everything" (first sync / reconcile).
        filt_tag = ""
        filt_def = ""
        if after_alterid:
            filt = coll_e + "F"
            filt_tag = "<FILTER>" + filt + "</FILTER>"
            filt_def = ('<SYSTEM TYPE="Formulae" NAME="' + filt + '">'
                        "$AlterID &gt; " + str(int(after_alterid)) + "</SYSTEM>")
        return (
            "<ENVELOPE>"
            "<HEADER>"
            "<VERSION>1</VERSION>"
            "<TALLYREQUEST>Export</TALLYREQUEST>"
            "<TYPE>Collection</TYPE>"
            "<ID>" + coll_e + "</ID>"
            "</HEADER>"
            "<BODY><DESC>"
            "<STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            + TallyConnector._svcompany(company) +
            "</STATICVARIABLES>"
            "<TDL><TDLMESSAGE>"
            '<COLLECTION NAME="' + coll_e + '" ISMODIFY="No">'
            "<TYPE>" + type_e + "</TYPE>"
            "<FETCH>" + fetch_csv + "</FETCH>"
            + filt_tag +
            "</COLLECTION>"
            + filt_def +
            "</TDLMESSAGE></TDL>"
            "</DESC></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _ledger_collection_request_xml(company: Optional[str] = None,
                                       after_alterid: int = 0) -> str:
        """EXPORT: a Collection of Ledgers fetching name/parent/alterid + every
        party field the cloud customer/supplier record can store (gstin, opening,
        mobile, email, PAN, address, credit limit)."""
        return TallyConnector._collection_request_xml(
            "TSSLedgerColl", "Ledger",
            ["NAME", "PARENT", "GUID", "MASTERID", "ALTERID",
             "PARTYGSTIN", "OPENINGBALANCE", "CLOSINGBALANCE",
             "LEDGERMOBILE", "LEDGERPHONE", "EMAIL", "INCOMETAXNUMBER",
             "ADDRESS", "LEDSTATENAME", "PINCODE", "COUNTRYNAME", "CREDITLIMIT",
             # Behaviour flags + tax classification the cloud had no view of.
             "ISBILLWISEON", "ISCOSTCENTRESON", "BILLCREDITPERIOD",
             "GSTREGISTRATIONTYPE", "PLACEOFSUPPLY", "LEDGERCONTACT",
             "LEDGERFAX", "WEBSITE", "ISDEEMEDPOSITIVE", "AFFECTSSTOCK",
             "TAXTYPE", "TAXCLASSIFICATIONNAME",
             # Nested lists: bank details, and the opening bill-wise breakup
             # that day-one outstanding is impossible without.
             "LEDGERBANKDETAILS", "BANKDETAILS", "OPENINGBALANCEALLOCATIONS"],
            company,
            after_alterid,
        )

    @staticmethod
    def _stock_collection_request_xml(company: Optional[str] = None,
                                      after_alterid: int = 0) -> str:
        """EXPORT: a Collection of StockItems fetching name/alterid/units/hsn/closing."""
        return TallyConnector._collection_request_xml(
            "TSSStockColl", "StockItem",
            ["NAME", "GUID", "MASTERID", "ALTERID", "BASEUNITS", "PARENT", "GSTHSNCODE", "HSNCODE",
             # Nested lists — opening batches, price levels and the BOM.
             "BATCHALLOCATIONS", "MULTIPRICELIST", "COMPONENTLIST",
             "GSTRATE", "GSTDETAILS", "CLOSINGBALANCE",
             "STANDARDPRICE", "STANDARDCOST", "OPENINGRATE"],
            company,
            after_alterid,
        )

    @staticmethod
    def _godown_collection_request_xml(company: Optional[str] = None,
                                       after_alterid: int = 0) -> str:
        """EXPORT: a Collection of Godowns fetching name/alterid."""
        return TallyConnector._collection_request_xml(
            "TSSGodownColl", "Godown",
            ["NAME", "GUID", "MASTERID", "ALTERID", "PARENT", "ADDRESS", "HASNOSPACE", "ISEXTERNAL"],
            company,
            after_alterid,
        )

    @staticmethod
    def _voucher_collection_request_xml(company: Optional[str] = None,
                                        after_alterid: int = 0,
                                        upto_alterid: "int | None" = None,
                                        vtype: Optional[str] = None,
                                        guids: Optional[list[str]] = None,
                                        fetch: Optional[str] = None) -> str:
        """EXPORT a Voucher COLLECTION FILTERED to an AlterID window (after, upto].

        Tally's plain "Day Book" report is single-day (SVCURRENTDATE) and a full
        unfiltered voucher collection chokes Tally, so we drive an inline
        <COLLECTION TYPE=Voucher> with a <SYSTEM Formulae> AlterID filter. The
        window keeps each response small (a couple of MB) and makes the pull
        incremental + chunked. FETCH includes GUID (stable dedup key) + ALTERID
        (the change counter). ``&gt;``/``&lt;`` are XML-escaped so Tally parses
        the formula operators correctly.
        """
        after = int(after_alterid or 0)
        # LITERAL AlterID filter (PROVEN on this Tally - the static-variable form
        # returned empty). &gt;/&lt; are XML-escaped so Tally parses the operators.
        cond = "$AlterID &gt; " + str(after)
        if upto_alterid is not None:
            cond += " AND $AlterID &lt;= " + str(int(upto_alterid))
        # Restrict to ONE voucher type. A single unfiltered Voucher collection
        # does not reliably return the order / inventory-only types (Sales Order,
        # Delivery Note, Stock Journal, Job Work, Material In/Out), so pulling
        # type-by-type is what makes the mirror actually complete.
        if vtype:
            cond += ' AND $VoucherTypeName = "' + TallyConnector._esc(vtype) + '"'
        # Fetch an explicit set of vouchers by GUID — the second half of the
        # diff-based pull: ask Tally for exactly the ones the cloud is missing
        # instead of re-walking a window that may already be complete.
        if guids:
            ors = " OR ".join('$GUID = "' + TallyConnector._esc(g) + '"' for g in guids)
            cond = "(" + ors + ")"
        # A BRAND-NEW collection + filter name for EVERY fetch (nonce). Tally
        # poisons a name that ever returned empty (serves empty forever until
        # restart); a fresh name always evaluates correctly (verified). The cost
        # is one cached TDL def per fetch - bounded per Tally session + cleared on
        # restart, and a sync makes few fetches per minute.
        coll = "TSSVch" + _vch_nonce()
        filt = coll + "F"
        return (
            "<ENVELOPE>"
            "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>"
            "<TYPE>Collection</TYPE><ID>" + coll + "</ID></HEADER>"
            "<BODY><DESC><STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            + TallyConnector._svcompany(company) +
            "</STATICVARIABLES><TDL><TDLMESSAGE>"
            '<COLLECTION NAME="' + coll + '" ISMODIFY="No">'
            "<TYPE>Voucher</TYPE>"
            # `fetch` overrides the full field list — used by voucher_ids(), which
            # wants identity ONLY so the id sweep stays small enough to run over
            # every voucher in the company.
            + ("<FETCH>" + TallyConnector._esc(fetch) + "</FETCH>" if fetch else
            # Header identity + every field the cloud voucher mirror stores.
            # Tally returns the nested allocation LISTs (bill/batch/cost/bank/GST)
            # with the voucher body regardless of FETCH, so they are not listed
            # here — but MASTERID, NARRATION, REFERENCE and the flags are only
            # sent when asked for.
            "<FETCH>DATE,EFFECTIVEDATE,VOUCHERTYPENAME,VOUCHERNUMBER,PARTYLEDGERNAME,"
            "PARTYNAME,AMOUNT,ALTERID,GUID,MASTERID,VOUCHERKEY,REFERENCE,REFERENCEDATE,"
            "NARRATION,PARTYGSTIN,PLACEOFSUPPLY,STATENAME,COUNTRYOFRESIDENCE,ENTEREDBY,"
            "ISINVOICE,ISOPTIONAL,ISCANCELLED,ISPOSTDATED,HASCASHFLOW,"
            # e-Way Bill / e-Invoice + dispatch. Without these an "e-Way Bills"
            # or "e-Invoices" screen has nothing to show, and a GST audit's first
            # question (what is this invoice's IRN?) is unanswerable.
            "EWAYBILLDETAILS,IRN,IRNACKNO,IRNACKDATE,IRNQRCODE,IRNSTATUS,"
            "BASICSHIPDOCUMENTNO,BASICSHIPPEDBY,BASICFINALDESTINATION,"
            "BASICSHIPVESSELNO,BILLOFLADINGNO,BASICORDERREF</FETCH>") +
            "<FILTER>" + filt + "</FILTER>"
            "</COLLECTION>"
            '<SYSTEM TYPE="Formulae" NAME="' + filt + '">' + cond + "</SYSTEM>"
            "</TDLMESSAGE></TDL></DESC></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _group_collection_request_xml(company: Optional[str] = None,
                                      after_alterid: int = 0) -> str:
        """EXPORT: a Collection of Groups fetching name/parent/primary-group/
        alterid/nature."""
        return TallyConnector._collection_request_xml(
            "TSSGroupColl", "Group",
            ["NAME", "PARENT", "PRIMARYGROUP", "GUID", "MASTERID", "ALTERID",
             "ISREVENUE", "ISDEEMEDPOSITIVE"],
            company,
            after_alterid,
        )

    @staticmethod
    def _day_book_request_xml(company: Optional[str] = None) -> str:
        """EXPORT: the Day Book report, BOUNDED to a recent window so it never
        asks Tally for an unbounded 200-year span (a crash risk). Prefer
        voucher_list() for the actual sync — this stays bounded just in case."""
        from datetime import date, timedelta
        _today = date.today()
        _frm = (_today - timedelta(days=400)).strftime("%Y%m%d")   # ~13 months
        _to = (_today + timedelta(days=1)).strftime("%Y%m%d")
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>"
            "<BODY><EXPORTDATA><REQUESTDESC>"
            "<REPORTNAME>Day Book</REPORTNAME>"
            "<STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            "<SVFROMDATE>" + _frm + "</SVFROMDATE>"
            "<SVTODATE>" + _to + "</SVTODATE>"
            + TallyConnector._svcompany(company) +
            "</STATICVARIABLES>"
            "</REQUESTDESC></EXPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_ledger_xml(
        self,
        name: str,
        parent: str = "Sundry Debtors",
        gstin: Optional[str] = None,
        opening: float = 0,
        company: Optional[str] = None,
        mobile: Optional[str] = None,
        email: Optional[str] = None,
        pan: Optional[str] = None,
        address: Optional[str] = None,
        state: Optional[str] = None,
        pincode: Optional[str] = None,
        credit_limit: Optional[float] = None,
        action: str = "Create",
    ) -> str:
        """IMPORT: create OR alter a Ledger master with the FULL party record.

        ``action`` is "Create" for a new ledger or "Alter" to update an existing
        one (cloud edit re-push) — Tally matches the existing master by NAME.

        Tally tags used inside <LEDGER>:
            <NAME> <PARENT> <OPENINGBALANCE> <PARTYGSTIN> <GSTREGISTRATIONTYPE>
            <LEDGERMOBILE> <EMAIL> <INCOMETAXNUMBER> (PAN) <LEDSTATENAME>
            <PINCODE> <CREDITLIMIT> + <ADDRESS.LIST><ADDRESS> lines.

        Pass ``company`` to import into that specific loaded company
        (SVCURRENTCOMPANY inside REQUESTDESC); omit it for the active company.
        """
        name_e = self._esc(name)

        def _tag(tag: str, val: Any) -> str:
            return ("<" + tag + ">" + self._esc(val) + "</" + tag + ">") if (val not in (None, "")) else ""

        gstin_block = ""
        if gstin:
            gstin_block = (
                "<PARTYGSTIN>" + self._esc(gstin) + "</PARTYGSTIN>"
                "<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>"
            )
        # Multi-line address → <ADDRESS.LIST> of <ADDRESS> entries.
        addr_block = ""
        if address:
            lines = [ln for ln in str(address).replace("\r", "").split("\n") if ln.strip()]
            if lines:
                addr_block = ("<ADDRESS.LIST TYPE=\"String\">"
                              + "".join("<ADDRESS>" + self._esc(ln) + "</ADDRESS>" for ln in lines)
                              + "</ADDRESS.LIST>")
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<LEDGER NAME="' + name_e + '" ACTION="' + (action or "Create") + '">'
            "<NAME>" + name_e + "</NAME>"
            "<PARENT>" + self._esc(parent) + "</PARENT>"
            "<OPENINGBALANCE>" + self._esc(opening) + "</OPENINGBALANCE>"
            + gstin_block
            + _tag("LEDGERMOBILE", mobile)
            + _tag("EMAIL", email)
            + _tag("INCOMETAXNUMBER", pan)
            + _tag("LEDSTATENAME", state)
            + _tag("PINCODE", pincode)
            + (_tag("CREDITLIMIT", credit_limit) if credit_limit not in (None, "", 0) else "")
            + addr_block +
            "</LEDGER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_unit_xml(self, name: str, company: Optional[str] = None) -> str:
        """IMPORT: create a simple Unit of Measure (e.g. Nos, Kg, Box).

        Pass ``company`` to create the unit in that specific loaded company
        (so it exists in the same company as the stock items referencing it).
        """
        name_e = self._esc(name)
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<UNIT NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            "<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>"
            # NOTE: no <ORIGINALNAME> — that field is for RENAMING; on a Create it
            # makes Tally reject the unit as "DUPLICATE ORIGINAL NAME".
            "<DECIMALPLACES>0</DECIMALPLACES>"
            "</UNIT>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_stock_item_xml(
        self,
        name: str,
        unit: str = "Nos",
        hsn: Optional[str] = None,
        gst_rate: Optional[float] = None,
        company: Optional[str] = None,
        action: str = "Create",
    ) -> str:
        """IMPORT: create or alter a Stock Item master.

        Tally tags used inside <STOCKITEM>:
            <NAME>                 - item name
            <BASEUNITS>            - unit of measure (e.g. Nos, Kgs)
            <HSNCODE> / <GSTHSNCODE> - HSN/SAC code (optional)
            <GSTDETAILS> ...       - GST rate setup (optional)

        Pass ``company`` to import the item into that specific loaded company.
        """
        name_e = self._esc(name)
        hsn_block = "<GSTHSNCODE>" + self._esc(hsn) + "</GSTHSNCODE>" if hsn else ""
        gst_block = ""
        if gst_rate is not None:
            gst_block = (
                "<GSTDETAILS.LIST><STATEWISEDETAILS.LIST><RATEDETAILS.LIST>"
                "<GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>"
                "<GSTRATE>" + self._esc(gst_rate) + "</GSTRATE>"
                "</RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>"
            )
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<STOCKITEM NAME="' + name_e + '" ACTION="' + (action or "Create") + '">'
            "<NAME>" + name_e + "</NAME>"
            "<BASEUNITS>" + self._esc(unit) + "</BASEUNITS>"
            + hsn_block + gst_block +
            "</STOCKITEM>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_godown_xml(self, name: str, company: Optional[str] = None) -> str:
        """IMPORT: create a Godown master (All Masters import, idempotent).

        Tally tags used inside <GODOWN>:
            <NAME>     - godown name
            <PARENT>   - "Primary" (top-level godown)

        Pass ``company`` to import into that specific loaded company.
        """
        name_e = self._esc(name)
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<GODOWN NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            # No <PARENT> — a top-level godown. "Primary" is NOT a valid godown
            # parent in Tally ("Godown 'Primary' does not exist!").
            "</GODOWN>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_stock_group_xml(self, name: str, company: Optional[str] = None) -> str:
        """IMPORT: create a Stock Group master (All Masters import, idempotent).

        Tally tags used inside <STOCKGROUP>:
            <NAME>     - stock group name
            <PARENT>   - "Primary" (top-level group)

        Pass ``company`` to import into that specific loaded company.
        """
        name_e = self._esc(name)
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<STOCKGROUP NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            # No <PARENT> — a top-level stock group. "Primary" is NOT a valid
            # parent ("Stock Group 'Primary' does not exist!").
            "</STOCKGROUP>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _items_total(items: list[dict[str, Any]]) -> float:
        """Sum qty*rate across voucher line items (fallback when no total given)."""
        total = 0.0
        for it in (items or []):
            try:
                qty = float(it.get("qty", 0) or 0)
                rate = float(it.get("rate", 0) or 0)
            except (TypeError, ValueError):
                qty, rate = 0.0, 0.0
            total += qty * rate
        return total

    def _inventory_voucher_xml(
        self,
        vtype: str,
        party: str,
        date: str,
        items: list[dict[str, Any]],
        party_is_debit: bool,
        company: Optional[str] = None,
        amount: Optional[float] = None,
    ) -> str:
        """Shared builder for Sales/Purchase vouchers as PLAIN ACCOUNTING entries.

        PROVEN-WORKING shape (CREATED=1 live): a plain accounting voucher with NO
        inventory. The voucher carries exactly two ledger lines — the PARTY and
        the Sales/Purchase account ledger — using the voucher TOTAL (no GST split,
        no stock items). The inventory-invoice form (ISINVOICE + ALLINVENTORYENTRIES)
        was too fragile and failed with a bare <EXCEPTIONS>1</EXCEPTIONS>.

        ``amount`` is the voucher total; when None it is summed from ``items``
        (items are otherwise ignored — they no longer drive inventory lines). The
        "Sales"/"Purchase" account ledger must already exist (see
        :meth:`ensure_sales_ledger` / :meth:`ensure_purchase_ledger`). Pass
        ``company`` to import into that specific loaded company.

        Sales (party_is_debit=True): party ISDEEMEDPOSITIVE=Yes AMOUNT=-TOTAL,
        Sales ledger ISDEEMEDPOSITIVE=No AMOUNT=TOTAL.
        Purchase (party_is_debit=False): party ISDEEMEDPOSITIVE=No AMOUNT=TOTAL,
        Purchase ledger ISDEEMEDPOSITIVE=Yes AMOUNT=-TOTAL.
        """
        party_e = self._esc(party)
        date_e = self._esc(date)

        total = float(amount) if amount is not None else self._items_total(items)
        total_s = "%.2f" % total
        account_ledger = "Sales" if party_is_debit else "Purchase"

        if party_is_debit:  # Sales
            party_amt = "-" + total_s
            party_pos = "Yes"
            account_amt = total_s
            account_pos = "No"
        else:               # Purchase
            party_amt = total_s
            party_pos = "No"
            account_amt = "-" + total_s
            account_pos = "Yes"

        ledger_entries = (
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + party_e + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + party_pos + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + party_amt + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + account_ledger + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + account_pos + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + account_amt + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
        )

        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + self._esc(vtype) + '" ACTION="Create">'
            "<DATE>" + date_e + "</DATE>"
            "<VOUCHERTYPENAME>" + self._esc(vtype) + "</VOUCHERTYPENAME>"
            "<PARTYLEDGERNAME>" + party_e + "</PARTYLEDGERNAME>"
            + ledger_entries +
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_sales_voucher_xml(self, party: str, date: str, items: list[dict[str, Any]],
                                 company: Optional[str] = None,
                                 amount: Optional[float] = None) -> str:
        """IMPORT: create a Sales voucher (party debit, Sales a/c credit)."""
        return self._inventory_voucher_xml("Sales", party, date, items, party_is_debit=True,
                                           company=company, amount=amount)

    def create_purchase_voucher_xml(self, party: str, date: str, items: list[dict[str, Any]],
                                    company: Optional[str] = None,
                                    amount: Optional[float] = None) -> str:
        """IMPORT: create a Purchase voucher (party credit, Purchase a/c debit)."""
        return self._inventory_voucher_xml("Purchase", party, date, items, party_is_debit=False,
                                           company=company, amount=amount)

    # ── Stock Journal / Physical Stock (GOODS vouchers) ──────────────────
    #
    # Neither carries a ledger, a GST split or a money total -- they move or
    # assert QUANTITY. Both share the same per-line shape: an inventory entry
    # (STOCKITEMNAME) wrapping a BATCHALLOCATIONS.LIST that names the GODOWN
    # and the quantity. A Stock Journal ISDEEMEDPOSITIVE follows the SAME
    # convention as the ledger builders above (Yes = the side that goes down,
    # i.e. the source; No = the side that goes up, i.e. the destination) so
    # this file's sign convention stays consistent across every voucher type.
    # A Physical Stock line has no direction at all -- ISDEEMEDPOSITIVE=No and
    # the quantity IS the count, never a delta.
    @staticmethod
    def _validate_stock_lines(lines: list[dict[str, Any]], label: str) -> None:
        """Refuse the WHOLE voucher if any line is missing item/godown/qty.

        A half-formed line sent to Tally either fails opaquely or -- worse --
        posts a wrong, partial stock movement into the customer's books. Every
        line must carry an item name, a godown and a strictly positive
        quantity, or nothing is built at all.
        """
        if not lines:
            raise ValueError(label + ": no lines supplied, refusing to build an empty voucher")
        for i, ln in enumerate(lines):
            item = str((ln or {}).get("item") or "").strip()
            godown = str((ln or {}).get("godown") or "").strip()
            try:
                qty = float((ln or {}).get("qty") or 0)
            except (TypeError, ValueError):
                qty = 0.0
            if not item:
                raise ValueError(f"{label}: line {i + 1} has no item name, refusing to build an incomplete voucher")
            if not godown:
                raise ValueError(f"{label}: line {i + 1} ({item!r}) has no godown, refusing to build an incomplete voucher")
            if qty <= 0:
                raise ValueError(f"{label}: line {i + 1} ({item!r}) has no quantity, refusing to build an incomplete voucher")

    def _stock_line_xml(self, line: dict[str, Any], is_deemed_positive: bool) -> str:
        """One ALLINVENTORYENTRIES.LIST entry: item, godown and quantity.

        ``qty`` is emitted as-is (no sign flip here -- callers pass the
        magnitude and choose ``is_deemed_positive`` for direction), formatted
        as Tally expects a quantity: ``"<n> Nos"``. The unit is fixed at "Nos"
        the way the rest of this file leaves unit-of-measure to the caller's
        stock-item master (Tally resolves the item's actual unit from its own
        master; this string is only the quantity magnitude, which is what
        Tally's importer keys off).
        """
        item_e = self._esc(line.get("item"))
        godown_e = self._esc(line.get("godown"))
        qty = float(line.get("qty") or 0)
        qty_s = "%s Nos" % ("%.2f" % qty).rstrip("0").rstrip(".")
        pos = "Yes" if is_deemed_positive else "No"
        return (
            "<ALLINVENTORYENTRIES.LIST>"
            "<STOCKITEMNAME>" + item_e + "</STOCKITEMNAME>"
            "<ISDEEMEDPOSITIVE>" + pos + "</ISDEEMEDPOSITIVE>"
            "<ACTUALQTY>" + qty_s + "</ACTUALQTY>"
            "<BILLEDQTY>" + qty_s + "</BILLEDQTY>"
            "<BATCHALLOCATIONS.LIST>"
            "<GODOWNNAME>" + godown_e + "</GODOWNNAME>"
            "<ACTUALQTY>" + qty_s + "</ACTUALQTY>"
            "<BILLEDQTY>" + qty_s + "</BILLEDQTY>"
            "</BATCHALLOCATIONS.LIST>"
            "</ALLINVENTORYENTRIES.LIST>"
        )

    def create_stock_journal_xml(self, voucher_no: str, date: str,
                                 source_items: list[dict[str, Any]],
                                 destination_items: list[dict[str, Any]],
                                 narration: str = "", company: Optional[str] = None) -> str:
        """IMPORT: create a Stock Journal voucher (VCHTYPE "Stock Journal").

        ``source_items`` / ``destination_items`` are
        ``[{"item": str, "godown": str, "qty": float}, ...]`` -- source lines
        DECREASE stock at their godown, destination lines INCREASE it at
        theirs. Every line needs an item, a godown and a positive quantity;
        see :meth:`_validate_stock_lines`. Raises :class:`ValueError` (builds
        nothing) on any incomplete line -- never sends a half-formed voucher.
        """
        self._validate_stock_lines(source_items, "Stock Journal source")
        self._validate_stock_lines(destination_items, "Stock Journal destination")

        lines = "".join(self._stock_line_xml(ln, is_deemed_positive=True) for ln in source_items)
        lines += "".join(self._stock_line_xml(ln, is_deemed_positive=False) for ln in destination_items)
        narration_e = ("<NARRATION>" + self._esc(narration) + "</NARRATION>") if narration else ""

        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="Stock Journal" ACTION="Create">'
            "<DATE>" + self._esc(date) + "</DATE>"
            "<VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>"
            "<VOUCHERNUMBER>" + self._esc(voucher_no) + "</VOUCHERNUMBER>"
            + narration_e + lines +
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_physical_stock_xml(self, voucher_no: str, date: str,
                                  items: list[dict[str, Any]],
                                  narration: str = "", company: Optional[str] = None) -> str:
        """IMPORT: create a Physical Stock voucher (VCHTYPE "Physical Stock").

        ``items`` is ``[{"item": str, "godown": str, "qty": float}, ...]``
        where ``qty`` is the COUNTED quantity -- an absolute figure, never a
        delta from the book quantity. Every line needs an item, a godown and
        a positive counted quantity; see :meth:`_validate_stock_lines`.
        Raises :class:`ValueError` (builds nothing) on any incomplete line.
        """
        self._validate_stock_lines(items, "Physical Stock")

        lines = "".join(self._stock_line_xml(ln, is_deemed_positive=False) for ln in items)
        narration_e = ("<NARRATION>" + self._esc(narration) + "</NARRATION>") if narration else ""

        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="Physical Stock" ACTION="Create">'
            "<DATE>" + self._esc(date) + "</DATE>"
            "<VOUCHERTYPENAME>Physical Stock</VOUCHERTYPENAME>"
            "<VOUCHERNUMBER>" + self._esc(voucher_no) + "</VOUCHERNUMBER>"
            + narration_e + lines +
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    # ── Shared item-voucher builder (Quotation / Sales Order / Purchase Order /
    #    Delivery Note / Receipt Note) ──────────────────────────────────────
    #
    # These five differ from the plain Sales/Purchase builder above in that they
    # DO carry item lines (a quotation without line items is useless to read),
    # and from each other only in their Tally VOUCHER TYPE NAME and whether they
    # are OPTIONAL. The type name is NEVER hard-coded here -- Tally ships none
    # of "Quotation" out of the box (someone creates it per company) and Sales/
    # Purchase Order only exist once order processing is switched on, so the
    # caller (sync_agent, from the row's own tally_voucher_type) decides the
    # name every time.
    def create_item_voucher_xml(
        self,
        vtype: str,
        party: str,
        date: str,
        items: list[dict[str, Any]],
        company: Optional[str] = None,
        voucher_no: Optional[str] = None,
        is_optional: bool = False,
        extra_date: Optional[str] = None,
        extra_date_tag: Optional[str] = None,
        narration: Optional[str] = None,
    ) -> str:
        """IMPORT: build any item-carrying voucher -- Quotation, Sales/Purchase
        Order, Delivery/Receipt Note.

        ``items`` is ``[{"item": str, "qty": float, "rate": float}, ...]``. A
        line missing an item name or a positive quantity is dropped rather than
        sent half-formed; if NOTHING usable remains, the whole voucher is
        refused (:class:`ValueError`) -- never built and sent empty.

        ``is_optional`` sets ``ISOPTIONAL`` -- the flag that keeps a Quotation
        or Order out of the company's real books while still letting Tally
        record it. ``extra_date``/``extra_date_tag`` cover the second date some
        of these carry (a Sales Order's due date, a Delivery Note's dispatch
        date) and are omitted entirely when not given, matching every other
        optional block in this file.
        """
        lines_xml = ""
        for it in (items or []):
            name = str((it or {}).get("item") or "").strip()
            try:
                qty = float((it or {}).get("qty") or 0)
            except (TypeError, ValueError):
                qty = 0.0
            if not name or qty <= 0:
                continue
            try:
                rate = float((it or {}).get("rate") or 0)
            except (TypeError, ValueError):
                rate = 0.0
            qty_s = "%s Nos" % ("%.2f" % qty).rstrip("0").rstrip(".")
            amount = qty * rate
            lines_xml += (
                "<ALLINVENTORYENTRIES.LIST>"
                "<STOCKITEMNAME>" + self._esc(name) + "</STOCKITEMNAME>"
                "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>"
                "<ACTUALQTY>" + qty_s + "</ACTUALQTY>"
                "<BILLEDQTY>" + qty_s + "</BILLEDQTY>"
                "<RATE>" + ("%.2f" % rate) + "</RATE>"
                "<AMOUNT>" + ("%.2f" % amount) + "</AMOUNT>"
                "</ALLINVENTORYENTRIES.LIST>"
            )
        if not lines_xml:
            raise ValueError(
                vtype + ": no usable item line (name + positive quantity), "
                "refusing to build an empty voucher")

        voucher_no_e = ("<VOUCHERNUMBER>" + self._esc(voucher_no) + "</VOUCHERNUMBER>"
                        if voucher_no else "")
        optional_e = "<ISOPTIONAL>Yes</ISOPTIONAL>" if is_optional else ""
        narration_e = ("<NARRATION>" + self._esc(narration) + "</NARRATION>") if narration else ""
        extra_date_e = ""
        if extra_date and extra_date_tag:
            extra_date_e = ("<" + extra_date_tag + ">" + self._esc(extra_date)
                            + "</" + extra_date_tag + ">")

        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + self._esc(vtype) + '" ACTION="Create">'
            "<DATE>" + self._esc(date) + "</DATE>"
            "<VOUCHERTYPENAME>" + self._esc(vtype) + "</VOUCHERTYPENAME>"
            + voucher_no_e + optional_e +
            "<PARTYLEDGERNAME>" + self._esc(party) + "</PARTYLEDGERNAME>"
            + extra_date_e + narration_e + lines_xml +
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_item_voucher(
        self,
        vtype: str,
        party: str,
        date: str,
        items: list[dict[str, Any]],
        company: Optional[str] = None,
        voucher_no: Optional[str] = None,
        is_optional: bool = False,
        extra_date: Optional[str] = None,
        extra_date_tag: Optional[str] = None,
        narration: Optional[str] = None,
    ) -> str:
        """Build AND send an item voucher (Quotation/Order/Delivery/Receipt Note);
        returns Tally's raw response."""
        return self.send(self.create_item_voucher_xml(
            vtype, party, date, items, company=company, voucher_no=voucher_no,
            is_optional=is_optional, extra_date=extra_date,
            extra_date_tag=extra_date_tag, narration=narration))

    def _settlement_voucher_xml(
        self,
        vtype: str,
        party: str,
        date: str,
        amount: float,
        mode: str,
        party_is_debit: bool,
        company: Optional[str] = None,
    ) -> str:
        """Shared builder for Receipt/Payment vouchers.

        Receipt: money comes IN  -> cash/bank ledger debited, party credited.
        Payment: money goes OUT -> party debited, cash/bank ledger credited.
        ``mode`` is the cash/bank ledger name (e.g. "Cash", "HDFC Bank"). Pass
        ``company`` to import the voucher into that specific loaded company.
        """
        party_e = self._esc(party)
        mode_e = self._esc(mode)
        date_e = self._esc(date)
        amt = float(amount or 0)

        # In Tally, debit amounts are negative, credit amounts positive.
        if party_is_debit:  # Payment
            party_amt, mode_amt = -amt, amt
            party_pos, mode_pos = "Yes", "No"
        else:  # Receipt
            party_amt, mode_amt = amt, -amt
            party_pos, mode_pos = "No", "Yes"

        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + self._esc(vtype) + '" ACTION="Create">'
            "<DATE>" + date_e + "</DATE>"
            "<VOUCHERTYPENAME>" + self._esc(vtype) + "</VOUCHERTYPENAME>"
            "<PARTYLEDGERNAME>" + party_e + "</PARTYLEDGERNAME>"
            # First ledger line = the cash/bank side, second = the party side.
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + mode_e + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + mode_pos + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + self._esc(mode_amt) + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + party_e + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + party_pos + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + self._esc(party_amt) + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_receipt_xml(self, party: str, date: str, amount: float, mode: str = "Cash",
                           company: Optional[str] = None) -> str:
        """IMPORT: create a Receipt voucher (cash/bank debit, party credit)."""
        return self._settlement_voucher_xml("Receipt", party, date, amount, mode,
                                            party_is_debit=False, company=company)

    def create_payment_xml(self, party: str, date: str, amount: float, mode: str = "Cash",
                           company: Optional[str] = None) -> str:
        """IMPORT: create a Payment voucher (party debit, cash/bank credit)."""
        return self._settlement_voucher_xml("Payment", party, date, amount, mode,
                                            party_is_debit=True, company=company)

    def create_journal_xml(self, dr_ledger: str, cr_ledger: str, date: str,
                           amount: float, narration: str = "", vch_type: str = "Journal",
                           company: Optional[str] = None) -> str:
        """IMPORT: create a two-ledger voucher — Debit one ledger, Credit another.

        `vch_type` is the Tally voucher type: Journal | Contra | Credit Note |
        Debit Note (all share the Dr/Cr shape). Tally convention: the debited
        ledger carries a NEGATIVE amount + ISDEEMEDPOSITIVE=Yes; the credited
        ledger a POSITIVE amount + ISDEEMEDPOSITIVE=No. Pass ``company`` to import
        the voucher into that specific loaded company.
        """
        amt = f"{float(amount):.2f}"
        date_e = self._esc(date)
        vt = self._esc(vch_type or "Journal")
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + vt + '" ACTION="Create">'
            "<DATE>" + date_e + "</DATE>"
            "<EFFECTIVEDATE>" + date_e + "</EFFECTIVEDATE>"
            "<VOUCHERTYPENAME>" + vt + "</VOUCHERTYPENAME>"
            "<NARRATION>" + self._esc(narration or "") + "</NARRATION>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + self._esc(dr_ledger) + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>"
            "<AMOUNT>-" + amt + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + self._esc(cr_ledger) + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + amt + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_journal(self, dr_ledger: str, cr_ledger: str, date: str,
                       amount: float, narration: str = "", vch_type: str = "Journal",
                       company: Optional[str] = None) -> str:
        """Create a two-ledger voucher (Journal/Contra/Credit Note/Debit Note).

        Pass ``company`` to import the voucher into that specific loaded company.
        """
        return self.send(self.create_journal_xml(dr_ledger, cr_ledger, date, amount,
                                                  narration, vch_type, company))

    @staticmethod
    def _default_fy_start() -> str:
        """Tally YYYYMMDD for the start of the current Indian financial year.

        Indian FY starts 1 April; before April we are still in the FY that began
        on 1 April of the PREVIOUS calendar year. Computed with the stdlib only.
        """
        import datetime
        today = datetime.date.today()
        year = today.year if today.month >= 4 else today.year - 1
        return "%04d0401" % year

    def create_company_xml(
        self,
        name: str,
        books_from: Optional[str] = None,
        fy_from: Optional[str] = None,
        mailing_name: Optional[str] = None,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        mobile: Optional[str] = None,
        gst: Optional[str] = None,
        pan: Optional[str] = None,
        state: Optional[str] = None,
        pincode: Optional[str] = None,
        country: Optional[str] = None,
        address: Optional[str] = None,
        action: str = "Create",
    ) -> str:
        """IMPORT: create OR alter a COMPANY master in Tally with the FULL record.

        Tags inside <COMPANY>: <NAME> <MAILINGNAME> <STARTINGFROM> <BOOKSFROM>
        <ISACCOUNTSONLY> <EMAIL> <PHONENUMBER> <MOBILENUMBERS> <STATENAME>
        <PINCODE> <COUNTRYNAME> <CMPGSTIN> <INCOMETAXNUMBER> + <ADDRESS.LIST>.

        NOTE: Company-creation XML varies across Tally releases; this uses the
        common "All Masters" import shape and may need field tweaks on a live Tally.
        """
        name_e = self._esc(name)
        start = self._esc(fy_from or self._default_fy_start())
        books = self._esc(books_from or fy_from or self._default_fy_start())

        def _tag(tag: str, val: Any) -> str:
            return ("<" + tag + ">" + self._esc(val) + "</" + tag + ">") if (val not in (None, "")) else ""

        addr_block = ""
        if address:
            lines = [ln for ln in str(address).replace("\r", "").split("\n") if ln.strip()]
            if lines:
                addr_block = ("<ADDRESS.LIST TYPE=\"String\">"
                              + "".join("<ADDRESS>" + self._esc(ln) + "</ADDRESS>" for ln in lines)
                              + "</ADDRESS.LIST>")
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<COMPANY NAME="' + name_e + '" ACTION="' + (action or "Create") + '">'
            "<NAME>" + name_e + "</NAME>"
            + _tag("MAILINGNAME", mailing_name) +
            "<STARTINGFROM>" + start + "</STARTINGFROM>"
            "<BOOKSFROM>" + books + "</BOOKSFROM>"
            "<ISACCOUNTSONLY>No</ISACCOUNTSONLY>"
            + _tag("EMAIL", email)
            + _tag("PHONENUMBER", phone)
            + _tag("MOBILENUMBERS", mobile)
            + _tag("STATENAME", state)
            + _tag("PINCODE", pincode)
            + _tag("COUNTRYNAME", country)
            + _tag("CMPGSTIN", gst)
            + _tag("INCOMETAXNUMBER", pan)
            + addr_block +
            "</COMPANY>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    # ------------------------------------------------------------------ #
    # XML parsing helpers (best-effort, tolerant of Tally quirks)
    # ------------------------------------------------------------------ #
    @staticmethod
    def _localname(tag: str) -> str:
        """Strip any XML namespace prefix from an element tag."""
        if "}" in tag:
            return tag.split("}", 1)[1]
        return tag

    @staticmethod
    def _sanitize(xml: str) -> str:
        """Remove illegal control chars Tally sometimes emits (e.g. &#4;)."""
        # Strip raw control chars (except tab/newline/CR) and bad entities.
        xml = re.sub(r"&#(?:[0-8]|1[12]|1[4-9]|2[0-9]|3[01]);", "", xml)
        xml = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", xml)
        return xml

    def _safe_parse(self, xml: str) -> Optional[ET.Element]:
        """Parse Tally XML defensively; return the root or ``None`` on failure."""
        if not xml:
            return None
        clean = self._sanitize(xml)
        try:
            return ET.fromstring(clean)
        except ET.ParseError as exc:
            # Tally VOUCHER XML carries UDF / custom fields with namespace
            # PREFIXES (e.g. <UDF:SomeField>) that are NEVER declared, so
            # ElementTree raises "unbound prefix" and the whole voucher pull
            # parses to nothing. Strip the prefixes from tags + drop the (unused)
            # xmlns:*/prefixed attrs, then retry. The fields we read
            # (DATE/VOUCHERTYPENAME/VOUCHERNUMBER/PARTYLEDGERNAME/AMOUNT/ALTERID/
            # GUID) are unprefixed, so stripping is lossless for our purposes.
            try:
                return ET.fromstring(self._strip_ns_prefixes(clean))
            except ET.ParseError as exc2:
                self.log.warning("Tally XML parse failed: %s", exc2)
                return None

    @staticmethod
    def _strip_ns_prefixes(xml: str) -> str:
        """Remove undeclared namespace prefixes so ElementTree stops choking on
        Tally's UDF voucher fields. <UDF:Tag>..</UDF:Tag> -> <Tag>..</Tag>; drops
        xmlns:* declarations and any prefixed attributes."""
        # Tag prefixes: <UDF:Tag ...> and </UDF:Tag>.
        xml = re.sub(r"(</?)[A-Za-z_][\w.\-]*:", r"\1", xml)
        # xmlns:prefix="..." declarations (now unused).
        xml = re.sub(r'\s+xmlns:[\w.\-]+\s*=\s*"[^"]*"', "", xml)
        # Prefixed attributes: foo:bar="...".
        xml = re.sub(r'\s+[A-Za-z_][\w.\-]*:[\w.\-]+\s*=\s*"[^"]*"', "", xml)
        return xml

    def _child_text(self, el: ET.Element, child_localname: str) -> str:
        """Return the trimmed text of the first matching child, namespace-agnostic."""
        target = child_localname.upper()
        for child in el.iter():
            if self._localname(child.tag).upper() == target and (child.text or "").strip():
                return child.text.strip()
        return ""

    def _direct_child_text(self, el: ET.Element, child_localname: str) -> str:
        """Text of the first DIRECT child with this name (namespace-agnostic).

        Unlike :meth:`_child_text`, this does NOT descend. Identity tags must use
        it: a STOCKITEM carries nested BATCHALLOCATIONS / GSTDETAILS lists whose
        own GUID/MASTERID children a deep search would happily return instead of
        the item's, silently giving two masters the same identity.
        """
        target = child_localname.upper()
        for child in list(el):
            if self._localname(child.tag).upper() == target and (child.text or "").strip():
                return child.text.strip()
        return ""

    def _guid(self, el: ET.Element) -> Optional[str]:
        """Tally GUID for an object -> str, or None when absent.

        The GUID is Tally's globally-unique, RENAME-STABLE master identity
        ("<company-guid>-<seq>"); the cloud upserts on it so renaming a ledger in
        Tally updates the existing row instead of creating a duplicate. Like
        ALTERID it arrives as either an attribute or a direct child.
        """
        raw = (el.get("GUID") or el.get("Guid") or "").strip() \
            or self._direct_child_text(el, "GUID")
        return raw or None

    def _masterid(self, el: ET.Element) -> int:
        """Tally MASTERID for an object -> int (0 if absent/unparsable).

        MASTERID is the company-local numeric id. It is what a reconcile pass
        compares against: fetching just MASTERID for every master is cheap, and
        any id the cloud holds that Tally no longer lists has been DELETED.
        """
        raw = el.get("MASTERID") or el.get("MasterId") or ""
        if not raw:
            raw = self._direct_child_text(el, "MASTERID")
        raw = re.sub(r"[^0-9\-]", "", str(raw or ""))
        try:
            return int(raw) if raw not in ("", "-") else 0
        except ValueError:
            return 0

    def _alterid(self, el: ET.Element) -> int:
        """Extract a Tally ALTERID for an element -> int (0 if absent/unparsable).

        Tally exposes ALTERID either as an ATTRIBUTE on the object element
        (<LEDGER ALTERID="42" ...>) or as a CHILD tag (<ALTERID>42</ALTERID>),
        depending on the build/collection. Try the attribute first, then the
        child; tolerate junk by stripping to digits and defaulting to 0.
        """
        raw = el.get("ALTERID") or el.get("AlterId") or el.get("Alterid") or ""
        if not raw:
            raw = self._child_text(el, "ALTERID")
        raw = re.sub(r"[^0-9\-]", "", str(raw or ""))
        try:
            return int(raw) if raw not in ("", "-") else 0
        except ValueError:
            return 0
