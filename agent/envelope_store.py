"""Server-published Tally envelopes: verified, cached, and never trusted blindly.

WHAT THIS BUYS
--------------
Tally queries used to be compiled into the exe, so adding a report meant a
release, a signature and every customer downloading 23 MB. Fetching them from
the server means a new report is a server-side change.

WHAT IT COSTS, AND HOW THAT IS PAID
-----------------------------------
It also means the server can tell this agent what XML to send to the customer's
Tally — and Tally's XML API writes as well as reads. Untreated, that is a remote
command channel into every customer's books. Three rules make it safe enough to
use, and they are enforced HERE rather than at the call site, because a call
site that forgets one is indistinguishable from one that does not:

  1. VERIFY THE SIGNATURE. The signing key does not live on the web tier, so a
     compromised server cannot mint envelopes. Anything that fails verification
     is discarded, not "used with a warning".

  2. REFUSE ANYTHING THAT WRITES. Independent of the signature, so it still
     holds if the key ever leaks. The pull path has no business importing,
     altering, cancelling or deleting, so an envelope that could is dropped even
     when it is perfectly signed.

  3. FALL BACK TO THE LAST VERIFIED SET. Cached on disk after verification. A
     server that is down, slow or lying leaves the agent syncing with
     yesterday's queries instead of stopping — or, far worse, accepting
     whatever arrived.

The net effect: the worst a fully compromised server can do to a customer's
Tally through this channel is stop new queries reaching it.

The cache is signed data plus its signature, re-verified on load. A cache file
edited on disk is refused exactly like a bad download, so local tampering does
not become the soft underbelly of the whole scheme.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from typing import Any, Optional

SIG_VERSION = "v1"
ALG = "hmac-sha256"

# Mirrors api/Helpers/envelopeSigning.js FORBIDDEN. Duplicated on purpose: this
# check has to hold on a machine that never talks to a trustworthy server, so it
# cannot be something the server tells the agent.
_FORBIDDEN = (
    re.compile(r"<TALLYREQUEST>\s*IMPORT\s*</TALLYREQUEST>", re.I),
    re.compile(r"<TALLYREQUEST>\s*(ALTER|CREATE|DELETE)\b", re.I),
    re.compile(r"<IMPORTDATA\b", re.I),
    re.compile(r"<REQUESTDATA\b", re.I),
    re.compile(r"""\bACTION\s*=\s*["'](Create|Alter|Delete|Cancel)["']""", re.I),
    re.compile(r"""\bISMODIFY\s*=\s*["']Yes["']""", re.I),
    re.compile(r"""\bISDELETE\s*=\s*["']Yes["']""", re.I),
)


class EnvelopeError(Exception):
    """An envelope set could not be trusted."""


