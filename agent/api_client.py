"""Cloud API client for the Tally Sync Agent.

Wraps the small set of cloud HTTP endpoints the agent talks to
(`/agent/activate`, `/agent/heartbeat`). The cloud uses an *envelope*
convention: the HTTP status is always 200, while the real result code
lives in ``body['status']`` (200 = success), the payload in
``body['data']`` and a user-facing message in ``body['msg']``.

Every external call is wrapped: transport problems and non-200 envelope
codes are turned into the module's own exceptions (:class:`ActivationError`,
:class:`AgentError`) so the main loop can log + retry without crashing.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from typing import Any, Optional

import requests


class ActivationError(Exception):
    """Raised when activation fails (bad key, machine mismatch, transport)."""


class AgentError(Exception):
    """Raised when a normal agent call (e.g. heartbeat) fails."""


# Network tuning.
TIMEOUT = 15          # seconds, per request
RETRIES = 1           # one extra attempt on transport errors
BACKOFF = 1.5         # seconds between attempts
# Sign-in / verify / resend: someone is watching the button. Eight seconds is
# already longer than anyone waits before deciding an app is broken, and the
# server answers these in well under a second when it is there at all.
AUTH_TIMEOUT = 8


class ApiClient:
    """Thin HTTP client around the cloud agent endpoints.

    Parameters
    ----------
    api_url:
        Base URL that already includes the ``/api/v1`` prefix, e.g.
        ``http://localhost:4500/api/v1``. Trailing slash is tolerated.
    logger:
        A :class:`logging.Logger` (from ``logger.get_logger``) used to
        record every call and failure.
    """

    def __init__(self, api_url: str, logger: logging.Logger) -> None:
        self.api_url = api_url.rstrip("/")
        self.log = logger
        self._session = requests.Session()

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #
    def _url(self, path: str) -> str:
        """Join the base api_url with an endpoint path."""
        return f"{self.api_url}/{path.lstrip('/')}"

    def _post(
        self,
        path: str,
        *,
        json: dict[str, Any],
        headers: Optional[dict[str, str]] = None,
        timeout: Optional[int] = None,
        retries: Optional[int] = None,
    ) -> requests.Response:
        """POST with a short retry/backoff on transport-level errors.

        ``timeout`` overrides the default per-request TIMEOUT — the master/voucher
        IMPORT processes large batches (double-entry storage), so it needs a much
        longer read window than a heartbeat.

        ``retries`` overrides RETRIES. Retrying is right for the BACKGROUND sync
        (nobody is waiting; a blip should not become a failed cycle) and wrong
        for anything a person just clicked: there, the retry is a second silent
        wait on top of the first, and pressing the button again is both faster
        and something the customer chooses.

        Returns the :class:`requests.Response` (whatever HTTP status it
        carries). Raises :class:`requests.RequestException` only after the
        retries are exhausted, so callers can map it to a domain error.
        """
        url = self._url(path)
        last_exc: Optional[Exception] = None
        attempts = RETRIES if retries is None else retries
        for attempt in range(attempts + 1):
            try:
                resp = self._session.post(
                    url, json=json, headers=headers, timeout=(timeout or TIMEOUT)
                )
                return resp
            except requests.RequestException as exc:
                last_exc = exc
                self.log.warning(
                    "POST %s failed (attempt %d/%d): %s",
                    url,
                    attempt + 1,
                    attempts + 1,
                    exc,
                )
                if attempt < attempts:
                    time.sleep(BACKOFF)
        # Exhausted retries.
        assert last_exc is not None
        raise last_exc

    def _get(
        self,
        path: str,
        *,
        headers: Optional[dict[str, str]] = None,
    ) -> requests.Response:
        """GET with the same short retry/backoff as :meth:`_post`."""
        url = self._url(path)
        last_exc: Optional[Exception] = None
        for attempt in range(RETRIES + 1):
            try:
                return self._session.get(url, headers=headers, timeout=TIMEOUT)
            except requests.RequestException as exc:
                last_exc = exc
                self.log.warning("GET %s failed (attempt %d/%d): %s", url, attempt + 1, RETRIES + 1, exc)
                if attempt < RETRIES:
                    time.sleep(BACKOFF)
        assert last_exc is not None
        raise last_exc

    @staticmethod
    def _envelope(resp: requests.Response) -> dict[str, Any]:
        """Decode the JSON envelope body, tolerating non-JSON responses."""
        try:
            body = resp.json()
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        return body

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #
    def login(
        self,
        email: str,
        password: str,
        machine_id: str,
        machine_name: str = "",
        agent_version: str = "",
    ) -> dict[str, Any]:
        """Step 1 of sign-in: check the password and have a code emailed.

        POSTs to ``{api_url}/agent/login``. Returns ``{challenge_id,
        email_masked, expires_in}``.

        NOTHING IS VALIDATED HERE. Not the email shape, not the password
        length. The server owns every rule (Validators/agent.js) and this sends
        what the customer typed, so the rules and their wording can change
        without shipping a new exe. The only failure this code decides for
        itself is "could not reach the server" - there is no server to ask.

        Raises
        ------
        ActivationError
            On transport failure or any non-200 envelope. The message is the
            server's, verbatim, because the UI shows it verbatim.
        """
        self.log.info("Agent sign-in for %s (machine_id=%s)", email, machine_id)
        payload = {
            "email": email,
            "password": password,
            "machine_id": machine_id,
            "machine_name": machine_name or "",
            "agent_version": agent_version or "",
        }
        return self._auth_post("agent/login", payload, "Sign-in failed.")

    def verify_otp(
        self,
        challenge_id: str,
        code: str,
        machine_id: str,
        machine_name: str = "",
        agent_version: str = "",
    ) -> dict[str, Any]:
        """Step 2: exchange the emailed code for the agent token.

        Returns ``{agent_token, agent_id, license, companies}``.

        ``machine_id`` is sent again and the server checks it against the one
        the challenge was created with, so a code obtained on one computer
        cannot be redeemed on another.
        """
        payload = {
            "challenge_id": challenge_id,
            "code": code,
            "machine_id": machine_id,
            "machine_name": machine_name or "",
            "agent_version": agent_version or "",
        }
        data = self._auth_post("agent/verify", payload, "Could not verify the code.")
        self.log.info("Agent verified (agent_id=%s).", data.get("agent_id"))
        return data

    def resend_otp(self, challenge_id: str) -> dict[str, Any]:
        """Ask for a fresh code on an existing challenge.

        The server enforces the cooldown and the per-challenge cap; the UI only
        displays the countdown it is told about.
        """
        return self._auth_post("agent/otp/resend", {"challenge_id": challenge_id},
                               "Could not send a new code.")

    def _auth_post(self, path: str, payload: dict[str, Any],
                   fallback_msg: str) -> dict[str, Any]:
        """POST an unauthenticated sign-in call and unwrap the envelope.

        Shared by the three sign-in endpoints because their error handling is
        identical: surface the server's message when there is one, and a plain
        connectivity message when there is not.
        """
        try:
            # A PERSON is watching a spinner for this one, so it fails fast: a
            # short read window and no silent retry. An unreachable server used
            # to cost 3 seconds on a refused connection and half a minute on a
            # network that drops packets, with nothing on screen but "Signing
            # in..." — long enough that the app looked broken rather than
            # offline. Pressing the button again is the retry.
            resp = self._post(path, json=payload, timeout=AUTH_TIMEOUT, retries=0)
        except requests.RequestException as exc:
            self.log.error("%s transport error: %s", path, exc)
            # Deliberately NOT the server's wording - there was no server.
            raise ActivationError(
                "Cannot reach the server. Check the internet connection."
            ) from exc

        body = self._envelope(resp)
        status = body.get("status")
        if status != 200:
            msg = body.get("msg") or fallback_msg
            self.log.warning("%s rejected (status=%s): %s", path, status, msg)
            # A 4xx/5xx that is ABOUT THE SERVER, not about what was typed. The
            # server's own wording for these is written for whoever is running
            # it — "Route not found" told a customer their email was wrong when
            # the truth was that the API had not been deployed yet. Anything the
            # customer can act on (bad password, expired licence, wrong code)
            # still comes through verbatim, which is the whole point of keeping
            # validation server-side.
            if status in (404, 405, 500, 502, 503, 504):
                raise ActivationError(
                    "The server is not responding correctly. "
                    "Please try again shortly, or contact support."
                )
            raise ActivationError(msg)
        return body.get("data") or {}


    def get_envelopes(self, agent_token: str) -> dict[str, Any]:
        """The SIGNED Tally envelope set this agent should use.

        GETs ``{api_url}/agent/envelopes``. Returns the raw document — signature
        and all — WITHOUT interpreting it. Verification belongs to
        :mod:`envelope_store`, which is also what decides whether to fall back
        to the last verified set. Splitting those apart would make it possible
        to fetch here and forget to verify there.

        Raises :class:`AgentError` on transport failure or a non-200 envelope so
        the store treats it as "no fresh set" and keeps using the cache.
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        try:
            resp = self._get("agent/envelopes", headers=headers)
        except requests.RequestException as exc:
            raise AgentError("Cannot reach the cloud server.") from exc
        body = self._envelope(resp)
        if body.get("status") != 200:
            raise AgentError(body.get("msg", "Could not fetch envelopes."))
        return body.get("data") or {}

    def heartbeat(
        self,
        agent_token: str,
        agent_version: str,
        open_companies: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Send a heartbeat so the cloud knows the agent is alive.

        POSTs ``{agent_version}`` to ``{api_url}/agent/heartbeat`` with the
        ``Authorization: Bearer <agent_token>`` header. When ``open_companies``
        is provided (the names of the companies currently open in Tally), it is
        included as ``{open_companies: [...]}`` so the cloud can record + display
        what is currently open. ``None`` omits the field (leaves the last value).

        Returns the ``data`` part of the envelope, which holds ``status``
        (``'active'`` / ``'suspended'``) and related fields.

        Raises
        ------
        AgentError
            On any transport failure or when ``body['status'] != 200``.
        """
        self.log.debug("Sending heartbeat (v=%s)", agent_version)
        headers = {"Authorization": f"Bearer {agent_token}"}
        payload: dict[str, Any] = {"agent_version": agent_version}
        if open_companies is not None:
            payload["open_companies"] = open_companies
        try:
            resp = self._post("agent/heartbeat", json=payload, headers=headers)
        except requests.RequestException as exc:
            self.log.error("Heartbeat transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        status = body.get("status")
        if status != 200:
            msg = body.get("msg", "Heartbeat failed.")
            self.log.error("Heartbeat rejected (status=%s): %s", status, msg)
            raise AgentError(msg)

        data = body.get("data") or {}
        self.log.debug("Heartbeat ok (status=%s)", data.get("status"))
        return data

    def go_offline(self, agent_token: str) -> bool:
        """Tell the cloud the agent is stopping ON PURPOSE (graceful shutdown).

        POSTs to ``{api_url}/agent/offline`` with the
        ``Authorization: Bearer <agent_token>`` header so the cloud clears
        ``licenses.last_seen_at`` and the dashboard flips to Disconnected
        IMMEDIATELY (instead of waiting out the ~150s connected window).

        BEST-EFFORT / NON-BLOCKING: a SHORT timeout is used and ANY failure
        (transport / non-200 / odd body) is swallowed and turned into ``False``.
        This NEVER raises — a graceful stop / uninstall must never hang or fail
        because the cloud is unreachable. Returns ``True`` only when the cloud
        accepted it (200 envelope).
        """
        if not agent_token:
            return False
        headers = {"Authorization": f"Bearer {agent_token}"}
        url = self._url("agent/offline")
        try:
            # A short, single-shot request (no retry/backoff): shutdown must be
            # prompt, so we do not block on an unreachable cloud.
            resp = self._session.post(url, json={}, headers=headers, timeout=5)
        except requests.RequestException as exc:
            self.log.debug("Go-offline transport error (ignored): %s", exc)
            return False
        except Exception as exc:  # never let shutdown signalling raise.
            self.log.debug("Go-offline unexpected error (ignored): %s", exc)
            return False

        body = self._envelope(resp)
        if body.get("status") != 200:
            self.log.debug(
                "Go-offline rejected (status=%s): %s",
                body.get("status"), body.get("msg", "?"),
            )
            return False
        self.log.info("Sent graceful go-offline to the cloud.")
        return True

    def get_pending(self, agent_token: str) -> dict[str, Any]:
        """Fetch everything still needing a push to Tally for this license.

        GETs ``{api_url}/agent/pending`` (Bearer agent_token). Returns the
        ``data`` dict with ``ledgers``, ``stock_items`` and ``vouchers`` lists.
        Raises :class:`AgentError` on transport / non-200.
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        try:
            resp = self._get("agent/pending", headers=headers)
        except requests.RequestException as exc:
            self.log.error("Pending fetch transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        if body.get("status") != 200:
            raise AgentError(body.get("msg", "Could not fetch pending records."))
        return body.get("data") or {}

    def report_results(self, agent_token: str, results: list[dict[str, Any]]) -> dict[str, Any]:
        """Report per-record sync outcomes back to the cloud.

        POSTs ``{results: [...]}`` to ``{api_url}/agent/result`` so the cloud
        marks each record synced/failed (and stops returning it from
        ``/pending``). Each result item:
            { record_type, record_id, company_id, status:'synced'|'failed',
              tally_guid?, tally_voucher_no?, message? }
        Raises :class:`AgentError` on transport / non-200.
        """
        if not results:
            return {"processed": 0}
        headers = {"Authorization": f"Bearer {agent_token}"}
        try:
            resp = self._post("agent/result", json={"results": results}, headers=headers)
        except requests.RequestException as exc:
            self.log.error("Result report transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        if body.get("status") != 200:
            raise AgentError(body.get("msg", "Could not report results."))
        return body.get("data") or {}

    def import_from_tally(
        self,
        agent_token: str,
        ledgers: list[dict[str, Any]],
        stock_items: list[dict[str, Any]],
        vouchers: list[dict[str, Any]] | None = None,
        godowns: list[dict[str, Any]] | None = None,
        groups: list[dict[str, Any]] | None = None,
        company_master: dict[str, Any] | None = None,
        *,
        company_name: str | None = None,
        company_id: int | None = None,
        financial_reports: dict[str, Any] | None = None,
        masters: dict[str, list[dict[str, Any]]] | None = None,
        financial_reports_by_year: dict[str, dict[str, Any]] | None = None,
        outstandings: dict[str, Any] | None = None,
        extra_reports: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Tally → Cloud: upload masters + vouchers read from one Tally company.

        POSTs ``{company_name|company_id, ledgers, stock_items, vouchers,
        godowns}`` to ``{api_url}/agent/import``. The cloud FINDS-OR-CREATES the
        company (by name, under this license) so a Tally company auto-creates its
        cloud company on first pull. ``godowns`` (default empty) become rows in
        the cloud locations table. Returns the import counts (incl.
        ``company_id`` and ``company_created``). Raises :class:`AgentError` on
        transport/non-200.
        """
        vouchers = vouchers or []
        godowns = godowns or []
        groups = groups or []
        if (not ledgers and not stock_items and not vouchers and not godowns
                and not groups and not financial_reports and not masters
                and not financial_reports_by_year and not outstandings):
            return {}
        headers = {"Authorization": f"Bearer {agent_token}"}
        payload: dict[str, Any] = {"ledgers": ledgers,
                                   "stock_items": stock_items, "vouchers": vouchers,
                                   "godowns": godowns, "groups": groups}
        if company_master:
            payload["company_master"] = company_master
        if company_name:
            payload["company_name"] = company_name
        if company_id:
            payload["company_id"] = company_id
        if financial_reports:
            payload["financial_reports"] = financial_reports
        # The registry-driven masters (units, cost centres, voucher types,
        # payroll, …) keyed by kind — the cloud routes each kind to its table
        # from its own matching registry, so neither side needs new code per
        # master. See agent/tally_schema.py and MASTER_TABLES in the controller.
        if masters:
            payload["masters"] = masters
        # Reports keyed by FY label ({'2026-27': {...}}). Stored per (company,
        # report_type, fy) so last year sits beside this year instead of
        # overwriting it — which is what an undated pull used to do.
        if financial_reports_by_year:
            payload["financial_reports_by_year"] = financial_reports_by_year
        # Tally's own bill-wise outstanding, kept as the independent check on the
        # cloud's derived ageing rather than replacing it.
        if outstandings:
            payload["outstandings"] = outstandings
        # SERVER-PUBLISHED reports this build has no parser for, as raw Tally
        # XML keyed by slug. The whole point is that the cloud, not the agent,
        # decides what a new report means — so this travels unparsed and a new
        # report needs no agent release. See TallyConnector.extra_reports.
        if extra_reports:
            payload["extra_reports"] = extra_reports
        # Field-diagnosable summary of EXACTLY what we're uploading (INFO so it
        # shows without DEBUG). If a pull fails, this proves whether masters were
        # even pulled (e.g. ledgers=0 -> wrong/empty Tally company) vs a cloud
        # rejection. stock_items may be a dict (stock_summary) — guard len().
        try:
            _stk = (len(stock_items.get("rows") or []) if isinstance(stock_items, dict)
                    else (len(stock_items) if hasattr(stock_items, "__len__") else 0))
            self.log.info(
                "Import -> cloud [%s]: ledgers=%d stock=%d vouchers=%d godowns=%d "
                "groups=%d reports=%d",
                company_name or company_id or "?", len(ledgers), _stk,
                len(vouchers), len(godowns), len(groups),
                len(financial_reports or {}),
            )
        except Exception:
            pass
        try:
            # IMPORT is heavy (master + voucher double-entry storage) — give the
            # cloud a long read window instead of the 15s default so big batches
            # don't time out mid-write.
            resp = self._post("agent/import", json=payload, headers=headers, timeout=180)
        except requests.RequestException as exc:
            self.log.error("Import transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        if body.get("status") != 200:
            # Log the FULL cloud response (HTTP + envelope status + the message),
            # so the REAL reason a pull was rejected is visible in the agent log
            # instead of just a generic raise. With the cloud's surfaced error
            # this reads e.g. "Import failed: column ... does not exist".
            try:
                self.log.error(
                    "Import REJECTED by cloud: http=%s status=%s msg=%s",
                    getattr(resp, "status_code", "?"),
                    body.get("status"), body.get("msg", "?"),
                )
            except Exception:
                pass
            raise AgentError(body.get("msg", "Could not import from Tally."))
        return body.get("data") or {}

    def reconcile(
        self,
        agent_token: str,
        kind: str,
        master_ids: list[int],
        guids: list[str],
        *,
        company_name: str | None = None,
        company_id: int | None = None,
    ) -> dict[str, Any]:
        """Tally → Cloud DELETE detection for one master kind.

        Sends the COMPLETE live identity list read from Tally; the cloud
        soft-deletes every Tally-sourced row of that kind whose identity is
        missing from it. ``complete: True`` is asserted here because this method
        is only ever called with a full, successful read — a partial list would
        make the cloud delete records that still exist.

        Returns ``{company_id, kind, deleted: {table: n}}``.
        """
        if not master_ids and not guids:
            # Never send an empty list: the cloud would (correctly) refuse it,
            # but not sending it at all saves a pointless round trip.
            return {}
        headers = {"Authorization": f"Bearer {agent_token}"}
        payload: dict[str, Any] = {
            "kind": kind,
            "master_ids": master_ids,
            "guids": guids,
            "complete": True,
        }
        if company_name:
            payload["company_name"] = company_name
        if company_id:
            payload["company_id"] = company_id
        try:
            resp = self._post("agent/reconcile", json=payload, headers=headers, timeout=120)
        except requests.RequestException as exc:
            self.log.error("Reconcile transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        if body.get("status") != 200:
            self.log.error("Reconcile REJECTED by cloud [%s]: %s", kind, body.get("msg", "?"))
            raise AgentError(body.get("msg", "Could not reconcile."))
        return body.get("data") or {}

    def voucher_diff(
        self,
        agent_token: str,
        voucher_type: str,
        ids: list[dict[str, Any]],
        *,
        complete: bool = False,
        company_name: str | None = None,
        company_id: int | None = None,
    ) -> dict[str, Any]:
        """Ask the cloud which vouchers of one type it is missing or stale on.

        ``ids`` is the live ``[{guid, alterid}]`` list read from Tally. The reply
        carries ``missing`` — the guids to fetch in full — and, when ``complete``
        is set (this list is the WHOLE type, not a page), the cloud also
        soft-deletes the vouchers it holds that Tally no longer lists.

        ``complete`` is passed explicitly rather than inferred: only the caller
        knows whether it swept the entire type or gave up part-way, and guessing
        wrong deletes real vouchers.
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        payload: dict[str, Any] = {
            "voucher_type": voucher_type,
            "ids": ids,
            "complete": bool(complete),
        }
        if company_name:
            payload["company_name"] = company_name
        if company_id:
            payload["company_id"] = company_id
        try:
            resp = self._post("agent/voucher-diff", json=payload, headers=headers, timeout=120)
        except requests.RequestException as exc:
            self.log.error("Voucher diff transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        if body.get("status") != 200:
            self.log.error("Voucher diff REJECTED [%s]: %s", voucher_type, body.get("msg", "?"))
            raise AgentError(body.get("msg", "Could not diff vouchers."))
        return body.get("data") or {}

    # ------------------------------------------------------------------ #
    # Cloud → agent command channel (open_company, ...)
    # ------------------------------------------------------------------ #
    def get_commands(self, agent_token: str) -> list[dict[str, Any]]:
        """Drain the queued cloud→agent commands for this license.

        GETs ``{api_url}/agent/commands`` (Bearer agent_token). The cloud flips
        the returned rows to ``running`` server-side, so each command is handed
        out once. Returns the ``commands`` list — each entry is
        ``{id, type, company_id, company_name, company_number}``.

        Best-effort: ANY failure (transport, non-200 envelope, odd body) is
        logged and turned into ``[]`` so a command-channel hiccup never disrupts
        the normal heartbeat/sync loop.
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        try:
            resp = self._get("agent/commands", headers=headers)
        except requests.RequestException as exc:
            self.log.warning("Get-commands transport error: %s", exc)
            return []

        body = self._envelope(resp)
        if body.get("status") != 200:
            self.log.warning(
                "Get-commands rejected (status=%s): %s",
                body.get("status"), body.get("msg", "?"),
            )
            return []
        data = body.get("data") or {}
        commands = data.get("commands")
        return commands if isinstance(commands, list) else []

    def command_result(
        self,
        agent_token: str,
        cmd_id: Any,
        status: str,
        result: Optional[str] = None,
        error: Optional[str] = None,
    ) -> bool:
        """Report a command's outcome back to the cloud.

        POSTs ``{status, result?, error?}`` to
        ``{api_url}/agent/commands/<id>/result`` (Bearer agent_token). ``status``
        is ``'done'`` or ``'failed'`` (the cloud coerces anything else to
        ``'failed'`` so a row never stays stuck in ``running``).

        Best-effort: returns ``True`` when the cloud accepted it (200 envelope),
        ``False`` on any transport/non-200 failure. Never raises — a missed
        result report must not kill the loop.
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        payload: dict[str, Any] = {"status": status}
        if result is not None:
            payload["result"] = result
        if error is not None:
            payload["error"] = error
        try:
            resp = self._post(
                f"agent/commands/{cmd_id}/result", json=payload, headers=headers
            )
        except requests.RequestException as exc:
            self.log.warning("Command-result transport error (id=%s): %s", cmd_id, exc)
            return False

        body = self._envelope(resp)
        if body.get("status") != 200:
            self.log.warning(
                "Command-result rejected (id=%s, status=%s): %s",
                cmd_id, body.get("status"), body.get("msg", "?"),
            )
            return False
        return True

    # ------------------------------------------------------------------ #
    # Agent self-update (Requirement 2)
    # ------------------------------------------------------------------ #
    def get_latest_version(self, agent_token: str,
                           installed_version: Optional[str] = None) -> dict[str, Any]:
        """Ask the cloud what the published-latest agent exe is.

        GETs ``{api_url}/agent/version`` (Bearer agent_token), optionally passing
        ``?agent_version=<installed>`` so the cloud can echo a convenience
        ``current`` flag. Returns the ``data`` dict:
            { latest_version, current, download_url, sha256, mandatory, notes,
              auto_update }

        Best-effort: ANY failure (transport / non-200 / odd body) returns ``{}``
        so the caller's update check can never crash the main loop.
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        path = "agent/version"
        if installed_version:
            # tiny manual query string (no urllib import needed for one param).
            path = f"agent/version?agent_version={installed_version}"
        try:
            resp = self._get(path, headers=headers)
        except requests.RequestException as exc:
            self.log.warning("Version check transport error: %s", exc)
            return {}

        body = self._envelope(resp)
        if body.get("status") != 200:
            self.log.warning(
                "Version check rejected (status=%s): %s",
                body.get("status"), body.get("msg", "?"),
            )
            return {}
        data = body.get("data")
        return data if isinstance(data, dict) else {}

    def download_update(self, agent_token: str, dest_path: str,
                        expected_sha256: Optional[str] = None) -> bool:
        """Stream the current release exe to ``dest_path`` (chunked).

        GETs ``{api_url}/agent/download`` (Bearer agent_token) and writes the
        body to ``dest_path`` in chunks (so a large exe never loads fully into
        memory). When ``expected_sha256`` is given, the downloaded file's digest
        MUST match or the partial file is removed and ``False`` is returned.

        Returns ``True`` only on a fully-written, verified download. Best-effort:
        any failure is logged and returns ``False`` (the caller then keeps
        running the OLD exe — never bricks a working agent).
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        url = self._url("agent/download")
        try:
            # A longer timeout than the JSON calls: the exe is several MB.
            with self._session.get(url, headers=headers, timeout=120, stream=True) as resp:
                ctype = (resp.headers.get("Content-Type") or "").lower()
                if resp.status_code != 200 or "application/json" in ctype:
                    # A 200-envelope JSON error (e.g. "no release published")
                    # comes back as JSON, not a binary stream — treat as no-op.
                    self.log.warning(
                        "Download did not return a file (status=%s, type=%s).",
                        resp.status_code, ctype or "?")
                    return False
                hasher = hashlib.sha256()
                written = 0
                with open(dest_path, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=65536):
                        if not chunk:
                            continue
                        fh.write(chunk)
                        hasher.update(chunk)
                        written += len(chunk)
        except requests.RequestException as exc:
            self.log.error("Download transport error: %s", exc)
            self._remove_quietly(dest_path)
            return False
        except OSError as exc:
            self.log.error("Could not write the downloaded update: %s", exc)
            self._remove_quietly(dest_path)
            return False

        if written <= 0:
            self.log.error("Downloaded update was empty.")
            self._remove_quietly(dest_path)
            return False

        if expected_sha256:
            got = hasher.hexdigest().lower()
            want = str(expected_sha256).strip().lower()
            if got != want:
                self.log.error("Update sha256 mismatch (got %s, want %s).", got, want)
                self._remove_quietly(dest_path)
                return False

        self.log.info("Downloaded update OK (%d bytes) -> %s", written, dest_path)
        return True

    # ------------------------------------------------------------------ #
    # Data Backup (Task 2 — the agent side of Task 1's cloud endpoints)
    # ------------------------------------------------------------------ #
    def get_backup_settings(self, agent_token: str) -> dict[str, Any]:
        """Fetch this license's backup intent (enabled/destination/schedule).

        GETs ``{api_url}/agent/backup-settings`` (Bearer agent_token). Returns
        the ``data`` dict: ``{enabled, destination_path, frequency, run_at,
        keep_copies}``. Raises :class:`AgentError` on transport/non-200 so the
        caller can skip this cycle's schedule check rather than guess.
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        try:
            resp = self._get("agent/backup-settings", headers=headers)
        except requests.RequestException as exc:
            self.log.warning("Backup-settings transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        if body.get("status") != 200:
            raise AgentError(body.get("msg", "Could not fetch backup settings."))
        return body.get("data") or {}

    def record_backup_run(self, agent_token: str, **fields: Any) -> bool:
        """Report the outcome of one backup run (success, partial, or failed).

        POSTs ``fields`` (``status``, ``files_copied``, ``files_skipped``,
        ``bytes_copied``, ``destination``, ``skipped_list``, ``error``,
        ``started_at``, ``finished_at``) to ``{api_url}/agent/backup-runs``
        (Bearer agent_token). Best-effort: returns ``True`` when the cloud
        accepted it, ``False`` on any transport/non-200 failure — never
        raises, so a failed report can never be mistaken for a failed backup
        or crash the sync loop.
        """
        headers = {"Authorization": f"Bearer {agent_token}"}
        try:
            resp = self._post("agent/backup-runs", json=fields, headers=headers)
        except requests.RequestException as exc:
            self.log.warning("Backup-run report transport error: %s", exc)
            return False

        body = self._envelope(resp)
        if body.get("status") != 200:
            self.log.warning(
                "Backup-run report rejected (status=%s): %s",
                body.get("status"), body.get("msg", "?"),
            )
            return False
        return True

    @staticmethod
    def _remove_quietly(path: str) -> None:
        """Best-effort delete of a partial/failed download (never raises)."""
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
