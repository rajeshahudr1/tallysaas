"""Design system for the Teloora agent window.

WHO THIS IS FOR
---------------
An accountant or owner at an Indian SMB, on a back-office Windows PC, with
TallyPrime open all day. The agent sits in the tray beside it. Its single job is
to prove at a glance that the books are mirrored — and when they are not, to say
exactly what broke.

THE DIRECTION: "LEDGER"
-----------------------
The app is dressed as a printed ledger, because that is the material its user
actually works in. Concretely:

  • Hairline rules instead of cards with shadows. A ledger separates rows with a
    printed line, not a floating panel.
  • Zero corner radius. Ruled paper has no rounded corners, and ttk renders
    radius and shadow badly — so the honest look and the well-rendered look are
    the same look here.
  • EVERY figure is monospaced and right-aligned. Columns of numbers that line
    up on the decimal are the whole point of a ledger, and it is what makes a
    wrong number visible without reading it.
  • A deep slate-blue for chrome and primary actions. An earlier version used
    ink-green; it was distinctive but it read as unfamiliar next to the finance
    tools this sits beside, and the owner asked for blue. Distinctiveness here
    now comes from the structure — hairlines, square corners, mono figures —
    rather than from an unusual hue.

The personality is carried by the DATA, not by a decorative display face. That
is also the honest choice for tkinter: no webfonts can be shipped, so a design
that leans on a characterful typeface would degrade to Arial on a machine that
lacks it. Monospaced figures degrade to other monospaced figures.

THE SIGNATURE
-------------
The sync tape: history as an adding-machine tape — hairline-ruled rows, mono
figures flush right, one small stamp chip per row. The order is chronological
because chronology is real information here (what synced, then what broke), not
decoration.

USAGE
-----
    import ui_theme
    ui_theme.apply(root)          # configures every ttk style on the app

Colour names are exported both as tokens (``INK``, ``PAPER``, …) and under the
older ``BRAND``/``BG``/``CARD`` names the existing views already reference, so
the redesign lands without touching 2,700 lines of layout code.
"""

from __future__ import annotations

import tkinter.font as tkfont

from brand import COLORS as _BRAND_COLORS

# --------------------------------------------------------------------------- #
# Colour — ledger materials. Six values, no more; anything that needs a seventh
# is asking for a shade of one of these, not a new hue.
# INK and POSTED are pulled from agent/brand.py (the single source of the
# logo's navy/green) so the desktop app matches the web palette instead of
# drifting from it; the rest of the ledger's neutrals are unaffected.
# --------------------------------------------------------------------------- #
INK        = _BRAND_COLORS["navy"]    # brand navy: chrome, headings, primary actions
INK_DEEP   = _BRAND_COLORS["blue"]    # brand blue: pressed/hover state of INK
PAPER      = "#F4F6F8"   # window background — cool neutral
SHEET      = "#FFFFFF"   # the ruled sheet content sits on
RULE       = "#D8DEE6"   # hairline
TEXT       = "#16202B"   # body
MUTED      = "#3F4C59"   # captions, units, secondary — dark enough to READ on
                         # PAPER (the old #61707F failed on the setup footer:
                         # small text on a light panel simply disappeared).

# Signal colours. Used ONLY for state, never for decoration — an accent that
# appears everywhere stops meaning anything, and these have to be readable as
# "good / attention / wrong" at a glance from across a desk.
STAMP      = "#C07C1E"   # amber — attention, in-progress, the audit stamp
POSTED     = _BRAND_COLORS["green"]   # brand green — synced, reconciled
VARIANCE   = "#B23A2E"   # red — mismatch, failure
STAMP_DIM  = "#FBF0DC"   # amber wash for chip backgrounds
POSTED_DIM = "#E1F0E8"
VARIANCE_DIM = "#F8E4E1"

