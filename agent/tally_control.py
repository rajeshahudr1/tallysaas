"""Open a specific company inside the local Tally Prime from a cloud command.

The cloud queues an ``open_company`` command (a user clicked "Open in Tally" in
the web app); the agent drains it (see :mod:`sync_agent`) and calls
:func:`open_company` here. The job: make the named company *loaded/open* in the
running Tally so the normal push/pull sync can target it.

Three strategies, tried in order, each verified by polling
``TallyConnector.company_info()`` (which lists only the LOADED companies) for the
company name:

1. **already-open** — if the company is already loaded, do nothing.
2. **clean** — best-effort map the company NAME → its numeric folder (by scanning
   each ``<data>/<number>/Company.1800`` for the name), rewrite ``tally.ini``
   ``Load=<number>`` to that ONE company, kill + relaunch ``tally.exe``, then poll
   for the name. This is the reliable path on LICENSED Tally Prime.
3. **ui** — when ``Load=`` is ignored (EDUCATIONAL Tally Prime, live-confirmed),
   bring the Tally window to the foreground (ctypes/user32) and send a CONFIGURABLE
   keystroke sequence (``[tally_ui] select_company_keys``) that drives Tally's
   "Select/Open Company" screen and types the company name, then poll for the name.

EXE-safe: standard library + ``requests`` only (``ctypes`` is stdlib). Windows is
the real target; on other OSes the UI step is a no-op. ASCII-only console output.

Design rule: :func:`open_company` is PURE best-effort and NEVER raises — every
branch is wrapped and any failure returns ``{ok: False, ...}`` so one bad command
can never disrupt the agent's main loop.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from typing import Any, Callable, Optional


# How long (seconds) to poll company_info() after a clean restart / UI attempt
# before giving up on that strategy. ~40s each, per the contract.
_VERIFY_TIMEOUT_S = 40
_VERIFY_INTERVAL_S = 2

# Built-in default keystroke sequence (used when [tally_ui] select_company_keys
# is absent). The EXACT keys depend on the Tally Prime version — this mirrors the
# documented default shipped in config.example.ini.
_DEFAULT_SELECT_KEYS = (
    "ESC DELAY:400 ESC DELAY:400 ALT+F3 DELAY:800 TYPE:S "
    "DELAY:800 TYPE:{name} DELAY:800 ENTER"
)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def _norm(s: Any) -> str:
    """Trim + lowercase for case-insensitive company-name comparison."""
    return str(s or "").strip().lower()


def _open_company_names(tally) -> list[str]:
    """Return the names of the companies currently OPEN in Tally (best-effort).

    Wrapped: any error (Tally down, parse miss) yields ``[]`` so callers can keep
    polling without a transport hiccup turning into an exception.
    """
    try:
        return [
            str(c.get("name") or "").strip()
            for c in (tally.company_info().get("companies") or [])
            if str(c.get("name") or "").strip()
        ]
    except Exception:
        return []


def _is_loaded(tally, name: str) -> bool:
    """True if ``name`` (case-insensitive, trimmed) is currently open in Tally."""
    target = _norm(name)
    return any(_norm(n) == target for n in _open_company_names(tally))


def _poll_loaded(tally, name: str, log, echo: Callable[[str], None],
                 timeout_s: int = _VERIFY_TIMEOUT_S) -> bool:
    """Poll ``company_info()`` up to ``timeout_s`` for ``name`` to appear loaded.

    Returns True as soon as the company shows up, False on timeout. Used to verify
    both the clean restart and the UI attempt.
    """
    deadline = time.time() + max(1, timeout_s)
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        if _is_loaded(tally, name):
            return True
        if attempt == 1 or attempt % 5 == 0:
            log.debug("open_company: waiting for '%s' to load (%ds left)...",
                      name, int(deadline - time.time()))
            echo(f"    [..] waiting for '{name}' to load in Tally...")
        time.sleep(_VERIFY_INTERVAL_S)
    return _is_loaded(tally, name)


# --------------------------------------------------------------------------- #
# CLEAN path: name -> numeric folder, rewrite tally.ini Load=, restart, verify
# --------------------------------------------------------------------------- #
def _read_data_path(ini_path: str) -> Optional[str]:
    """Read the ``Data=`` directory from tally.ini (the company-folders root).

    Returns the path if it exists on disk, else None. Best-effort + wrapped.
    """
    try:
        if not ini_path or not os.path.isfile(ini_path):
            return None
        with open(ini_path, "r", encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                m = re.match(r"\s*Data\s*=\s*(.+?)\s*$", ln, re.I)
                if m:
                    p = m.group(1).strip()
                    return p if os.path.isdir(p) else None
    except Exception:
        return None
    return None


def _company_name_in_blob(blob: bytes, name: str) -> bool:
    """Best-effort: does ``name`` appear as text inside a Company.1800 blob?

    Tally stores the company name as readable text inside Company.1800, but the
    encoding varies (latin-1 / utf-16). Decode tolerantly under a few encodings
    and substring-match (case-insensitive). Any decode failure is simply skipped.
    """
    target = _norm(name)
    if not target:
        return False
    for enc in ("latin-1", "utf-16-le", "utf-16", "utf-8"):
        try:
            text = blob.decode(enc, errors="ignore")
        except Exception:
            continue
        if target in text.lower():
            return True
    return False


def _resolve_company_number(data_path: str, name: str, log,
                            echo: Callable[[str], None]) -> Optional[str]:
    """Map a company NAME to its numeric folder by scanning each Company.1800.

    Company folders are numeric (100000, 100001, ...); each holds Company.1800
    with the company name as readable text. Scan each numeric folder's
    Company.1800 for the name (tolerant decode + substring). Returns the folder
    number as a string, or None if not found. Best-effort + never raises.
    """
    try:
        if not data_path or not os.path.isdir(data_path):
            return None
        nums = sorted(
            d for d in os.listdir(data_path)
            if d.isdigit() and os.path.isdir(os.path.join(data_path, d))
        )
        for num in nums:
            blob_path = os.path.join(data_path, num, "Company.1800")
            if not os.path.isfile(blob_path):
                continue
            try:
                with open(blob_path, "rb") as fh:
                    blob = fh.read()
            except Exception as exc:
                log.debug("open_company: could not read %s: %s", blob_path, exc)
                continue
            if _company_name_in_blob(blob, name):
                log.info("open_company: resolved '%s' -> company number %s.", name, num)
                echo(f"    [OK] matched '{name}' to company number {num}.")
                return num
    except Exception as exc:
        log.warning("open_company: name->number scan failed: %s", exc)
    return None


def _rewrite_load_line(ini_path: str, number: str, log) -> bool:
    """Rewrite tally.ini so ``Load=<number>`` loads ONLY this company.

    Replaces the existing Load= line (or appends one). Returns True on a
    successful write, False otherwise. Best-effort + never raises.
    """
    try:
        if not ini_path or not os.path.isfile(ini_path):
            return False
        with open(ini_path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
        out, seen = [], False
        for ln in lines:
            if re.match(r"\s*Load\s*=", ln, re.I):
                if not seen:
                    out.append("Load=" + number + "\n")
                    seen = True
                # drop any additional Load= lines so ONLY this company loads.
            else:
                out.append(ln)
        if not seen:
            out.append("Load=" + number + "\n")
        with open(ini_path, "w", encoding="utf-8") as fh:
            fh.writelines(out)
        log.info("open_company: tally.ini set Load=%s (single company).", number)
        return True
    except Exception as exc:
        log.warning("open_company: could not rewrite tally.ini Load=: %s", exc)
        return False


def _kill_tally(log, echo: Callable[[str], None]) -> None:
    """Terminate any running tally.exe so the new Load= takes effect on relaunch.

    Windows-only (taskkill); best-effort + never raises. A missing process just
    means there is nothing to kill.
    """
    if os.name != "nt":
        return
    try:
        echo("    [..] closing TallyPrime to apply the new company...")
        subprocess.run(
            ["taskkill", "/F", "/IM", "tally.exe"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=20,
        )
        log.info("open_company: requested tally.exe termination.")
        # Give Windows a moment to release file locks before relaunch.
        time.sleep(2)
    except Exception as exc:
        log.debug("open_company: taskkill tally.exe: %s", exc)


def _launch_tally(exe_path: str, log, echo: Callable[[str], None]) -> bool:
    """Relaunch tally.exe (detached). Returns True if the launch was issued.

    Best-effort + never raises; a missing exe / launch error returns False.
    """
    try:
        if not exe_path or not os.path.isfile(exe_path):
            log.warning("open_company: tally.exe not found at '%s'.", exe_path)
            return False
        echo(f"    [..] relaunching TallyPrime: {exe_path}")
        flags = 0x00000008 if os.name == "nt" else 0  # DETACHED_PROCESS
        subprocess.Popen(
            [exe_path], cwd=os.path.dirname(exe_path) or None,
            close_fds=True, creationflags=flags,
        )
        log.info("open_company: relaunched Tally - %s", exe_path)
        return True
    except Exception as exc:
        log.warning("open_company: failed to relaunch Tally: %s", exc)
        return False


def _try_clean(tally, name: str, data_path: Optional[str], ini_path: str,
               exe_path: str, log, echo: Callable[[str], None]) -> bool:
    """The CLEAN strategy: name->number, rewrite Load=, restart, verify.

    Returns True only if, after the restart, the company shows up as loaded.
    Never raises (each sub-step is wrapped).
    """
    if not data_path:
        data_path = _read_data_path(ini_path)
    if not data_path:
        echo("    [!] clean: could not read Tally Data= path; skipping clean method.")
        log.info("open_company: no Data path for clean method.")
        return False

    number = _resolve_company_number(data_path, name, log, echo)
    if not number:
        echo("    [!] clean: could not map the company name to a folder number; "
             "skipping clean method.")
        log.info("open_company: name->number unresolved for '%s'.", name)
        return False

    if not _rewrite_load_line(ini_path, number, log):
        echo("    [!] clean: could not rewrite tally.ini Load=; skipping clean method.")
        return False

    _kill_tally(log, echo)
    _launch_tally(exe_path, log, echo)

    echo(f"    [..] verifying '{name}' is loaded (up to ~{_VERIFY_TIMEOUT_S}s)...")
    return _poll_loaded(tally, name, log, echo, _VERIFY_TIMEOUT_S)


# --------------------------------------------------------------------------- #
# UI fallback: focus the Tally window + send a configurable keystroke sequence
# --------------------------------------------------------------------------- #
# Virtual-key codes (Windows) for the tokens the DSL understands.
_VK = {
    "ESC": 0x1B, "ENTER": 0x0D, "TAB": 0x09,
    "UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27,
    "ALT": 0x12, "CTRL": 0x11, "SHIFT": 0x10,
    "SPACE": 0x20, "BACKSPACE": 0x08, "HOME": 0x24, "END": 0x23,
}
for _i in range(1, 13):  # F1..F12 -> 0x70..0x7B
    _VK["F%d" % _i] = 0x70 + (_i - 1)

_MOD_NAMES = {"ALT", "CTRL", "SHIFT"}

# keybd_event flags.
_KEYEVENTF_KEYUP = 0x0002


def _find_tally_window():
    """Find a Tally top-level window handle by title (best-effort, Windows-only).

    Enumerates top-level windows and returns the first whose visible title
    contains 'TallyPrime' or 'Tally'. Returns an HWND (int) or None. Never raises.
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        found = {"hwnd": None}

        EnumWindowsProc = ctypes.WINFUNCTYPE(
            ctypes.c_bool, wintypes.HWND, wintypes.LPARAM
        )

        def _cb(hwnd, _lparam):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                if length <= 0:
                    return True
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = (buf.value or "").lower()
                if "tallyprime" in title or "tally" in title:
                    found["hwnd"] = hwnd
                    return False  # stop enumerating
            except Exception:
                pass
            return True

        user32.EnumWindows(EnumWindowsProc(_cb), 0)
        return found["hwnd"]
    except Exception:
        return None


