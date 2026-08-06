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

# Full brand palette -- the logo's blue->green gradient and its deep navy
# wordmark colour. Used by the GUI theme (ui_theme.py) and any drawn assets.
COLORS = {
    "navy": "#17265E",
    "blue": "#1560E0",
    "green": "#45B649",
    "gradient": ("#1560E0", "#45B649"),  # start, end -- for gradient brushes
}
