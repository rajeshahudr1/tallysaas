"""The desktop shell: a window around the server-served agent UI.

WHAT THIS REPLACES AND WHY
--------------------------
The interface used to be ~2,700 lines of tkinter compiled into the exe, so
changing a label meant a new build, a new signature, and every customer
downloading 23 MB. The interface now lives in the web tier
(``web/views/agent-app/index.ejs``) and this module is only the frame around it:
open a window, point it at that page, and stand up the loopback bridge the page
uses to reach this machine.

HOST SELECTION, AND WHY IT IS PLUGGABLE
---------------------------------------
The nice window is a WebView2 control via pywebview. But WebView2 is an Edge
component: it is present on current Windows and absent on plenty of the older
back-office PCs this agent is actually installed on. An app that refuses to open
at all on those machines is a far worse outcome than one that opens in the
customer's browser, so the host degrades in three steps:

  1. pywebview      - a real application window.
  2. default browser - a tab, opened with the same URL. Everything works; it
                      just is not chrome-less.
  3. neither        - print the URL and keep running headless, because the sync
                      service does not need a UI to do its job.

The tkinter build is still there and still works; this is an additional host,
not a demolition. That matters while the served UI is new: if it turns out to be
wrong for some customer, ``--ui=tk`` still gets them a working window.
"""

from __future__ import annotations

import logging
import threading
import webbrowser
from typing import Any, Callable, Optional

from local_bridge import LocalBridge
from brand import NAME as _BRAND_NAME


def _origin_of(url: str) -> str:
    """scheme://host[:port] of a URL — what the bridge's CORS check compares."""
    from urllib.parse import urlparse
    parts = urlparse(url or "")
    if not parts.scheme or not parts.netloc:
        return ""
    return f"{parts.scheme}://{parts.netloc}"


class AgentShell:
    """Window + bridge. The UI itself is served, not built here.

    ``handlers`` is the bridge API the served page calls: ``machine``,
    ``status``, ``sync-now``, ``save-token``, ``sign-out``, ``get-settings``,
    ``save-settings``. Supplied by the caller so this module stays a frame and
    knows nothing about syncing.
    """

    def __init__(self, ui_url: str, handlers: dict[str, Callable[[dict], Any]],
                 logger: Optional[logging.Logger] = None,
                 title: str = _BRAND_NAME) -> None:
        self.ui_url = ui_url
        self.title = title
        self.log = logger or logging.getLogger("shell")
        # The bridge only answers pages from the origin that serves the UI, so
        # it is derived from the same URL rather than configured separately —
        # two settings that must agree are one settings bug waiting to happen.
        self.bridge = LocalBridge(handlers, allowed_origin=_origin_of(ui_url),
                                  logger=self.log)

    # -- hosts ------------------------------------------------------------ #
    @staticmethod
    def webview_available() -> bool:
        """Whether a real window can be opened on this machine.

        Importing pywebview is not enough — it imports fine on a PC with no
        WebView2 runtime and only fails when a window is actually created. So
        this also asks the platform layer whether a renderer exists.
        """
        try:
            import webview                                   # noqa: F401
        except Exception:
            return False
        try:
            from webview.platforms import winforms           # noqa: F401
            return True
        except Exception:
            # No usable renderer. Fall back rather than crash on first paint.
            return False

    def run(self, prefer: str = "auto") -> str:
        """Start the bridge and show the UI. Returns the host actually used.

        ``prefer`` is ``auto`` | ``webview`` | ``browser`` | ``none``. Blocks
        for the ``webview`` host (its event loop owns the thread) and returns
        immediately for the others.
        """
        port = self.bridge.start()
        url = self.bridge.ui_url(self.ui_url)
        self.log.info("Agent UI: %s (bridge on 127.0.0.1:%d)", self.ui_url, port)

        if prefer == "none":
            print(f"Agent UI: {url}")
            return "none"

        if prefer in ("auto", "webview") and self.webview_available():
            try:
                import webview
                webview.create_window(self.title, url, width=880, height=660,
                                      min_size=(640, 520))
                # Blocks until the window closes. The bridge is stopped after so
                # a closed window cannot leave a listening socket behind.
                webview.start()
                return "webview"
            except Exception as exc:                          # noqa: BLE001
                self.log.warning("WebView host failed (%s); using the browser.", exc)
            finally:
                self.bridge.stop()

        if prefer in ("auto", "browser", "webview"):
            try:
                webbrowser.open(url, new=1)
                return "browser"
            except Exception as exc:                          # noqa: BLE001
                self.log.warning("Could not open a browser: %s", exc)

        print(f"Agent UI: {url}")
        return "none"

    def run_background(self, prefer: str = "auto") -> threading.Thread:
        """Show the UI without blocking the caller.

        The sync loop must keep running while the window is open; the webview
        host would otherwise hold the main thread for the life of the window.
        """
        thread = threading.Thread(target=self.run, args=(prefer,),
                                  name="agent-shell", daemon=True)
        thread.start()
        return thread

    def stop(self) -> None:
        self.bridge.stop()