def _focus_window(hwnd, log) -> bool:
    """Bring a window to the foreground so keystrokes land on it. Never raises."""
    if not hwnd or os.name != "nt":
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        SW_RESTORE = 9
        user32.ShowWindow(hwnd, SW_RESTORE)   # un-minimize if needed
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.4)
        return True
    except Exception as exc:
        log.debug("open_company: SetForegroundWindow failed: %s", exc)
        return False


def _press_vk(vk: int, down: bool) -> None:
    """Send a single key down/up via keybd_event (ctypes, stdlib)."""
    import ctypes
    flags = 0 if down else _KEYEVENTF_KEYUP
    ctypes.windll.user32.keybd_event(vk, 0, flags, 0)


def _send_combo(tokens: list[str], log) -> None:
    """Send a single key or a modifier combo like ALT+F3 (hold mods, tap key)."""
    vks = []
    for t in tokens:
        vk = _VK.get(t.upper())
        if vk is None:
            log.debug("open_company: unknown key token '%s' (skipped).", t)
            continue
        vks.append(vk)
    if not vks:
        return
    # Press modifiers first, then the final key, then release in reverse.
    try:
        for vk in vks:
            _press_vk(vk, True)
            time.sleep(0.03)
        for vk in reversed(vks):
            _press_vk(vk, False)
            time.sleep(0.03)
    except Exception as exc:
        log.debug("open_company: send combo %s failed: %s", tokens, exc)


