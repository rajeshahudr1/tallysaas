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
    ) -> requests.Response:
        """POST with a short retry/backoff on transport-level errors.

        Returns the :class:`requests.Response` (whatever HTTP status it
        carries). Raises :class:`requests.RequestException` only after the
        retries are exhausted, so callers can map it to a domain error.
        """
        url = self._url(path)
        last_exc: Optional[Exception] = None
        for attempt in range(RETRIES + 1):
            try:
                resp = self._session.post(
                    url, json=json, headers=headers, timeout=TIMEOUT
                )
                return resp
            except requests.RequestException as exc:
                last_exc = exc
                self.log.warning(
                    "POST %s failed (attempt %d/%d): %s",
                    url,
                    attempt + 1,
                    RETRIES + 1,
                    exc,
                )
                if attempt < RETRIES:
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
    def activate(
        self,
        license_key: str,
        machine_id: str,
        agent_version: str,
    ) -> dict[str, Any]:
        """Activate this machine against the cloud with the license key.

        POSTs ``{license_key, machine_id, agent_version}`` to
        ``{api_url}/agent/activate``.

        Returns the ``data`` part of the envelope, which holds
        ``agent_token``, ``license`` and ``companies``.

        Raises
        ------
        ActivationError
            On any transport failure or when ``body['status'] != 200``
            (invalid key / bound to another machine / suspended / expired).
            The message is taken from ``body['msg']`` when present.
        """
        self.log.info("Activating agent (machine_id=%s, v=%s)", machine_id, agent_version)
        payload = {
            "license_key": license_key,
            "machine_id": machine_id,
            "agent_version": agent_version,
        }
        try:
            resp = self._post("agent/activate", json=payload)
        except requests.RequestException as exc:
            self.log.error("Activation transport error: %s", exc)
            raise ActivationError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        status = body.get("status")
        if status != 200:
            msg = body.get("msg", "Activation failed.")
            self.log.error("Activation rejected (status=%s): %s", status, msg)
            raise ActivationError(msg)

        data = body.get("data") or {}
        self.log.info("Activation successful.")
        return data

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
        *,
        company_name: str | None = None,
        company_id: int | None = None,
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
        if not ledgers and not stock_items and not vouchers and not godowns:
            return {}
        headers = {"Authorization": f"Bearer {agent_token}"}
        payload: dict[str, Any] = {"ledgers": ledgers,
                                   "stock_items": stock_items, "vouchers": vouchers,
                                   "godowns": godowns}
        if company_name:
            payload["company_name"] = company_name
        if company_id:
            payload["company_id"] = company_id
        try:
            resp = self._post("agent/import", json=payload, headers=headers)
        except requests.RequestException as exc:
            self.log.error("Import transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        if body.get("status") != 200:
            raise AgentError(body.get("msg", "Could not import from Tally."))
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

    @staticmethod
    def _remove_quietly(path: str) -> None:
        """Best-effort delete of a partial/failed download (never raises)."""
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
