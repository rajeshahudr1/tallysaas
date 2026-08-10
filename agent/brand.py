"""agent/brand.py

SINGLE SOURCE OF TRUTH for the product brand (name + colours) inside the
Windows desktop agent. Change it HERE and it updates everywhere: the splash
screen, the sign-in / dashboard windows, the tray icon tooltip, and any
installer/build strings that reference the product name.

To rebrand:
    * NAME / SHORT_NAME / TAGLINE / COLOR -> edit the constants below.
    * the splash / sign-in art            -> replace login_side.png / splash.png.
    * the app icon                        -> replace app_icon.ico.

This is ONE of FOUR brand files -- one per runtime, because they can't share
code: this one, web/config/brand.js, api/config/brand.js, and
app/lib/core/brand.dart. They must all agree. api/tests/brandConsistency.test.js
pins name/tagline across all four and fails loudly if one is changed without
the others.
"""

# Full product name shown in window titles and the tray.
NAME = "Teloora"

# Compact form for tight spaces.
SHORT_NAME = "Teloora"

# One-line description.
TAGLINE = "Connected Accounting"

# Primary accent (matches web/config/brand.js color). One knob for the brand colour.
COLOR = "#1560E0"

# ── Windows identity ─────────────────────────────────────────────────
# SLUG is the filesystem/registry-safe name every Windows artefact is built
# from: the exe, the Windows service, the startup .vbs, the install folder and
# the HKCU key. Change SLUG and a REBUILT agent installs itself under the new
# identity end to end -- but an install made by an OLDER build keeps the old
# name, so bumping this means the customer uninstalls the old agent and runs
# the new exe once. That is deliberate: the alternative is a rename that
# silently orphans a running service.
SLUG = "Teloora"

# The windowed (primary) build, the headless console build, and the publisher
# shown in the exe's Properties dialog.
GUI_EXE_NAME = SLUG                 # -> Teloora.exe
CONSOLE_EXE_NAME = SLUG + "Agent"   # -> TelooraAgent.exe
PUBLISHER = "Dukansetu"

# Full brand palette -- the logo's blue->green gradient and its deep navy
# wordmark colour. Used by the GUI theme (ui_theme.py) and any drawn assets.
COLORS = {
    "navy": "#17265E",
    "blue": "#1560E0",
    "green": "#45B649",
    "gradient": ("#1560E0", "#45B649"),  # start, end -- for gradient brushes
}