def _type_text(text: str, log) -> None:
    """Type a literal string char-by-char using the scancode-unicode path.

    Uses keybd_event with VK=0 and the KEYEVENTF_UNICODE flag so any character
    (including spaces and non-ASCII company names) is delivered regardless of
    keyboard layout. ctypes only; never raises.
    """
    if not text:
        return
    KEYEVENTF_UNICODE = 0x0004
    try:
        import ctypes
        user32 = ctypes.windll.user32
        for ch in text:
            code = ord(ch)
            user32.keybd_event(0, code, KEYEVENTF_UNICODE, 0)
            user32.keybd_event(0, code, KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP, 0)
            time.sleep(0.02)
    except Exception as exc:
        log.debug("open_company: type_text failed: %s", exc)


def _send_sequence(sequence: str, name: str, log,
                   echo: Callable[[str], None]) -> None:
    """Parse + send the keystroke DSL.

    Tokens (space-separated):
        ESC ENTER UP DOWN TAB F1..F12   - single keys
        ALT+F3, CTRL+ENTER, ...         - '+' combos (hold modifiers, tap key)
        DELAY:ms                        - pause ms milliseconds
        TYPE:{name}                     - type the company name
        TYPE:literal                    - type a literal string (e.g. TYPE:S)
    Unknown tokens are skipped. Never raises.
    """
    for token in sequence.split():
        tok = token.strip()
        if not tok:
            continue
        upper = tok.upper()
        try:
            if upper.startswith("DELAY:"):
                ms = re.sub(r"[^0-9]", "", tok.split(":", 1)[1]) or "0"
                time.sleep(min(10.0, int(ms) / 1000.0))
            elif upper.startswith("TYPE:"):
                literal = tok.split(":", 1)[1]
                literal = literal.replace("{name}", name)
                _type_text(literal, log)
            elif "+" in tok:
                _send_combo(tok.split("+"), log)
            else:
                _send_combo([tok], log)
        except Exception as exc:
            log.debug("open_company: token '%s' failed: %s", tok, exc)


