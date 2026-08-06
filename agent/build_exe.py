"""Build the standalone Teloora Agent executable with PyInstaller.

Produces a single ``TallyCloudSyncAgent.exe`` from :mod:`sync_agent` so the
customer does not need a Python install. Run on a Windows machine that has the
project's dependencies installed.

Quick build (manual)
---------------------
    pip install pyinstaller
    pyinstaller --onefile --name TallyCloudSyncAgent sync_agent.py

…or just run this script, which does the same with sensible flags and a few
pre-flight checks:

    python build_exe.py            # console agent  -> dist/TallyCloudSyncAgent.exe
    python build_exe.py --gui      # windowed GUI   -> dist/TallyCloudSync.exe
    python build_exe.py --both     # build both exes

The console binary lands in ``dist/TallyCloudSyncAgent.exe`` (headless / debug)
and the windowed GUI binary in ``dist/TallyCloudSync.exe`` (the new primary
deliverable: a self-installing tkinter app with no console window).

Auto-start at logon
-------------------
The agent is meant to run whenever the customer logs in. Two common ways:

1. Startup-folder shortcut (simplest):
   - Press Win+R, type ``shell:startup``, press Enter.
   - Drop a shortcut to ``dist\\TallyCloudSyncAgent.exe`` into that folder.
   - It launches automatically at every logon.

2. Task Scheduler (more robust — survives without an open console, can
   restart on failure). Create a logon-triggered task:

       schtasks /Create /TN "TallyCloudSyncAgent" ^
           /TR "C:\\TallyAgent\\TallyCloudSyncAgent.exe" ^
           /SC ONLOGON /RL HIGHEST /F

   Remove it later with:

       schtasks /Delete /TN "TallyCloudSyncAgent" /F

Notes
-----
* ``config.ini`` and the ``logs/`` directory are created/read next to the
  executable's working directory. The server URL is BAKED into the exe
  (``constants.API_BASE_URL``) and the agent token is stored ENCRYPTED and
  machine-bound, so nothing sensitive is ever typed twice or kept in plain text.
  The Setup window asks for an email, a password and the emailed code - install
  folder, Tally path and sync interval use defaults and move to Settings.
* PRODUCTION BUILD: before building the distributable GUI exe, set
  ``constants.API_BASE_URL`` to your production domain (it is the ONLY place the
  server URL lives). Then:  ``python build_exe.py --gui``  ->
  ``dist/TallyCloudSync.exe``.
* WINDOWS SERVICE (no logged-in user): the GUI build IS the service. The SAME
  one exe serves the GUI, the service (run via ``--run-service``) and service
  management (``install-service`` / ``remove-service`` / ``start-service`` /
  ``stop-service``). The Setup wizard registers + starts the service
  automatically (elevated via UAC). pywin32 is bundled via the hidden-imports
  below, so no extra steps are needed at runtime. To run the exe AS the service
  by hand for testing, run ``TallyCloudSync.exe install-service`` from an
  elevated prompt (or let the installer do it).
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

from brand import NAME as _BRAND_NAME


# NOTE: APP_NAME / GUI_APP_NAME below are the OUTPUT EXE FILENAMES, not display
# text. gui_agent.py's INSTALLED_EXE_NAME ("TallyCloudSync.exe") and the
# scheduled-task / shortcut names elsewhere all key off these — renaming them
# would make an updated build invisible to an existing install's detection
# logic. Deliberately left as-is; only the version-info strings below (product
# name / description, visible in Explorer's file Properties dialog) follow the
# brand.
APP_NAME = "TallyCloudSyncAgent"
ENTRY_SCRIPT = "sync_agent.py"

# The publisher CN on our code-signing certificate. Baked here (and in
# constants) so a build can assert it signed with the RIGHT certificate, not
# merely with A certificate.
PUBLISHER_CN = "Dukansetu"

# The windowed (no-console) GUI build. This is the new PRIMARY deliverable: a
# self-installing tkinter app. PyInstaller bundles tkinter automatically, so no
# extra hidden-imports are needed for it beyond the agent's sibling modules.
GUI_APP_NAME = "TallyCloudSync"
GUI_ENTRY_SCRIPT = "gui_agent.py"


def _stamp_version(version: str) -> bool:
    """Stamp ``version`` into config so the built exe reports the new version.

    The reported agent_version has TWO sources that must agree:
      • config.example.ini  [agent] agent_version=  (shipped beside the exe; the
        customer copies it to config.ini)
      • config.py           _DEFAULT_AGENT_VERSION   (the fallback when config.ini
        omits agent_version — and what a fresh install reports)

    Both are rewritten here so a release built with ``python build_exe.py
    --version 1.0.1`` reports v1.0.1 in its heartbeat (which the cloud compares
    against the published agent_releases.version). Returns True on success.
    """
    here = Path(__file__).resolve().parent
    ok = True

    ini = here / "config.example.ini"
    try:
        text = ini.read_text(encoding="utf-8")
        new = re.sub(r"(?m)^(agent_version\s*=).*$", r"\g<1>" + version, text)
        if new != text:
            ini.write_text(new, encoding="utf-8")
            print(f"Stamped agent_version={version} into config.example.ini")
    except OSError as exc:
        print(f"Could not stamp config.example.ini: {exc}")
        ok = False

    cfg = here / "config.py"
    try:
        text = cfg.read_text(encoding="utf-8")
        new = re.sub(r'(?m)^(_DEFAULT_AGENT_VERSION\s*=\s*").*(")\s*$',
                     r"\g<1>" + version + r"\g<2>", text)
        if new != text:
            cfg.write_text(new, encoding="utf-8")
            print(f"Stamped _DEFAULT_AGENT_VERSION = \"{version}\" into config.py")
    except OSError as exc:
        print(f"Could not stamp config.py: {exc}")
        ok = False

    return ok


def _current_version() -> str:
    """The version the source currently reports, from config.py."""
    here = Path(__file__).resolve().parent
    try:
        text = (here / "config.py").read_text(encoding="utf-8")
        m = re.search(r'(?m)^_DEFAULT_AGENT_VERSION\s*=\s*"(.+?)"\s*$', text)
        if m:
            return m.group(1).strip()
    except OSError:
        pass
    return "1.0.0"


def _next_version(current: str) -> str:
    """``1.0.0`` -> ``1.0.1``. The last numeric part goes up by one.

    Deliberately dumb: it only ever moves the patch. Deciding that a build is a
    minor or a major release is a judgement about what changed, and a build
    script cannot make it — pass --version when that is the intent.
    """
    parts = str(current or "").strip().split(".")
    while len(parts) < 3:
        parts.append("0")
    try:
        parts[-1] = str(int(re.match(r"\d+", parts[-1]).group(0)) + 1)
    except Exception:                                       # noqa: BLE001
        parts[-1] = "1"
    return ".".join(parts)


def _nuitka_cmd(here: Path, app_name: str, entry: str, gui: bool) -> list[str]:
    """The Nuitka command line for a standalone one-file build.

    WHY NUITKA RATHER THAN PYINSTALLER for a release build: PyInstaller bundles
    the .pyc files intact. `pyinstxtractor` plus any decompiler turns a shipped
    exe back into readable source in about two minutes — our module names are
    even visible in the raw binary. Nuitka compiles the Python to C first, so
    there is no bytecode in the artifact to extract.

    This does NOT make the binary secret-safe (nothing does — anything the
    program can read, an attacker with the file can eventually read). It raises
    the cost of casually lifting the integration logic from trivial to serious.
    """
    cmd = [
        sys.executable, "-m", "nuitka",
        "--standalone",
        "--onefile",
        "--assume-yes-for-downloads",
        f"--output-filename={app_name}.exe",
        "--output-dir=dist",
        # Tell Nuitka the sibling modules are part of the program; without this
        # they are treated as external and left out of the compiled result.
        "--include-module=config",
        "--include-module=logger",
        "--include-module=api_client",
        "--include-module=tally_connector",
        "--include-module=tally_schema",
        "--include-module=tally_control",
        "--include-module=constants",
        "--include-module=codesign",
        # Company/version metadata — an exe with no publisher fields looks
        # anonymous in Explorer even when correctly signed.
        "--company-name=Dukansetu",
        f"--product-name={_BRAND_NAME}",
        f"--file-description={_BRAND_NAME} Agent",
    ]
    icon = here / "app_icon.ico"
    if icon.exists():
        cmd.append(f"--windows-icon-from-ico={icon}")
    if gui:
        cmd += [
            "--windows-console-mode=disable",
            "--enable-plugin=tk-inter",
            "--include-module=sync_agent",
            "--include-module=win_service",
            "--include-module=gui_agent",
        ]
    cmd.append(str(here / entry))
    return cmd


def _ensure_nuitka() -> bool:
    """Return True if Nuitka is importable, else print guidance."""
    try:
        import nuitka  # noqa: F401  (import is the check)
        return True
    except ImportError:
        print("Nuitka is not installed. Install it with:")
        print("    pip install nuitka")
        print("A C compiler is also needed; Nuitka offers to download MinGW64 "
              "on first run, or use Visual Studio Build Tools.")
        return False


def _write_checksum(exe: Path) -> None:
    """Write <exe>.sha256 next to the build.

    Publishing the digest costs nothing and is the only integrity check a
    customer has when the exe is unsigned. It proves the file matches what we
    built — not who built it, which is what a signature is for.
    """
    try:
        import codesign
        digest = codesign.sha256(str(exe))
        if not digest:
            return
        target = exe.with_suffix(exe.suffix + ".sha256")
        # Two spaces + filename: the format `sha256sum -c` and every Windows
        # checksum tool already understands, so a customer can verify without
        # being taught anything.
        target.write_text(digest + "  " + exe.name + "\n", encoding="utf-8")
        print(f"[build] SHA-256: {digest}")
        print(f"[build] written to {target.name}")
    except Exception as exc:      # noqa: BLE001 - a checksum is a nicety
        print(f"[build] Could not write a checksum: {exc}")


def _self_sign_artifact(exe: Path) -> bool:
    """Sign with a locally generated certificate. FREE, and limited.

    This does NOT stop SmartScreen — nothing free does; a publicly-trusted
    certificate is priced at the identity check behind it. What it secures is
    the agent's OWN update gate, which only has to recognise our publisher CN,
    not chain to a public root. A compromised update server still cannot make
    installed agents run someone else's binary.
    """
    try:
        import codesign
    except ImportError:
        print("[sign] codesign.py not importable — cannot sign.")
        return False
    if not codesign.sign_self(str(exe), PUBLISHER_CN):
        return False
    print("[sign] Self-signed. Windows will still show a download warning;")
    print("[sign] the update channel is what this protects.")
    return True


def _sign_artifact(exe: Path, thumbprint: str | None) -> bool:
    """Sign the built exe and REFUSE to report success if verification fails.

    A build that silently produces an unsigned artifact is how unsigned
    binaries reach customers — the release only looks wrong once SmartScreen
    complains, which is after shipping.
    """
    try:
        import codesign
    except ImportError:
        print("[sign] codesign.py not importable — cannot sign.")
        return False

    if not codesign.sign(str(exe), thumbprint=thumbprint):
        return False
    if not codesign.verify(str(exe)):
        print("[sign] Signed, but verification FAILED — not shippable.")
        return False
    subject = codesign.signer_subject(str(exe))
    print(f"[sign] Verified. Signer: {subject}")
    if PUBLISHER_CN and PUBLISHER_CN.lower() not in subject.lower():
        # Not fatal (a rename or a test cert is legitimate), but it must be
        # loud: agents in the field reject an update whose CN they don't know.
        print(f"[sign] WARNING: signer does not contain {PUBLISHER_CN!r}. "
              "Installed agents verify the publisher CN before applying an "
              "update, so they will REJECT a build signed with this cert.")
    return True


def _ensure_pyinstaller() -> bool:
    """Return True if PyInstaller is importable, else print guidance."""
    try:
        import PyInstaller  # noqa: F401  (import is the check)
        return True
    except ImportError:
        print("PyInstaller is not installed. Install it with:")
        print("    pip install pyinstaller")
        return False


def _ensure_entry_script(entry: str = ENTRY_SCRIPT) -> bool:
    """Verify the given entry script exists next to this builder."""
    script = Path(__file__).resolve().parent / entry
    if not script.exists():
        print(f"Entry script not found: {script}")
        return False
    return True


def build(gui: bool = False, nuitka: bool = False,
          sign: bool = False, thumbprint: str | None = None,
          self_sign: bool = False) -> int:
    """Invoke PyInstaller to produce the one-file executable.

    ``gui=False`` builds the CONSOLE agent (``sync_agent.py`` ->
    ``TallyCloudSyncAgent.exe``). ``gui=True`` builds the WINDOWED, no-console
    GUI (``gui_agent.py`` -> ``TallyCloudSync.exe``) with ``--windowed`` so no
    console window appears. PyInstaller bundles tkinter automatically.

    Returns a process exit code (0 on success).
    """
    app_name = GUI_APP_NAME if gui else APP_NAME
    entry = GUI_ENTRY_SCRIPT if gui else ENTRY_SCRIPT

    if not _ensure_entry_script(entry):
        return 1

    here = Path(__file__).resolve().parent

    # ── Nuitka path: compiled, no extractable bytecode. Preferred for a
    #    RELEASE build; PyInstaller stays the default for fast iteration
    #    because a Nuitka build takes minutes rather than seconds. ──
    if nuitka:
        if not _ensure_nuitka():
            return 1
        cmd = _nuitka_cmd(here, app_name, entry, gui)
        print("Running:", " ".join(cmd))
        try:
            result = subprocess.run(cmd, cwd=str(here), check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            print(f"Build failed to start: {exc}")
            return 1
        if result.returncode != 0:
            print(f"Nuitka exited with code {result.returncode}.")
            return result.returncode
        exe = here / "dist" / f"{app_name}.exe"
        if not exe.exists():
            print("Build reported success but the exe was not found.")
            return 1
        print(f"\nBuild complete (Nuitka, compiled): {exe}")
        if sign and not _sign_artifact(exe, thumbprint):
            return 1
        if self_sign and not _self_sign_artifact(exe):
            return 1
        # After signing — see the PyInstaller path below for why.
        _write_checksum(exe)
        return 0

    if not _ensure_pyinstaller():
        return 1

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",
        "--name",
        app_name,
        "--clean",
        "--noconfirm",
        # The agent imports its siblings as top-level modules; ensure they are
        # collected even if PyInstaller's static analysis misses one.
        "--hidden-import",
        "config",
        "--hidden-import",
        "logger",
        "--hidden-import",
        "api_client",
        "--hidden-import",
        "tally_connector",
        # tally_schema/tally_control are imported by tally_connector, and
        # codesign only INSIDE a function (the self-update signature gate).
        # PyInstaller's static analysis can miss a deferred import, and the
        # failure mode is silent: the gate catches ImportError and downgrades to
        # the hash check, so an unverified update would install with nothing in
        # the log to say the check never ran.
        "--hidden-import",
        "tally_schema",
        "--hidden-import",
        "tally_control",
        "--hidden-import",
        "codesign",
        # The served-UI path. shell imports pywebview lazily and bridge_handlers
        # imports sync_agent inside a function, so static analysis misses both —
        # and the failure is silent: --ui=web would fall back to tkinter with
        # nothing saying why.
        "--hidden-import",
        "ui_theme",
        "--hidden-import",
        "ui_signin",
        "--hidden-import",
        "ui_splash",
        "--hidden-import",
        "ui_dashboard",
        "--hidden-import",
        "local_bridge",
        "--hidden-import",
        "bridge_handlers",
        "--hidden-import",
        "shell",
        "--hidden-import",
        "envelope_store",
    ]
    # ── SIZE ──────────────────────────────────────────────────────────────
    # PyInstaller collects whatever is importable, not what is reachable, so an
    # optional dependency costs full price. Measured on a real build, these
    # accounted for ~11 MB of a 25 MB exe:
    #
    #   _avif.pyd        7.5 MB   AVIF image codec
    #   _webp.pyd        0.4 MB   WebP codec
    #   _imagingcms.pyd  0.3 MB   ICC colour management
    #
    # Pillow is here only so pystray can load a .ico for the tray icon. That
    # needs PIL's core; it does not need AVIF, WebP or colour profiles, and it
    # certainly does not need them at eight megabytes. Excluding the codecs
    # keeps the tray icon and drops the weight.
    #
    # The rest are development-time modules that ship by accident.
    for _unused in (
        "PIL._avif", "PIL.AvifImagePlugin",
        "PIL._webp", "PIL.WebPImagePlugin",
        "PIL._imagingcms", "PIL.ImageCms",
        "PIL.ImageQt", "PIL.ImageShow", "PIL.ImageTk",
        "unittest", "doctest", "pydoc", "pdb",
        "lib2to3", "tkinter.test",
        # NOT excluded: distutils / setuptools. pythonnet (pulled in by
        # pywebview) imports them at build time, and excluding one PyInstaller
        # has already resolved fails the whole build rather than just dropping
        # it. They are small; the codecs above were the real weight.
        # Never imported by the agent; each drags its own extension module.
        "numpy", "pandas", "matplotlib", "scipy",
        "sqlite3", "bz2", "curses",
        # pyca/cryptography — 5.8 MB of OpenSSL (libcrypto-3.dll + libssl-3.dll)
        # for a code path this build never takes. config.py imports AESGCM inside
        # a try/except purely as an ACCELERATION; the stdlib HMAC-keystream
        # cipher below it is always available and is what the shipped exe
        # actually uses (see the comment on _CRED_MAGIC). Carrying OpenSSL for an
        # optional fast path costs more than the fast path is worth: with
        # --onefile every megabyte is decompressed AND antivirus-scanned on EVERY
        # launch, which is what made startup 8-13 seconds.
        "cryptography",
    ):
        cmd += ["--exclude-module", _unused]
    # Brand icon for BOTH the exe FILE icon (--icon) and the running window /
    # taskbar icon (bundled via --add-data so gui_agent iconbitmaps it at
    # runtime) — so the file icon and the app-window icon are the SAME.
    icon_ico = here / "app_icon.ico"
    if icon_ico.exists():
        cmd += ["--icon", str(icon_ico), "--add-data", str(icon_ico) + ";."]
    # SPLASH — shown by the bootloader IMMEDIATELY, before Python even starts.
    #
    # --onefile unpacks ~46 MB of files to a fresh temp folder on EVERY launch,
    # and because the folder name is new each time, antivirus rescans all of it
    # each time. Measured on a normal desktop that is ~6 seconds during which
    # NOTHING appears on screen: the customer double-clicks, sees nothing, and
    # double-clicks again — which the single-instance guard then has to explain.
    #
    # The splash does not make it faster; it makes it honest. It is drawn by the
    # C bootloader, so it appears in well under a second regardless of how slow
    # the unpack is, and gui_agent closes it the moment the real window is up
    # (see _close_splash there).
    splash_png = here / "splash.png"
    # NO --splash. The bootloader's splash cannot be turned off per launch: it
    # is drawn by the C loader before any Python runs, so it appeared on EVERY
    # start — including the daily one where the customer just wants their
    # Dashboard. The loading screen now belongs to the app (ui_splash), which
    # shows it only on a first run, when there is genuinely something to wait
    # for. The picture is still bundled as data below, because that is what
    # ui_splash draws.
    # The sign-in window's left illustration. Bundled the same way as the icon
    # so ui_signin.asset() finds it in _MEIPASS; if it is ever missing the pane
    # still renders (wordmark on a wash), because a decoration must never be the
    # reason somebody cannot sign in.
    side_png = here / "login_side.png"
    if gui and side_png.exists():
        cmd += ["--add-data", str(side_png) + ";."]
    # splash.png a SECOND time, as data. --splash embeds it in the bootloader's
    # own resource, which Python cannot read back — and ui_splash reopens the
    # same picture to animate the progress bar over it. Without this the frozen
    # build silently loses the animated splash (asset() finds nothing, show()
    # returns None) and the customer is left looking at the static one.
    if gui and splash_png.exists():
        cmd += ["--add-data", str(splash_png) + ";."]
    if gui:
        # No console window for the windowed GUI. The GUI also imports the engine
        # entry point (sync_agent) + the new constants/win_service modules, so
        # collect them explicitly. tkinter is bundled by PyInstaller
        # automatically; pystray/Pillow are optional + guarded so they are NOT
        # required (and not force-collected here).
        cmd += [
            "--windowed",
            "--hidden-import", "sync_agent",
            # constants.py is a NEW module imported by config; it is collected
            # automatically as a direct import, but pin it for safety.
            "--hidden-import", "constants",
            # win_service.py + the pywin32 modules it uses. The SAME exe runs as
            # the Windows service via --run-service, so these MUST be bundled.
            "--hidden-import", "win_service",
            "--hidden-import", "win32timezone",
            "--hidden-import", "win32serviceutil",
            "--hidden-import", "win32service",
            "--hidden-import", "win32event",
            "--hidden-import", "servicemanager",
            "--hidden-import", "win32api",
            "--hidden-import", "win32con",
            # win32security: needed by win_service.grant_service_control_to_users
            # to add the no-UAC start/stop ACE to the service DACL at install.
            "--hidden-import", "win32security",
            "--hidden-import", "pywintypes",
            "--hidden-import", "pythoncom",
        ]
    cmd.append(str(here / entry))

    print("Running:", " ".join(cmd))
    try:
        result = subprocess.run(cmd, cwd=str(here), check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"Build failed to start: {exc}")
        return 1

    if result.returncode != 0:
        print(f"PyInstaller exited with code {result.returncode}.")
        return result.returncode

    exe = here / "dist" / f"{app_name}.exe"
    if exe.exists():
        print(f"\nBuild complete: {exe}")
        # Place a starter config next to the exe for convenience.
        example = here / "config.example.ini"
        if example.exists():
            try:
                shutil.copy2(example, here / "dist" / "config.example.ini")
                print(f"Copied config.example.ini next to the exe.")
            except OSError:
                pass
        if gui:
            print("\nThis is the self-installing GUI. Run TallyCloudSync.exe,")
            print("      sign in with email + password, then enter the emailed code.")
        else:
            print("\nNext: copy config.example.ini -> config.ini beside the exe,")
            print("      set api_url + license_key, then run the exe once to activate.")
        if sign and not _sign_artifact(exe, thumbprint):
            return 1
        if self_sign and not _self_sign_artifact(exe):
            return 1
        # AFTER signing, always. Signing rewrites the file, so a digest taken
        # before it describes a binary nobody will ever download — and the
        # customer who actually checks would be the one told their copy is
        # tampered with.
        _write_checksum(exe)
    else:
        print("Build reported success but the exe was not found.")
        return 1

    return 0


_LOCAL_HOST_RE = re.compile(
    r"^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1"
    r"|10\.\d+\.\d+\.\d+"
    r"|192\.168\.\d+\.\d+"
    r"|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+"
    r"|.*\.local)$", re.I)


def _baked_url_problems() -> list[str]:
    """Reasons the URLs baked into this build are not fit to ship.

    WHY THIS CHECK EXISTS: ``API_BASE_URL`` and ``AGENT_UI_URL`` are baked into
    the exe ON PURPOSE and are NEVER read from config.ini — a customer
    repointing their agent at another server is not a feature. The cost of that
    decision is that a wrong URL cannot be fixed in the field: every installed
    agent talks to an address that does not exist for it, and the only remedy is
    a new exe to every customer.

    A developer's LAN IP is exactly how that happens. It is the value that makes
    local testing work, so it is the value that is in the file most of the time,
    and the comment above it can say "LIVE build" while the value says
    192.168.x.x — which is what it did say when this check was written.

    So the build refuses. Not a warning: a warning next to a successful build is
    read as success.
    """
    problems: list[str] = []
    try:
        import constants                                  # noqa: PLC0415
    except Exception as exc:                              # noqa: BLE001
        return [f"could not import constants.py ({exc})"]

    from urllib.parse import urlparse                     # noqa: PLC0415
    for name in ("API_BASE_URL", "AGENT_UI_URL"):
        raw = str(getattr(constants, name, "") or "").strip()
        if not raw:
            problems.append(f"{name} is empty")
            continue
        parsed = urlparse(raw)
        host = (parsed.hostname or "").strip()
        if not host:
            problems.append(f"{name} has no host: {raw!r}")
            continue
        if _LOCAL_HOST_RE.match(host):
            problems.append(
                f"{name} points at a local/private address ({host}) — "
                f"customers cannot reach it: {raw!r}")
        elif parsed.scheme != "https":
            # Plain http to a public host means agent tokens cross the internet
            # in clear. Worth stopping a release for, and trivial to fix.
            problems.append(f"{name} is not https: {raw!r}")
    return problems


def main(argv: list[str] | None = None) -> int:
    """CLI: optionally stamp a release version, then build the exe(s).

    Usage:
        python build_exe.py                  Build the CONSOLE agent exe.
        python build_exe.py --gui            Build the WINDOWED GUI exe.
        python build_exe.py --both           Build BOTH exes.
        python build_exe.py --version 1.0.1  Stamp v1.0.1 into config, then build.

    ``--gui`` produces ``dist/TallyCloudSync.exe`` (the self-installing tkinter
    app, no console window); the default still produces
    ``dist/TallyCloudSyncAgent.exe`` (the headless console agent). After
    building, the operator drops the exe into the server's AGENT_RELEASE_DIR and
    publishes its version (POST /super-admin/agent-release) so agents
    auto-update to it.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    version = None
    gui = "--gui" in args
    both = "--both" in args
    nuitka = "--nuitka" in args
    sign = "--sign" in args
    # The free path: compiled + self-signed + a published checksum. Everything a
    # release needs except a publicly-trusted certificate, which cannot be had
    # for free at any CA.
    self_sign = "--self-sign" in args
    # --release is the shorthand that should be used to cut an actual release:
    # compiled (no extractable source) AND signed. Spelling both out every time
    # is how one of them eventually gets forgotten.
    if "--release" in args:
        nuitka = sign = True
    if "--free-release" in args:
        nuitka = self_sign = True
    thumbprint = None
    i = 0
    while i < len(args):
        if args[i] in ("--version", "-v") and i + 1 < len(args):
            version = args[i + 1].strip()
            i += 2
            continue
        if args[i] == "--thumbprint" and i + 1 < len(args):
            thumbprint = args[i + 1].strip()
            i += 2
            continue
        i += 1

    # A RELEASE must not carry a dev URL. Dev builds may (that is what they are
    # for), so the gate is on the release flags, not on every build.
    is_release = ("--release" in args) or ("--free-release" in args)
    if is_release and "--allow-local-url" not in args:
        problems = _baked_url_problems()
        if problems:
            print("REFUSING TO BUILD A RELEASE — constants.py is not "
                  "production-ready:")
            for p in problems:
                print("  * " + p)
            print("\nFix agent/constants.py, or pass --allow-local-url if you "
                  "really mean to ship this (an internal pilot on a VPN, say).")
            return 1

    if version:
        if not re.match(r"^\d+(\.\d+){0,3}([.\-].+)?$", version):
            print(f"Refusing to stamp a non-version-looking value: {version!r}")
            return 1
        _stamp_version(version)
    elif "--no-bump" not in args:
        # EVERY BUILD GETS A NEW VERSION unless one is named or bumping is
        # explicitly declined.
        #
        # Two builds that share a version are indistinguishable to everything
        # downstream: the installed agent compares versions to decide whether an
        # update exists, so a rebuilt-but-same-numbered exe reports "already up
        # to date" and refuses to install itself. Every test of the update path
        # then had to be done by hand-uninstalling first, and a customer running
        # the new file would simply be told there was nothing to do.
        #
        # Bumping by default makes the artifact honest: a different binary is a
        # different version. Use --version to set one deliberately for a
        # release, or --no-bump to rebuild the same one on purpose.
        version = _next_version(_current_version())
        print(f"Auto-bumping version -> {version}  (use --version X.Y.Z to set "
              f"one, or --no-bump to keep the current)")
        _stamp_version(version)

    if both:
        rc = build(gui=False, nuitka=nuitka, sign=sign, thumbprint=thumbprint,
                   self_sign=self_sign)
        if rc != 0:
            return rc
        return build(gui=True, nuitka=nuitka, sign=sign, thumbprint=thumbprint,
                     self_sign=self_sign)
    return build(gui=gui, nuitka=nuitka, sign=sign, thumbprint=thumbprint,
                 self_sign=self_sign)


if __name__ == "__main__":
    sys.exit(main())
