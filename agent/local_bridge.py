"""The agent's local HTTP bridge — how a server-served page reaches this PC.

WHY THIS EXISTS
---------------
The window's UI is now a page served by the cloud, so it can change without
shipping a new exe. But the things that UI has to show and do are all LOCAL:
the sync state, this machine's log file, the Tally path, "sync now", "sign out".
No cloud endpoint can answer those. So the agent runs a tiny HTTP server on
loopback and the page calls it.

THE DANGER, AND WHAT ANSWERS IT
-------------------------------
An HTTP server on 127.0.0.1 is reachable by EVERY page in the user's browser.
Without protection, any website they happen to open could stop their sync, read
their Tally path, or sign the machine out. Four things together prevent that:

1. BIND TO LOOPBACK. Nothing off this machine can connect at all.
2. A PER-RUN BEARER TOKEN. Generated at startup, never written to disk, handed
   to the page through the URL *fragment* — which browsers do not send to
   servers and which does not appear in server logs or Referer headers.
3. A STRICT ORIGIN ALLOW-LIST. Requests whose Origin is not our own web tier
   are refused before any handler runs, and CORS is echoed for that one origin
   only, so a hostile page cannot even read a reply.
4. NO GET SIDE EFFECTS. Everything that changes state is POST, so a plain
   <img src="http://127.0.0.1:.../sync-now"> cannot trigger it.

The token check uses a constant-time compare: a byte-by-byte `==` on a secret
leaks, through timing, how much of it an attacker has guessed.

PORT
----
Port 0 lets the OS pick a free one — a fixed port would collide with whatever
else the customer runs and would also let a hostile page guess where to knock.
The chosen port is only ever known to the shell that started it.
"""

from __future__ import annotations

import json
import hmac
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional
from urllib.parse import urlparse, parse_qs

# Only these methods are exposed. A dispatch dict rather than getattr(name) so a
# crafted path can never reach an unrelated attribute of the handler object.
_MAX_BODY = 256 * 1024          # a UI request is tiny; anything larger is abuse


class LocalBridge:
    """A loopback JSON API the served UI calls to reach this machine.

    Handlers are supplied by the caller as ``{name: callable}``. Each is called
    with the decoded JSON body (a dict, possibly empty) and returns anything
    json-serialisable. Raising inside a handler yields a 500 with the message —
    the UI shows it rather than silently doing nothing.
    """

    def __init__(self, handlers: dict[str, Callable[[dict], Any]],
                 allowed_origin: str, logger=None) -> None:
        self._handlers = dict(handlers)
        # Compared exactly. A prefix match here would let
        # "https://our-domain.evil.com" through.
        self._origin = (allowed_origin or "").rstrip("/")
        self._log = logger
        self.token = secrets.token_urlsafe(32)
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self.port = 0

    # -- lifecycle -------------------------------------------------------- #
    def start(self) -> int:
        """Start serving on a free loopback port. Returns the port."""
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            # HTTP/1.1 means keep-alive, so a client that opens a connection and
            # walks away — a closed WebView, a browser tab in the background —
            # leaves a handler thread parked in a blocking read forever. Each
            # one holds a socket, and shutdown() waits on them.
            #
            # A read timeout bounds that: an idle connection is dropped and the
            # thread ends. Ten seconds is far longer than any call this bridge
            # serves (the slowest is a status poll) and far shorter than
            # "forever".
            timeout = 10

            # BaseHTTPRequestHandler logs every request to stderr, which in a
            # windowed build has nowhere to go and in a service build pollutes
            # the log with one line per poll.
            def log_message(self, fmt, *args):    # noqa: A003
                if bridge._log:
                    bridge._log.debug("bridge: " + fmt % args)

            def _send(self, status: int, payload: Any) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                # Echo ONLY our own origin. '*' would let any site read the
                # reply, which is most of what makes this dangerous.
                if bridge._origin:
                    self.send_header("Access-Control-Allow-Origin", bridge._origin)
                    self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                # This is private machine state; no cache should ever hold it.
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _origin_ok(self) -> bool:
                origin = (self.headers.get("Origin") or "").rstrip("/")
                # A missing Origin is the shell's own first request (same-page
                # fetches from a file:// or about: context omit it). Browsers
                # ALWAYS send it for cross-origin calls, which is the case we
                # care about, so absence is not a bypass for a hostile page.
                if not origin:
                    return True
                return origin == bridge._origin

            def _token_ok(self) -> bool:
                header = self.headers.get("Authorization") or ""
                got = header[7:] if header.lower().startswith("bearer ") else ""
                # Constant time: `==` on a secret leaks how much was guessed.
                return hmac.compare_digest(got, bridge.token)

            def do_OPTIONS(self):     # noqa: N802 - CORS preflight
                if not self._origin_ok():
                    self._send(403, {"error": "forbidden"})
                    return
                self._send(204, {})

            def do_GET(self):         # noqa: N802
                # Deliberately read-only and deliberately tiny: only a liveness
                # probe. Everything that DOES something is POST, so an <img> or
                # a stray link cannot trigger it.
                path = urlparse(self.path).path
                if path == "/ping":
                    self._send(200, {"ok": True})
                    return
                self._send(404, {"error": "not found"})

            def do_POST(self):        # noqa: N802
                if not self._origin_ok():
                    self._send(403, {"error": "forbidden origin"})
                    return
                if not self._token_ok():
                    self._send(401, {"error": "unauthorised"})
                    return

                path = urlparse(self.path).path.strip("/")
                handler = bridge._handlers.get(path)
                if handler is None:
                    self._send(404, {"error": "not found"})
                    return

                try:
                    length = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    length = 0
                if length > _MAX_BODY:
                    self._send(413, {"error": "body too large"})
                    return
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode("utf-8")) if raw else {}
                    if not isinstance(body, dict):
                        body = {}
                except ValueError:
                    self._send(400, {"error": "invalid JSON"})
                    return

                try:
                    result = handler(body)
                except Exception as exc:     # noqa: BLE001
                    if bridge._log:
                        bridge._log.exception("bridge handler %s failed", path)
                    # Surfaced so the UI can say what went wrong instead of
                    # appearing to have done nothing.
                    self._send(500, {"error": str(exc)})
                    return
                self._send(200, {"data": result})

        # Port 0 = let the OS choose. ThreadingHTTPServer so one slow handler
        # (a sync kicked off by hand) does not block the status poll behind it.
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        name="local-bridge", daemon=True)
        self._thread.start()
        if self._log:
            self._log.info("Local bridge listening on 127.0.0.1:%d", self.port)
        return self.port

    def stop(self) -> None:
        """Stop serving. Safe to call more than once."""
        if self._httpd is not None:
            try:
                self._httpd.shutdown()
                self._httpd.server_close()
            except Exception:     # noqa: BLE001 - shutdown must never raise
                pass
            self._httpd = None

    # -- the URL the shell opens ------------------------------------------ #
    def ui_url(self, base_url: str) -> str:
        """The served UI's URL, carrying the port and token in the FRAGMENT.

        The fragment is never sent to the server, never written to its access
        log and never leaks through a Referer header — so the bridge token stays
        between this process and the page it opened.
        """
        base = (base_url or "").rstrip("/")
        return f"{base}#port={self.port}&token={self.token}"


def parse_bridge_fragment(fragment: str) -> dict[str, str]:
    """Parse ``port=..&token=..`` out of a URL fragment. Used by tests and by
    any non-browser client that needs to talk to the bridge."""
    parsed = parse_qs((fragment or "").lstrip("#"))
    return {k: v[0] for k, v in parsed.items() if v}