def _try_ui(tally, name: str, sequence: str, log,
            echo: Callable[[str], None]) -> bool:
    """The UI strategy: focus the Tally window, send the keystrokes, verify.

    Returns True only if the company shows up as loaded afterwards. Never raises.
    """
    if os.name != "nt":
        echo("    [!] ui: keystroke automation is Windows-only; skipping.")
        return False

    hwnd = _find_tally_window()
    if not hwnd:
        echo("    [!] ui: could not find a Tally window to focus; skipping UI method.")
        log.info("open_company: no Tally window found for UI fallback.")
        return False

    if not _focus_window(hwnd, log):
        echo("    [!] ui: could not bring the Tally window to the foreground.")
        # Still attempt to send keys — focus may already be correct.

    echo("    [..] ui: sending 'Select Company' keystrokes to Tally...")
    log.info("open_company: UI fallback sending sequence: %s", sequence)
    _send_sequence(sequence, name, log, echo)

    echo(f"    [..] verifying '{name}' is loaded (up to ~{_VERIFY_TIMEOUT_S}s)...")
    return _poll_loaded(tally, name, log, echo, _VERIFY_TIMEOUT_S)


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def _select_company_keys(cfg) -> str:
    """Read [tally_ui] select_company_keys from config, else the built-in default.

    Reads via the Config's underlying configparser (cfg._parser). Any failure
    falls back to :data:`_DEFAULT_SELECT_KEYS`.
    """
    try:
        parser = getattr(cfg, "_parser", None)
        if parser is not None and parser.has_section("tally_ui"):
            val = parser["tally_ui"].get("select_company_keys", "").strip()
            if val:
                return val
    except Exception:
        pass
    return _DEFAULT_SELECT_KEYS