# --------------------------------------------------------------------------- #
# Type — system faces only. Segoe UI ships on every supported Windows; Consolas
# likewise. Both have sane fallbacks, which a downloaded display face would not.
# --------------------------------------------------------------------------- #
UI_FACE   = "Segoe UI"
DATA_FACE = "Consolas"    # every figure, every id, every timestamp

# A small, deliberate scale. Five sizes: anything that does not fit one of them
# is a sign the hierarchy is wrong, not that the scale needs another step.
SIZE_DISPLAY = 20   # the one number/state the window exists to show
SIZE_TITLE   = 13   # section headings
SIZE_BODY    = 10
SIZE_SMALL   = 9    # captions
SIZE_EYEBROW = 8    # uppercase, letterspaced section labels

FONT_DISPLAY = (UI_FACE, SIZE_DISPLAY, "bold")
FONT_TITLE   = (UI_FACE, SIZE_TITLE, "bold")
FONT_BODY    = (UI_FACE, SIZE_BODY)
FONT_SMALL   = (UI_FACE, SIZE_SMALL)
FONT_EYEBROW = (UI_FACE, SIZE_EYEBROW, "bold")
FONT_DATA    = (DATA_FACE, SIZE_BODY)
FONT_DATA_BIG = (DATA_FACE, SIZE_DISPLAY, "bold")
FONT_DATA_SM = (DATA_FACE, SIZE_SMALL)

# --------------------------------------------------------------------------- #
# Spacing — a 4px base. Named so layout code reads as intent ("SPACE_SECTION")
# rather than as arithmetic ("24").
# --------------------------------------------------------------------------- #
SPACE_HAIR    = 2
SPACE_TIGHT   = 4
SPACE_ITEM    = 8
SPACE_GROUP   = 12
SPACE_BLOCK   = 16
SPACE_SECTION = 24
SPACE_PAGE    = 32

# --------------------------------------------------------------------------- #
# Backwards-compatible aliases. The existing views were written against these
# names; keeping them means the redesign is a theme swap, not a rewrite.
# --------------------------------------------------------------------------- #
BRAND      = INK
BRAND_DEEP = INK_DEEP
BG         = PAPER
CARD       = SHEET
TXT        = TEXT
SUB        = MUTED
BORDER     = RULE
OK_GREEN   = POSTED
BAD_RED    = VARIANCE
WARN_AMBER = STAMP


def letterspace(text: str) -> str:
    """Eyebrow labels, letterspaced by hand.

    tkinter exposes no tracking control, and an uppercase 8pt label set solid is
    an illegible smudge. Inserting thin spaces is the only lever available, so
    the label is spaced at the point of use rather than pretended away.
    """
    return " ".join(text.upper())