def _stable(value: Any) -> str:
    """JSON with sorted keys and no incidental whitespace.

    Must match stableStringify in the signer byte for byte, or nothing verifies.
    ``separators`` removes the spaces json.dumps adds by default; ``sort_keys``
    makes two structurally identical payloads produce one signature.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def canonical(payload: dict) -> str:
    """The exact bytes that were signed."""
    return f"{SIG_VERSION}\n{_stable(payload)}"


def verify_signature(payload: dict, signature: str, secret: str,
                     alg: str = ALG) -> bool:
    """True only for an exact match. Never raises — a caller that catches an
    exception and shrugs is the bug this avoids."""
    if not secret or not signature:
        return False
    # The verifier chooses the algorithm; letting the input choose is the
    # JWT alg:none hole.
    if alg != ALG:
        return False
    expected = hmac.new(secret.encode("utf-8"), canonical(payload).encode("utf-8"),
                        hashlib.sha256).digest()
    import base64
    want = base64.b64encode(expected).decode("ascii")
    return hmac.compare_digest(str(signature), want)


def is_read_only(xml: str) -> bool:
    """Whether an envelope only READS from Tally."""
    text = str(xml or "")
    if not text.strip():
        return False
    return not any(pattern.search(text) for pattern in _FORBIDDEN)


def validate_set(doc: dict, secret: str) -> dict:
    """Verify a downloaded set and return its envelopes.

    Raises :class:`EnvelopeError` with a specific reason — the reasons differ in
    how alarming they are ("no signature" is a misconfiguration; "envelope can
    modify Tally" is an incident) and the log needs to tell them apart.
    """
    if not isinstance(doc, dict):
        raise EnvelopeError("envelope set is not an object")

    signature = doc.get("signature")
    alg = doc.get("alg") or ALG
    if not signature:
        raise EnvelopeError("envelope set is not signed")

    # The signature is not part of what was signed.
    payload = {k: v for k, v in doc.items()
               if k not in ("signature", "alg", "version")}
    if not verify_signature(payload, signature, secret, alg):
        raise EnvelopeError("envelope signature does not verify")

    envelopes = payload.get("envelopes")
    if not isinstance(envelopes, dict) or not envelopes:
        raise EnvelopeError("envelope set is empty")

    # Checked AFTER the signature but enforced regardless of it: this is the
    # control that survives a leaked key.
    for name, definition in envelopes.items():
        xml = (definition or {}).get("xml") if isinstance(definition, dict) else None
        if not is_read_only(xml):
            raise EnvelopeError(f"envelope {name!r} can modify Tally")

    return payload


class EnvelopeStore:
    """Holds the current envelope set and the last verified one on disk."""

    def __init__(self, cache_path: str, secret: str, logger=None) -> None:
        self.cache_path = cache_path
        self.secret = secret
        self.log = logger
        self._payload: Optional[dict] = None

    # -- loading ---------------------------------------------------------- #
    def load_cached(self) -> Optional[dict]:
        """The last VERIFIED set, re-verified on the way in.

        Re-verifying matters: without it the cache file is an unsigned input
        that anyone with write access to the install folder could edit, which
        would make local tampering easier than attacking the server.
        """
        try:
            with open(self.cache_path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            return None
        try:
            payload = validate_set(doc, self.secret)
        except EnvelopeError as exc:
            if self.log:
                self.log.warning("Cached envelopes rejected (%s); ignoring them.", exc)
            return None
        self._payload = payload
        return payload

    def accept(self, doc: dict) -> dict:
        """Verify a freshly downloaded set, adopt it and cache it.

        The cache is only written AFTER verification, so a rejected download can
        never overwrite a good cache — which is what would turn a single bad
        response into a permanently broken agent.
        """
        payload = validate_set(doc, self.secret)
        self._payload = payload
        try:
            os.makedirs(os.path.dirname(self.cache_path) or ".", exist_ok=True)
            tmp = self.cache_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
            # Atomic replace: a crash mid-write must not leave a truncated file
            # that fails to parse on the next start.
            os.replace(tmp, self.cache_path)
        except OSError as exc:
            # A cache we could not write is a slower next start, not a failure.
            if self.log:
                self.log.warning("Could not cache envelopes: %s", exc)
        return payload

    def refresh(self, fetcher) -> dict:
        """Fetch, verify and adopt — falling back to the cache on any problem.

        ``fetcher`` returns the raw document. Anything it raises, and anything
        that fails verification, is logged and answered with the last verified
        set. The agent keeps syncing with yesterday's queries; it does not stop,
        and it does not run today's unverified ones.
        """
        try:
            return self.accept(fetcher())
        except EnvelopeError as exc:
            if self.log:
                # Distinct message: this one means someone served us something
                # they should not have.
                self.log.error("REJECTED envelopes from the server: %s", exc)
        except Exception as exc:            # noqa: BLE001 - transport, timeouts
            if self.log:
                self.log.warning("Could not fetch envelopes (%s).", exc)
        cached = self._payload or self.load_cached()
        if cached is None:
            raise EnvelopeError("no verified envelopes available")
        if self.log:
            self.log.info("Using the last verified envelope set.")
        return cached

    # -- reading ---------------------------------------------------------- #
    def xml(self, name: str) -> str:
        """One envelope's XML.

        Re-checked at the point of use as well as at load. The cost is a regex
        on a string we already hold; the benefit is that no future code path can
        reach an unchecked envelope by loading a set some other way.
        """
        payload = self._payload or self.load_cached()
        if not payload:
            raise EnvelopeError("no verified envelopes available")
        definition = (payload.get("envelopes") or {}).get(name)
        if not isinstance(definition, dict):
            raise EnvelopeError(f"unknown envelope {name!r}")
        text = definition.get("xml") or ""
        if not is_read_only(text):
            raise EnvelopeError(f"envelope {name!r} can modify Tally")
        return text

    def names(self) -> list[str]:
        payload = self._payload or self.load_cached() or {}
        return sorted((payload.get("envelopes") or {}).keys())