def open_company(cfg, logger, tally, *, name, data_path, ini_path, exe_path):
    """Open the named company in Tally; return ``{ok, method, message}``.

    Tries, in order: already-open short-circuit, the CLEAN method (tally.ini
    Load= rewrite + restart), then the UI-automation fallback (window focus +
    keystroke DSL). Each strategy is verified by polling ``company_info()`` for
    the company name.

    Parameters
    ----------
    cfg:
        The agent :class:`Config` (used for ``[tally_ui] select_company_keys``).
    logger:
        Standard logger for the detailed file record.
    tally:
        A :class:`TallyConnector` for ``company_info()`` verification.
    name:
        The company name to open (as stored in Tally / the cloud).
    data_path:
        Tally's company-folders root (the ``Data=`` dir). May be None — it is
        then read from ``ini_path``.
    ini_path:
        Full path to ``tally.ini`` (rewritten by the CLEAN method).
    exe_path:
        Full path to ``tally.exe`` (relaunched by the CLEAN method).

    Returns
    -------
    dict
        ``{ok: bool, method: 'already-open'|'clean'|'ui'|'none', message: str}``.
        NEVER raises — every branch is wrapped and a failure returns ok=False.
    """
    # echo: progress to the operator console (the caller may pass a VERBOSE echo
    # via cfg/logger; here we use the module's own ASCII echo through logger only
    # when no console hook is wired — keep it simple + dependency-free).
    def echo(msg: str) -> None:
        try:
            print(msg, flush=True)
        except Exception:
            pass

    name = str(name or "").strip()
    if not name:
        return {"ok": False, "method": "none", "message": "no company name given."}

    try:
        logger.info("open_company: request to open '%s'.", name)
        echo(f"  [cmd] open_company: '{name}'")

        # Step 1 - already open?
        if _is_loaded(tally, name):
            logger.info("open_company: '%s' is already open.", name)
            echo(f"    [OK] '{name}' is already open in Tally.")
            return {"ok": True, "method": "already-open",
                    "message": f"'{name}' was already open."}

        # Step 2 - CLEAN method (tally.ini Load= rewrite + restart).
        echo("    [..] trying clean method (tally.ini Load= + restart)...")
        try:
            if _try_clean(tally, name, data_path, ini_path, exe_path, logger, echo):
                logger.info("open_company: '%s' opened via clean method.", name)
                echo(f"    [OK] '{name}' opened via clean method.")
                return {"ok": True, "method": "clean",
                        "message": f"opened '{name}' via tally.ini Load= + restart."}
        except Exception as exc:  # belt-and-braces: clean must never raise out.
            logger.warning("open_company: clean method error: %s", exc)
            echo(f"    [!] clean method error: {exc}")

        # Step 3 - UI fallback (window focus + configurable keystrokes).
        echo("    [..] clean method did not load it; trying UI automation...")
        sequence = _select_company_keys(cfg)
        try:
            if _try_ui(tally, name, sequence, logger, echo):
                logger.info("open_company: '%s' opened via UI automation.", name)
                echo(f"    [OK] '{name}' opened via UI automation.")
                return {"ok": True, "method": "ui",
                        "message": f"opened '{name}' via UI automation."}
        except Exception as exc:
            logger.warning("open_company: UI method error: %s", exc)
            echo(f"    [!] UI method error: {exc}")

        msg = ("could not open via clean or UI; set [tally_ui] select_company_keys "
               "for your Tally version")
        logger.warning("open_company: '%s' - %s.", name, msg)
        echo(f"    [x] {msg}")
        return {"ok": False, "method": "none", "message": msg}

    except Exception as exc:  # absolute backstop - open_company NEVER raises.
        try:
            logger.error("open_company: unexpected error for '%s': %s", name, exc)
        except Exception:
            pass
        return {"ok": False, "method": "none",
                "message": "unexpected error: " + str(exc)[:200]}
