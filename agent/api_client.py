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

import logging
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

    def heartbeat(self, agent_token: str, agent_version: str) -> dict[str, Any]:
        """Send a heartbeat so the cloud knows the agent is alive.

        POSTs ``{agent_version}`` to ``{api_url}/agent/heartbeat`` with the
        ``Authorization: Bearer <agent_token>`` header.

        Returns the ``data`` part of the envelope, which holds ``status``
        (``'active'`` / ``'suspended'``) and related fields.

        Raises
        ------
        AgentError
            On any transport failure or when ``body['status'] != 200``.
        """
        self.log.debug("Sending heartbeat (v=%s)", agent_version)
        headers = {"Authorization": f"Bearer {agent_token}"}
        payload = {"agent_version": agent_version}
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
        company_id: int,
        ledgers: list[dict[str, Any]],
        stock_items: list[dict[str, Any]],
        vouchers: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Tally → Cloud: upload masters + vouchers read from Tally to be upserted.

        POSTs ``{company_id, ledgers, stock_items, vouchers}`` to
        ``{api_url}/agent/import``. Returns the import counts. Raises
        :class:`AgentError` on transport / non-200.
        """
        vouchers = vouchers or []
        if not ledgers and not stock_items and not vouchers:
            return {}
        headers = {"Authorization": f"Bearer {agent_token}"}
        payload = {"company_id": company_id, "ledgers": ledgers,
                   "stock_items": stock_items, "vouchers": vouchers}
        try:
            resp = self._post("agent/import", json=payload, headers=headers)
        except requests.RequestException as exc:
            self.log.error("Import transport error: %s", exc)
            raise AgentError("Cannot reach the cloud server.") from exc

        body = self._envelope(resp)
        if body.get("status") != 200:
            raise AgentError(body.get("msg", "Could not import from Tally."))
        return body.get("data") or {}