def apply(root) -> None:
    """Configure every ttk style used by the app. Safe to call once at startup.

    Wrapped so a themed widget that does not exist on some Tk build cannot stop
    the window from opening — an app that fails to launch because a progress bar
    style was rejected is a far worse outcome than an unstyled progress bar.
    """
    from tkinter import ttk

    try:
        style = ttk.Style(root)
        try:
            # 'clam' is the only stock theme that honours background/border
            # colours on buttons; the Windows native theme silently ignores
            # most of what follows.
            style.theme_use("clam")
        except Exception:
            pass

        root.configure(bg=PAPER)

        # Make the default fonts match the scale, so any widget created without
        # an explicit font still lands inside the system.
        try:
            tkfont.nametofont("TkDefaultFont").configure(family=UI_FACE, size=SIZE_BODY)
            tkfont.nametofont("TkTextFont").configure(family=UI_FACE, size=SIZE_BODY)
            tkfont.nametofont("TkFixedFont").configure(family=DATA_FACE, size=SIZE_BODY)
        except Exception:
            pass

        # ── Base ──────────────────────────────────────────────────────
        style.configure(".", background=PAPER, foreground=TEXT, font=FONT_BODY,
                        borderwidth=0, focuscolor=PAPER)

        # ── Surfaces ──────────────────────────────────────────────────
        style.configure("TFrame", background=PAPER)
        style.configure("Card.TFrame", background=SHEET)
        style.configure("Header.TFrame", background=INK)
        # The hairline. A 1px frame is how a ruled line is drawn when the
        # toolkit has no border primitive worth using.
        style.configure("Rule.TFrame", background=RULE)
        style.configure("RuleStrong.TFrame", background=INK)
        # Accent rule above the active section — the one place amber appears
        # structurally rather than as a status.
        style.configure("Stamp.TFrame", background=STAMP)

        # ── Text ──────────────────────────────────────────────────────
        style.configure("TLabel", background=PAPER, foreground=TEXT, font=FONT_BODY)
        style.configure("Card.TLabel", background=SHEET, foreground=TEXT, font=FONT_BODY)
        style.configure("Sub.TLabel", background=PAPER, foreground=MUTED, font=FONT_SMALL)
        # Failure line on a PAPER panel (setup/status). Same red as every other
        # "wrong" signal, so a failure never reads as one more progress step.
        style.configure("Err.TLabel", background=PAPER, foreground=VARIANCE,
                        font=(UI_FACE, SIZE_SMALL, "bold"))
        style.configure("CardSub.TLabel", background=SHEET, foreground=MUTED, font=FONT_SMALL)
        style.configure("CardBig.TLabel", background=SHEET, foreground=TEXT, font=FONT_DISPLAY)
        style.configure("Header.TLabel", background=INK, foreground="#F3F2ED", font=FONT_TITLE)
        style.configure("HeaderSub.TLabel", background=INK, foreground="#9DB3AC", font=FONT_SMALL)

        # Eyebrow: the small uppercase section label. Muted so it organises the
        # page without competing with the content it introduces.
        style.configure("Eyebrow.TLabel", background=PAPER, foreground=MUTED, font=FONT_EYEBROW)
        style.configure("CardEyebrow.TLabel", background=SHEET, foreground=MUTED, font=FONT_EYEBROW)

        # ── Figures. Monospaced and, wherever a column exists, flush right. ──
        style.configure("Data.TLabel", background=SHEET, foreground=TEXT, font=FONT_DATA)
        style.configure("DataBig.TLabel", background=SHEET, foreground=INK, font=FONT_DATA_BIG)
        style.configure("DataSub.TLabel", background=SHEET, foreground=MUTED, font=FONT_DATA_SM)

        # ── Status. Colour carries the state; the mono face keeps it aligned
        #    with the figures it sits beside. ──
        for name, fg, bg in (("Posted", POSTED, POSTED_DIM),
                             ("Stamp", STAMP, STAMP_DIM),
                             ("Variance", VARIANCE, VARIANCE_DIM)):
            style.configure(f"{name}.TLabel", background=SHEET, foreground=fg,
                            font=(UI_FACE, SIZE_SMALL, "bold"))
            # Chip: the stamped mark on a ledger row. Padding does the work of a
            # background shape, since ttk cannot round or outline one well.
            style.configure(f"{name}Chip.TLabel", background=bg, foreground=fg,
                            font=(UI_FACE, SIZE_EYEBROW, "bold"),
                            padding=(SPACE_ITEM, SPACE_TIGHT))

        # ── Buttons. Flat, square, hairline-bordered. clam draws a bevel from
        #    light/darkcolor, so both are pinned to the border to kill it. ──
        style.configure("TButton", background=SHEET, foreground=INK, font=FONT_BODY,
                        padding=(SPACE_GROUP, SPACE_ITEM), relief="flat", borderwidth=1,
                        # A mid-tone border, not the hairline: at hairline weight
                        # on a bright panel these read as disabled labels rather
                        # than controls.
                        bordercolor="#9FB0C2", lightcolor="#9FB0C2", darkcolor="#9FB0C2",
                        focuscolor=SHEET)
        style.map("TButton",
                  background=[("pressed", "#DCE4EC"), ("active", "#EAF0F6"),
                              ("disabled", "#F7F9FB")],
                  foreground=[("active", INK), ("pressed", INK),
                              ("disabled", "#A8B4C0")],
                  bordercolor=[("active", INK), ("pressed", INK)],
                  lightcolor=[("active", "#EAF0F6"), ("pressed", "#DCE4EC")],
                  darkcolor=[("active", "#EAF0F6"), ("pressed", "#DCE4EC")])

        style.configure("Primary.TButton", background=INK, foreground="#F3F2ED",
                        font=(UI_FACE, SIZE_BODY, "bold"),
                        padding=(SPACE_BLOCK, SPACE_ITEM), borderwidth=0,
                        bordercolor=INK, lightcolor=INK, darkcolor=INK,
                        focuscolor=INK, relief="flat")
        style.map("Primary.TButton",
                  background=[("pressed", INK_DEEP), ("active", INK_DEEP),
                              ("disabled", "#A7B5B0")],
                  foreground=[("active", "#FFFFFF"), ("pressed", "#FFFFFF"),
                              ("disabled", "#E8EDEB")],
                  lightcolor=[("active", INK_DEEP), ("pressed", INK_DEEP)],
                  darkcolor=[("active", INK_DEEP), ("pressed", INK_DEEP)])

        style.configure("Danger.TButton", background=VARIANCE, foreground="#FFFFFF",
                        font=(UI_FACE, SIZE_BODY, "bold"),
                        padding=(SPACE_GROUP, SPACE_ITEM), borderwidth=0,
                        bordercolor=VARIANCE, lightcolor=VARIANCE, darkcolor=VARIANCE,
                        focuscolor=VARIANCE, relief="flat")
        style.map("Danger.TButton",
                  background=[("pressed", "#7F2E22"), ("active", "#7F2E22")],
                  foreground=[("active", "#FFFFFF"), ("pressed", "#FFFFFF"),
                              ("disabled", "#FFFFFF")],
                  lightcolor=[("active", "#7F2E22"), ("pressed", "#7F2E22")],
                  darkcolor=[("active", "#7F2E22"), ("pressed", "#7F2E22")])

        # Quiet tertiary action — reads as a link, for things like "Open log
        # folder" that should be reachable but never compete with the primary.
        style.configure("Quiet.TButton", background=PAPER, foreground=MUTED,
                        font=FONT_SMALL, padding=(SPACE_ITEM, SPACE_TIGHT),
                        relief="flat", borderwidth=0, focuscolor=PAPER)
        style.map("Quiet.TButton",
                  background=[("active", PAPER), ("pressed", PAPER)],
                  foreground=[("active", INK), ("pressed", INK)])

        # ── Tabs: underlined, not raised. A raised tab implies a stack of
        #    panels; an underline implies a position in a set, which is true. ──
        style.configure("TNotebook", background=PAPER, borderwidth=0, tabmargins=0)
        style.configure("TNotebook.Tab", background=PAPER, foreground=MUTED,
                        padding=(SPACE_BLOCK, SPACE_ITEM),
                        font=(UI_FACE, SIZE_BODY), borderwidth=0)
        style.map("TNotebook.Tab",
                  background=[("selected", PAPER), ("active", PAPER)],
                  foreground=[("selected", INK), ("active", INK)],
                  font=[("selected", (UI_FACE, SIZE_BODY, "bold"))])

        # ── Progress: thin, ink-filled. Thickness 4 reads as a rule that is
        #    filling, which is what it is. ──
        style.configure("Brand.Horizontal.TProgressbar", background=INK,
                        troughcolor=RULE, borderwidth=0, thickness=4)
        style.configure("OK.Horizontal.TProgressbar", background=POSTED,
                        troughcolor=RULE, borderwidth=0, thickness=4)
        style.configure("Stamp.Horizontal.TProgressbar", background=STAMP,
                        troughcolor=RULE, borderwidth=0, thickness=4)

        # ── Inputs. Square, hairline; focus is an ink border, not a glow. ──
        style.configure("TEntry", fieldbackground=SHEET, foreground=TEXT,
                        bordercolor=RULE, lightcolor=RULE, darkcolor=RULE,
                        borderwidth=1, relief="solid", padding=SPACE_ITEM,
                        insertcolor=INK)
        style.map("TEntry",
                  bordercolor=[("focus", INK)],
                  lightcolor=[("focus", INK)], darkcolor=[("focus", INK)])
        # A licence key is data, so it is set in the data face — which also makes
        # 0/O and 1/l distinguishable while typing it.
        style.configure("Key.TEntry", fieldbackground=SHEET, foreground=TEXT,
                        bordercolor=RULE, lightcolor=RULE, darkcolor=RULE,
                        borderwidth=1, relief="solid", padding=SPACE_ITEM,
                        insertcolor=INK, font=FONT_DATA)

        style.configure("TCheckbutton", background=PAPER, foreground=TEXT,
                        font=FONT_BODY, padding=(SPACE_HAIR, SPACE_ITEM),
                        indicatorbackground=SHEET, indicatorforeground=INK,
                        bordercolor=MUTED, focuscolor=PAPER,
                        indicatormargin=(0, 2, SPACE_ITEM, 2))
        style.map("TCheckbutton",
                  background=[("active", PAPER)],
                  foreground=[("active", TEXT)],
                  indicatorbackground=[("active", PAPER), ("selected", SHEET)],
                  bordercolor=[("selected", INK), ("active", INK)])

        # ── The tape. Treeview is the only stock widget that gives real
        #    columns, so the sync history is built on it: no grid lines, a
        #    hairline under the header, generous row height. ──
        style.configure("Treeview", background=SHEET, fieldbackground=SHEET,
                        foreground=TEXT, borderwidth=0, rowheight=26,
                        font=FONT_DATA)
        style.configure("Treeview.Heading", background=SHEET, foreground=MUTED,
                        font=FONT_EYEBROW, relief="flat", borderwidth=0,
                        padding=(SPACE_ITEM, SPACE_ITEM))
        style.map("Treeview.Heading", background=[("active", SHEET)])
        style.map("Treeview",
                  background=[("selected", PAPER)],
                  foreground=[("selected", INK)])
    except Exception:
        # A theming failure must never prevent the window from opening.
        pass


def rule(parent, *, color: str = RULE, height: int = 1, **grid):
    """A hairline. The workhorse of this design — used instead of card borders.

    Returns the frame so the caller can pack/grid it however the surrounding
    layout works.
    """
    from tkinter import ttk
    style_name = "RuleStrong.TFrame" if color == INK else (
        "Stamp.TFrame" if color == STAMP else "Rule.TFrame")
    frame = ttk.Frame(parent, style=style_name, height=height)
    frame.pack_propagate(False)
    frame.grid_propagate(False)
    return frame


def chip_style(state: str) -> str:
    """ttk style name for a status chip.

    ``state`` is the domain word, not a colour: callers say what happened and
    the theme decides how it looks, so a state can be recoloured in one place.
    """
    return {
        "synced": "PostedChip.TLabel",
        "ok": "PostedChip.TLabel",
        "syncing": "StampChip.TLabel",
        "pending": "StampChip.TLabel",
        "warning": "StampChip.TLabel",
        "failed": "VarianceChip.TLabel",
        "error": "VarianceChip.TLabel",
    }.get(str(state or "").lower(), "StampChip.TLabel")


def text_style(state: str) -> str:
    """ttk style name for status TEXT (no chip background)."""
    return {
        "synced": "Posted.TLabel",
        "ok": "Posted.TLabel",
        "syncing": "Stamp.TLabel",
        "pending": "Stamp.TLabel",
        "warning": "Stamp.TLabel",
        "failed": "Variance.TLabel",
        "error": "Variance.TLabel",
    }.get(str(state or "").lower(), "Card.TLabel")
