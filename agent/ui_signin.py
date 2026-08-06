"""The sign-in shell: the two-pane window the customer meets first.

WHY THIS IS NOT ttk
-------------------
The rest of the app is a ledger — hairlines, square corners, mono figures — and
ttk renders that well. The sign-in window is the one screen that has to sell
before it informs: it is the first thing a customer sees, often before they have
decided the product is real. That look (a soft product panel on the left, a
rounded card with pill inputs and a gradient action on the right) is exactly what
ttk cannot draw: it has no corner radius, no gradient, and no way to put an icon
inside an entry.

So this screen is drawn on a ``tk.Canvas``. Rounded rectangles are arcs and
rectangles, the button gradient is one vertical line per column clipped to the
corner radius, and the real ``tk.Entry`` widgets are embedded into the drawing
with ``create_window``. Everything the customer types is still a normal Tk
widget — only the surface under it is painted.

The left panel is a PNG (``login_side.png``), because an illustration is an
illustration: painting it in canvas primitives would be a worse picture and a
thousand more lines. It is rendered at 420x600 and shown 1:1, so it must never
be scaled.

USAGE
-----
    shell = ui_signin.Shell(root)          # sizes + centres the window
    shell.side()                           # left illustration pane
    p = shell.panel()                      # right pane, a Panel
    p.card_header("Connect this computer", "Sign in to ...")
    email = p.field("Email Address", var, icon="mail")
    p.primary("Connect to Cloud Securely", command=...)
"""

from __future__ import annotations

import os
import sys
import tkinter as tk
import tkinter.font as tkfont

import brand

# --------------------------------------------------------------------------- #
# Palette. Cloud-blue, deliberately NOT the ledger ink: this screen is the
# product's face, the dashboard behind it is the product's instrument.
# BLUE is pulled from agent/brand.py so the sign-in screen matches the logo.
# --------------------------------------------------------------------------- #
BLUE        = brand.COLORS["blue"]
BLUE_DEEP   = "#1d4ed8"
BLUE_LIGHT  = "#3b82f6"
BLUE_WASH   = "#eff5ff"
BLUE_TINT   = "#e8f0fe"
INK         = "#0f2d52"   # headings
BODY        = "#41597a"   # body copy, labels
MUTED       = "#7d93b0"
LINE        = "#e3eaf4"
FIELD_LINE  = "#d7e0ee"
WHITE       = "#ffffff"
GREEN       = "#16a34a"

FACE = "Segoe UI"

WIDTH    = 1000
HEIGHT   = 600
SIDE_W   = 420
PANEL_W  = WIDTH - SIDE_W


# THE app icon. Every window in the product — main window, splash, and every
# dialog — takes its title-bar/taskbar icon from this ONE name via
# ``apply_icon``. Change the file (or this line) and every window follows;
# there is deliberately no second place that names an icon, because the way
# these drift apart is somebody adding a window and picking their own.
ICON_FILE = "app_icon.ico"


def asset(name: str) -> str:
    """Path to a bundled image, frozen or from source.

    Mirrors ``gui_agent.icon_path``: PyInstaller's extract dir first, then the
    exe dir, then the source tree, so the same picture shows in every mode.
    """
    for base in (getattr(sys, "_MEIPASS", None),
                 os.path.dirname(os.path.abspath(sys.executable))
                 if getattr(sys, "frozen", False) else None,
                 os.path.dirname(os.path.abspath(__file__))):
        if not base:
            continue
        p = os.path.join(base, name)
        if os.path.isfile(p):
            return p
    return ""


def apply_icon(win) -> None:
    """Give ``win`` the product icon. The single place any window gets one.

    Silent on failure: a window without its icon is a cosmetic loss, and a
    dialog that refuses to open because an .ico is missing is not.
    """
    try:
        path = asset(ICON_FILE)
        if path:
            win.iconbitmap(path)
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# Canvas primitives
# --------------------------------------------------------------------------- #
def round_rect(cv: tk.Canvas, x1, y1, x2, y2, r, **kw):
    """A rounded rectangle as one smoothed polygon.

    ``create_polygon(smooth=1)`` is used rather than four arcs plus two
    rectangles: it is a single item, so it can be raised, deleted and recoloured
    as one thing, and it fills without the hairline seams the arc method leaves.
    """
    pts = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2,
           x2 - r, y2, x1 + r, y2, x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]
    return cv.create_polygon(pts, smooth=True, splinesteps=18, **kw)


def _mix(a: str, b: str, t: float) -> str:
    """Blend two #rrggbb colours. Used only for the button gradient."""
    ar, ag, ab = int(a[1:3], 16), int(a[3:5], 16), int(a[5:7], 16)
    br, bg, bb = int(b[1:3], 16), int(b[3:5], 16), int(b[5:7], 16)
    return "#%02x%02x%02x" % (round(ar + (br - ar) * t),
                              round(ag + (bg - ag) * t),
                              round(ab + (bb - ab) * t))


def gradient_rect(cv: tk.Canvas, x1, y1, x2, y2, r, c1, c2, tag):
    """A horizontal gradient inside a rounded rectangle.

    One 1px vertical line per column, each inset at the top and bottom by the
    circle equation so the corners stay round. Tk has no gradient primitive and
    no clipping, so the shape has to be cut column by column.
    """
    h = y2 - y1
    for x in range(int(x1), int(x2) + 1):
        # How far this column is inside a corner, if at all.
        dx = 0.0
        if x < x1 + r:
            dx = (x1 + r) - x
        elif x > x2 - r:
            dx = x - (x2 - r)
        inset = 0.0
        if dx > 0:
            inset = r - (max(0.0, r * r - dx * dx)) ** 0.5
        if inset >= h / 2:
            continue
        t = (x - x1) / max(1.0, (x2 - x1))
        cv.create_line(x, y1 + inset, x, y2 - inset + 1,
                       fill=_mix(c1, c2, t), tags=tag)


# --------------------------------------------------------------------------- #
# Icons. Small, drawn — not a font. An icon font would be one more thing that
# can be missing on a customer's machine, and these are six shapes.
# --------------------------------------------------------------------------- #
def icon(cv: tk.Canvas, name: str, x, y, color=MUTED, size=16, tag=None):
    """Draw ``name`` centred on (x, y). ``size`` is the box, not the stroke."""
    s = size / 2.0
    t = {"tags": tag} if tag else {}
    w = max(1, round(size / 11))

    if name == "mail":
        cv.create_rectangle(x - s, y - s * 0.72, x + s, y + s * 0.72,
                            outline=color, width=w, **t)
        cv.create_line(x - s, y - s * 0.72, x, y + s * 0.12, x + s, y - s * 0.72,
                       fill=color, width=w, **t)
    elif name == "lock":
        cv.create_rectangle(x - s * 0.78, y - s * 0.1, x + s * 0.78, y + s * 0.8,
                            outline=color, width=w, **t)
        cv.create_arc(x - s * 0.5, y - s * 0.9, x + s * 0.5, y + s * 0.2,
                      start=0, extent=180, style="arc", outline=color, width=w, **t)
    elif name == "eye":
        cv.create_oval(x - s, y - s * 0.62, x + s, y + s * 0.62,
                       outline=color, width=w, **t)
        cv.create_oval(x - s * 0.3, y - s * 0.3, x + s * 0.3, y + s * 0.3,
                       outline=color, width=w, **t)
    elif name == "eye-off":
        cv.create_oval(x - s, y - s * 0.62, x + s, y + s * 0.62,
                       outline=color, width=w, **t)
        cv.create_line(x - s * 0.9, y + s * 0.7, x + s * 0.9, y - s * 0.7,
                       fill=color, width=w, **t)
    elif name == "shield":
        cv.create_polygon(x, y - s, x + s * 0.85, y - s * 0.6,
                          x + s * 0.85, y + s * 0.1, x, y + s,
                          x - s * 0.85, y + s * 0.1, x - s * 0.85, y - s * 0.6,
                          fill=color, outline=color, **t)
    elif name == "shield-check":
        cv.create_polygon(x, y - s, x + s * 0.85, y - s * 0.6,
                          x + s * 0.85, y + s * 0.1, x, y + s,
                          x - s * 0.85, y + s * 0.1, x - s * 0.85, y - s * 0.6,
                          fill=color, outline=color, **t)
        cv.create_line(x - s * 0.36, y, x - s * 0.08, y + s * 0.3, x + s * 0.42, y - s * 0.34,
                       fill=WHITE, width=max(2, w + 1), capstyle="round",
                       joinstyle="round", **t)
    elif name == "cloud":
        cv.create_oval(x - s, y - s * 0.15, x - s * 0.1, y + s * 0.75,
                       fill=color, outline=color, **t)
        cv.create_oval(x - s * 0.55, y - s * 0.85, x + s * 0.5, y + s * 0.6,
                       fill=color, outline=color, **t)
        cv.create_oval(x + s * 0.05, y - s * 0.25, x + s, y + s * 0.75,
                       fill=color, outline=color, **t)
        cv.create_rectangle(x - s * 0.6, y + s * 0.15, x + s * 0.6, y + s * 0.75,
                            fill=color, outline=color, **t)
    elif name == "upload":
        cv.create_line(x, y + s * 0.55, x, y - s * 0.5, fill=color, width=w + 1,
                       capstyle="round", **t)
        cv.create_line(x - s * 0.45, y - s * 0.05, x, y - s * 0.55, x + s * 0.45, y - s * 0.05,
                       fill=color, width=w + 1, capstyle="round", joinstyle="round", **t)
    elif name == "info":
        cv.create_oval(x - s * 0.8, y - s * 0.8, x + s * 0.8, y + s * 0.8,
                       outline=color, width=w, **t)
        cv.create_line(x, y - s * 0.05, x, y + s * 0.45, fill=color, width=w, **t)
        cv.create_line(x, y - s * 0.42, x, y - s * 0.36, fill=color, width=w + 1, **t)
    elif name == "headset":
        cv.create_arc(x - s * 0.85, y - s * 0.9, x + s * 0.85, y + s * 0.5,
                      start=0, extent=180, style="arc", outline=color, width=w, **t)
        cv.create_rectangle(x - s * 0.9, y - s * 0.15, x - s * 0.5, y + s * 0.6,
                            outline=color, width=w, **t)
        cv.create_rectangle(x + s * 0.5, y - s * 0.15, x + s * 0.9, y + s * 0.6,
                            outline=color, width=w, **t)
    elif name == "doc":
        cv.create_rectangle(x - s * 0.62, y - s * 0.85, x + s * 0.62, y + s * 0.85,
                            outline=color, width=w, **t)
        for i, dy in enumerate((-0.35, 0.0, 0.35)):
            cv.create_line(x - s * 0.34, y + s * dy, x + s * (0.34 if i < 2 else 0.05),
                           y + s * dy, fill=color, width=w, **t)
    elif name == "alert":
        cv.create_polygon(x, y - s, x + s, y + s * 0.85, x - s, y + s * 0.85,
                          fill=color, outline=color, **t)
        cv.create_line(x, y - s * 0.28, x, y + s * 0.26, fill=WHITE,
                       width=max(2, w + 1), capstyle="round", **t)
        cv.create_line(x, y + s * 0.55, x, y + s * 0.58, fill=WHITE,
                       width=max(2, w + 1), capstyle="round", **t)
    elif name == "check":
        cv.create_line(x - s * 0.55, y, x - s * 0.15, y + s * 0.42, x + s * 0.6, y - s * 0.45,
                       fill=color, width=w + 1, capstyle="round", joinstyle="round", **t)
    elif name == "dot":
        cv.create_oval(x - s * 0.45, y - s * 0.45, x + s * 0.45, y + s * 0.45,
                       fill=color, outline=color, **t)


# --------------------------------------------------------------------------- #
# The window shell
# --------------------------------------------------------------------------- #
class Shell:
    """Sizes the window and splits it into the illustration and the panel."""

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self._images = []          # PhotoImage refs; Tk will not hold them
        try:
            root.configure(bg=WHITE)
            root.geometry(f"{WIDTH}x{HEIGHT}")
            root.minsize(WIDTH, HEIGHT)
            # Fixed size: the left pane is a 1:1 PNG and the right pane is drawn
            # at absolute coordinates. Both would have to reflow, and neither
            # gains anything from more room.
            root.resizable(False, False)
            root.update_idletasks()
            x = (root.winfo_screenwidth() - WIDTH) // 2
            y = max(0, (root.winfo_screenheight() - HEIGHT) // 2 - 20)
            root.geometry(f"{WIDTH}x{HEIGHT}+{max(0, x)}+{y}")
        except Exception:
            pass
        self.frame = tk.Frame(root, bg=WHITE)
        self.frame.pack(fill="both", expand=True)

    def side(self) -> tk.Canvas:
        """The left illustration pane.

        If the PNG is missing (a stripped build), the pane still renders — as a
        flat wash with the wordmark. A missing decoration must never be the
        reason somebody cannot sign in.
        """
        cv = tk.Canvas(self.frame, width=SIDE_W, height=HEIGHT, bg=BLUE_WASH,
                       highlightthickness=0, bd=0)
        cv.pack(side="left", fill="y")
        path = asset("login_side.png")
        if path:
            try:
                img = tk.PhotoImage(file=path)
                self._images.append(img)
                cv.create_image(0, 0, image=img, anchor="nw")
                return cv
            except Exception:
                pass
        cv.create_text(SIDE_W // 2, HEIGHT // 2 - 10, text=brand.NAME,
                       font=(FACE, 20, "bold"), fill=INK)
        cv.create_text(SIDE_W // 2, HEIGHT // 2 + 18, text=brand.TAGLINE,
                       font=(FACE, 10), fill=MUTED)
        return cv

    def panel(self) -> "Panel":
        """The right pane: the card the customer actually works in."""
        cv = tk.Canvas(self.frame, width=PANEL_W, height=HEIGHT, bg=WHITE,
                       highlightthickness=0, bd=0)
        cv.pack(side="left", fill="both", expand=True)
        return Panel(cv, self._images)


class Panel:
    """The right-hand card. Every method appends below the last one.

    The layout is a running cursor (``self.y``) rather than absolute
    coordinates, so inserting a row does not mean renumbering the ones under it
    — the same reason the rest of the app uses pack().
    """

    PAD_X = 34                    # card inset from the window edge
    IN_X  = 30                    # content inset from the card edge

    def __init__(self, cv: tk.Canvas, image_refs: list) -> None:
        self.cv = cv
        self._images = image_refs
        self.x1 = self.PAD_X
        self.x2 = PANEL_W - self.PAD_X
        self.cx1 = self.x1 + self.IN_X          # content left edge
        self.cx2 = self.x2 - self.IN_X          # content right edge
        self.y = 0
        self._card_bg = None
        self._entries = []

    # -- the card ---------------------------------------------------------- #
    def card(self, top: int = 26, bottom: int = 74) -> None:
        """Draw the card the content sits on, and start the cursor inside it.

        Drawn first and never resized: the card's height is known because this
        screen's content is known. A card that grew with its content would need
        every item re-tagged and re-drawn on each change, for no visible gain.
        """
        self._card_bg = round_rect(self.cv, self.x1, top, self.x2, HEIGHT - bottom,
                                   16, fill=WHITE, outline=LINE, width=1)
        self.y = top + 28

    def header(self, title: str, subtitle: str, chip: str = "") -> None:
        """Avatar, title, subtitle — and the optional trust chip on the right."""
        y = self.y
        cx = self.cx1 + 26
        self.cv.create_oval(cx - 26, y - 4, cx + 26, y + 48, fill=BLUE_TINT, outline="")
        icon(self.cv, "cloud", cx, y + 18, color=BLUE, size=26)
        # The small green padlock badge: this is a *secure* connection, said in
        # the one place the eye already is.
        self.cv.create_oval(cx + 10, y + 26, cx + 28, y + 44, fill=GREEN, outline=WHITE, width=2)
        icon(self.cv, "lock", cx + 19, y + 35, color=WHITE, size=9)

        tx = cx + 40
        self.cv.create_text(tx, y + 8, text=title, anchor="w",
                            font=(FACE, 16, "bold"), fill=INK)
        self.cv.create_text(tx, y + 33, text=subtitle, anchor="w",
                            font=(FACE, 9), fill=MUTED)

        if chip:
            w, h = 108, 42
            round_rect(self.cv, self.cx2 - w, y + 1, self.cx2, y + 1 + h, 10,
                       fill=BLUE_WASH, outline="")
            icon(self.cv, "shield-check", self.cx2 - w + 20, y + 22, color=BLUE, size=15)
            self.cv.create_text(self.cx2 - w + 36, y + 13, text="256-bit", anchor="w",
                                font=(FACE, 8, "bold"), fill=BLUE)
            self.cv.create_text(self.cx2 - w + 36, y + 29, text="Encryption", anchor="w",
                                font=(FACE, 8, "bold"), fill=BLUE)
        self.y = y + 66

    # -- inputs -------------------------------------------------------------- #
    def field(self, label: str, var: tk.StringVar, *, icon_name: str = "mail",
              placeholder: str = "", secret: bool = False,
              on_return=None, focus: bool = False) -> tk.Entry:
        """One labelled input: pill, leading icon, and (for secrets) an eye.

        Returns the Entry so the caller can bind or focus it. The placeholder is
        real text in a grey face that clears on focus — Tk has no placeholder,
        and a label that vanishes the moment you click is better than a hint the
        customer has to remember.
        """
        self.cv.create_text(self.cx1, self.y, text=label, anchor="w",
                            font=(FACE, 9, "bold"), fill=INK)
        top = self.y + 14
        h = 44
        box = round_rect(self.cv, self.cx1, top, self.cx2, top + h, 10,
                         fill=WHITE, outline=FIELD_LINE, width=1)
        icon(self.cv, icon_name, self.cx1 + 22, top + h / 2, color=MUTED, size=17)

        right_pad = 40 if secret else 14
        entry = tk.Entry(self.cv, textvariable=var, bd=0, highlightthickness=0,
                         bg=WHITE, fg=INK, font=(FACE, 10),
                         insertbackground=BLUE, show="")
        self.cv.create_window(self.cx1 + 44, top + h / 2, anchor="w",
                              window=entry,
                              width=self.cx2 - self.cx1 - 44 - right_pad, height=22)
        self._entries.append(entry)

        # Placeholder + focus ring, both driven off the same two events.
        state = {"empty": True}

        def _show_placeholder():
            if not var.get():
                state["empty"] = True
                entry.configure(fg=MUTED, show="")
                entry.insert(0, placeholder)

        def _on_focus(_e=None):
            if state["empty"] and placeholder:
                entry.delete(0, "end")
                state["empty"] = False
            entry.configure(fg=INK, show="*" if (secret and not eye_state["shown"]) else "")
            self.cv.itemconfigure(box, outline=BLUE, width=2)

        def _on_blur(_e=None):
            self.cv.itemconfigure(box, outline=FIELD_LINE, width=1)
            if not var.get():
                _show_placeholder()

        # A secret field starts MASKED. The placeholder is still readable because
        # _show_placeholder turns masking off while the hint is what is on
        # screen — mask it and the customer reads "•••••••••••••••••" where the
        # word "Password" should be.
        eye_state = {"shown": not secret}
        entry.bind("<FocusIn>", _on_focus)
        entry.bind("<FocusOut>", _on_blur)
        if on_return is not None:
            entry.bind("<Return>", lambda _e: on_return())

        if secret:
            def _toggle(_e=None):
                if state["empty"]:
                    return                      # nothing to reveal but the hint
                eye_state["shown"] = not eye_state["shown"]
                entry.configure(show="" if eye_state["shown"] else "*")
                self.cv.delete("eye")
                icon(self.cv, "eye" if eye_state["shown"] else "eye-off",
                     self.cx2 - 22, top + h / 2, color=MUTED, size=17, tag="eye")
                self.cv.tag_bind("eye", "<Button-1>", _toggle)
            icon(self.cv, "eye", self.cx2 - 22, top + h / 2, color=MUTED,
                 size=17, tag="eye")
            self.cv.tag_bind("eye", "<Button-1>", _toggle)
            hot = self.cv.create_rectangle(self.cx2 - 36, top + 6, self.cx2 - 8, top + h - 6,
                                           outline="", fill="")
            self.cv.tag_bind(hot, "<Button-1>", _toggle)

        if placeholder:
            _show_placeholder()
        if focus:
            entry.focus_set()
            _on_focus()
        self.y = top + h + 18
        return entry

    def value(self, entry: tk.Entry, var: tk.StringVar, placeholder: str) -> str:
        """What the customer actually typed — never the placeholder text."""
        v = var.get()
        return "" if v == placeholder else v

    # -- rows ---------------------------------------------------------------- #
    def check_row(self, text: str, var: tk.BooleanVar, link: str = "",
                  on_link=None, hint: str = "") -> None:
        """The remember-me checkbox, with an optional right-aligned link."""
        y = self.y + 4
        box = round_rect(self.cv, self.cx1, y - 9, self.cx1 + 18, y + 9, 4,
                         fill=WHITE, outline=FIELD_LINE, width=1)
        mark = self.cv.create_line(self.cx1 + 4, y, self.cx1 + 8, y + 4,
                                   self.cx1 + 14, y - 5, fill=WHITE, width=2,
                                   capstyle="round", joinstyle="round")
        label = self.cv.create_text(self.cx1 + 28, y, text=text, anchor="w",
                                    font=(FACE, 9), fill=BODY)

        def _toggle(_e=None):
            var.set(not var.get())
            on = var.get()
            self.cv.itemconfigure(box, fill=BLUE if on else WHITE,
                                  outline=BLUE if on else FIELD_LINE)
            self.cv.itemconfigure(mark, fill=WHITE if on else WHITE,
                                  state="normal" if on else "hidden")
        self.cv.itemconfigure(mark, state="hidden")
        for item in (box, mark, label):
            self.cv.tag_bind(item, "<Button-1>", _toggle)

        if hint:
            end = self.cv.bbox(label)[2]
            icon(self.cv, "info", end + 12, y, color=MUTED, size=14, tag="hintic")

        if link:
            item = self.cv.create_text(self.cx2, y, text=link, anchor="e",
                                       font=(FACE, 9, "bold"), fill=BLUE)
            if on_link:
                self.cv.tag_bind(item, "<Button-1>", lambda _e: on_link())
                self.cv.tag_bind(item, "<Enter>",
                                 lambda _e: self.cv.configure(cursor="hand2"))
                self.cv.tag_bind(item, "<Leave>",
                                 lambda _e: self.cv.configure(cursor=""))
        self.y = y + 26

    def primary(self, text: str, command, icon_name: str = "cloud") -> "Button":
        """The one action on this screen. Gradient, full width, icon + label."""
        btn = Button(self.cv, self.cx1, self.y, self.cx2, self.y + 50, text,
                     command, icon_name)
        self.y += 50 + 18
        return btn

    def divider(self, word: str = "OR") -> None:
        y = self.y
        mid = (self.cx1 + self.cx2) / 2
        self.cv.create_line(self.cx1, y, mid - 22, y, fill=LINE)
        self.cv.create_line(mid + 22, y, self.cx2, y, fill=LINE)
        self.cv.create_oval(mid - 17, y - 17, mid + 17, y + 17, fill=WHITE, outline=LINE)
        self.cv.create_text(mid, y, text=word, font=(FACE, 8, "bold"), fill=MUTED)
        self.y = y + 30

    def link_line(self, text: str, link: str, on_link=None) -> None:
        """A centred "question + action" line, e.g. Don't have an account?"""
        y = self.y
        f = tkfont.Font(family=FACE, size=9)
        fb = tkfont.Font(family=FACE, size=9, weight="bold")
        total = f.measure(text) + 8 + fb.measure(link)
        mid = (self.cx1 + self.cx2) / 2
        x = mid - total / 2
        self.cv.create_text(x, y, text=text, anchor="w", font=(FACE, 9), fill=BODY)
        item = self.cv.create_text(x + f.measure(text) + 8, y, text=link, anchor="w",
                                   font=(FACE, 9, "bold"), fill=BLUE)
        if on_link:
            self.cv.tag_bind(item, "<Button-1>", lambda _e: on_link())
            self.cv.tag_bind(item, "<Enter>", lambda _e: self.cv.configure(cursor="hand2"))
            self.cv.tag_bind(item, "<Leave>", lambda _e: self.cv.configure(cursor=""))
        self.y = y + 26

    def notice(self, lines) -> None:
        """The blue explainer panel: what happens after you press the button."""
        if isinstance(lines, str):
            lines = [lines]
        h = 26 + 17 * len(lines)
        top = self.y
        round_rect(self.cv, self.cx1, top, self.cx2, top + h, 10,
                   fill=BLUE_WASH, outline="")
        icon(self.cv, "shield-check", self.cx1 + 22, top + h / 2, color=BLUE, size=17)
        ty = top + 15
        for line in lines:
            self.cv.create_text(self.cx1 + 42, ty, text=line, anchor="w",
                                font=(FACE, 9), fill="#1e4b8f")
            ty += 17
        self.y = top + h + 14

    def status(self) -> "Status":
        """One replaceable line under the card content. See Status."""
        item = self.cv.create_text(self.cx1, self.y, text="", anchor="w",
                                   font=(FACE, 9), fill=MUTED,
                                   width=self.cx2 - self.cx1)
        self.y += 22
        return Status(self.cv, item)

    def text(self, s: str, *, size=9, bold=False, fill=BODY, gap=20, anchor="w"):
        x = self.cx1 if anchor == "w" else (self.cx1 + self.cx2) / 2
        item = self.cv.create_text(x, self.y, text=s, anchor=anchor,
                                   font=(FACE, size, "bold" if bold else "normal"),
                                   fill=fill, width=self.cx2 - self.cx1)
        self.y += gap
        return item

    def gap(self, n: int) -> None:
        self.y += n

    # -- footer -------------------------------------------------------------- #
    def footer(self, support: str, on_support=None, version: str = "",
               state_text: str = "", on_quit=None, quit_text: str = "Quit",
               policy=None) -> None:
        """Help, policy, version — pinned below the card.

        Somebody stuck on this screen cannot get into the product to find help,
        so the help has to be on the screen that is blocking them.
        """
        y = HEIGHT - 40
        icon(self.cv, "headset", self.cx1 + 8, y, color=MUTED, size=16)
        f = tkfont.Font(family=FACE, size=9)
        self.cv.create_text(self.cx1 + 24, y, text="Need Help?", anchor="w",
                            font=(FACE, 9), fill=BODY)
        item = self.cv.create_text(self.cx1 + 24 + f.measure("Need Help?") + 8, y,
                                   text=support, anchor="w",
                                   font=(FACE, 9, "bold"), fill=BLUE)
        if on_support:
            self.cv.tag_bind(item, "<Button-1>", lambda _e: on_support())

        x = self.cx2
        if state_text:
            self.cv.create_text(x, y, text=state_text, anchor="e",
                                font=(FACE, 9), fill=GREEN)
            x -= tkfont.Font(family=FACE, size=9).measure(state_text) + 8
            icon(self.cv, "dot", x, y, color=GREEN, size=14)
            x -= 16
        if version:
            self.cv.create_text(x, y, text=version, anchor="e",
                                font=(FACE, 9), fill=MUTED)
            x -= tkfont.Font(family=FACE, size=9).measure(version) + 14
            self.cv.create_line(x, y - 7, x, y + 7, fill=LINE)
            x -= 14
        if policy:
            item = self.cv.create_text(x, y, text="Privacy Policy", anchor="e",
                                       font=(FACE, 9), fill=BODY)
            icon(self.cv, "doc", self.cv.bbox(item)[0] - 10, y, color=MUTED, size=15)
            self.cv.tag_bind(item, "<Button-1>", lambda _e: policy())
            self.cv.tag_bind(item, "<Enter>", lambda _e: self.cv.configure(cursor="hand2"))
            self.cv.tag_bind(item, "<Leave>", lambda _e: self.cv.configure(cursor=""))
            x = self.cv.bbox(item)[0] - 32
        if on_quit:
            item = self.cv.create_text(x, y, text=quit_text, anchor="e",
                                       font=(FACE, 9), fill=MUTED)
            self.cv.tag_bind(item, "<Button-1>", lambda _e: on_quit())
            self.cv.tag_bind(item, "<Enter>", lambda _e: self.cv.configure(cursor="hand2"))
            self.cv.tag_bind(item, "<Leave>", lambda _e: self.cv.configure(cursor=""))


class Dialog:
    """The app's own modal alert, in place of tkinter's messagebox.

    WHY NOT messagebox. It is the Win32 MessageBox: a grey 1990s panel with a
    system error icon, dropped on top of a screen that has spent its whole
    budget looking like current software. It is also the ONLY thing on that
    screen the customer cannot read as ours — which matters most exactly when it
    appears, because it appears when something has gone wrong and trust is
    already wobbling.

    Same contract as messagebox so call sites read the same: it is modal, it
    blocks until dismissed, and ``ask`` returns True/False.
    """

    W = 420

    def __init__(self, parent, title: str, message: str, kind: str = "error",
                 ok: str = "OK", cancel: str = "") -> None:
        self.result = False
        lines = _wrap(message, 46)
        h = 150 + 20 * max(0, len(lines) - 1)

        self.win = tk.Toplevel(parent)
        # BUILD IT HIDDEN. A Toplevel is mapped the moment it is created, at
        # whatever default position and size Tk feels like, and every widget
        # added afterwards is painted there — so the customer saw a half-drawn
        # ghost panel flash near the top-left corner before the real dialog
        # appeared centred. It reads as two popups fighting each other. Hidden
        # until it is finished and positioned, it simply appears.
        self.win.withdraw()
        # The TASK BAR / title bar gets the product name; the headline inside
        # gets the actual message. Putting the message in both prints it twice
        # in the same glance.
        self.win.title(brand.NAME)
        apply_icon(self.win)
        self.win.resizable(False, False)
        # transient() BEFORE the window is ever mapped. Setting it afterwards
        # makes Windows rebuild the frame, and a rebuilt frame is unmapped and
        # remapped — which on screen looks exactly like one popup closing and a
        # second one opening in its place.
        try:
            self.win.transient(parent)
        except Exception:
            pass
        try:
            self.win.configure(bg=WHITE)
        except Exception:
            pass

        # Centred on the PARENT, not the screen: a dialog that opens on the other
        # monitor from the window that raised it is a dialog people miss.
        try:
            parent.update_idletasks()
            px, py = parent.winfo_rootx(), parent.winfo_rooty()
            pw, ph = parent.winfo_width(), parent.winfo_height()
            x = px + (pw - self.W) // 2
            y = py + (ph - h) // 3
        except Exception:
            x = y = 200
        self.win.geometry(f"{self.W}x{h}+{max(0, x)}+{max(0, y)}")

        cv = tk.Canvas(self.win, width=self.W, height=h, bg=WHITE,
                       highlightthickness=0, bd=0)
        cv.pack(fill="both", expand=True)

        tone, glyph = {
            "error":   ("#dc2626", "alert"),
            "warning": ("#d97706", "alert"),
            "success": (GREEN, "check"),
            "info":    (BLUE, "info"),
        }.get(kind, (BLUE, "info"))

        cv.create_oval(28, 26, 72, 70, fill=_mix(WHITE, tone, 0.12), outline="")
        icon(cv, glyph, 50, 48, color=tone, size=22)

        cv.create_text(92, 38, text=title, anchor="w",
                       font=(FACE, 12, "bold"), fill=INK)
        ty = 62
        for line in lines:
            cv.create_text(92, ty, text=line, anchor="w", font=(FACE, 9),
                           fill=BODY)
            ty += 20

        cv.create_line(0, h - 62, self.W, h - 62, fill=LINE)
        bx2 = self.W - 24
        self._ok = Button(cv, bx2 - 108, h - 48, bx2, h - 12, ok,
                          lambda: self._close(True), icon_name="")
        if cancel:
            self._cancel = _GhostButton(cv, bx2 - 232, h - 48, bx2 - 120,
                                        h - 12, cancel, lambda: self._close(False))

        self.win.protocol("WM_DELETE_WINDOW", lambda: self._close(False))
        self.win.bind("<Return>", lambda _e: self._close(True))
        self.win.bind("<Escape>", lambda _e: self._close(False))
        # Finished and positioned — now show it, in one step.
        try:
            self.win.update_idletasks()
            self.win.deiconify()
            self.win.grab_set()          # modal: nothing behind it can be used
            self.win.focus_force()
        except Exception:
            pass
        self.win.wait_window()

    def _close(self, result: bool) -> None:
        self.result = result
        try:
            self.win.grab_release()
        except Exception:
            pass
        try:
            self.win.destroy()
        except Exception:
            pass


class _GhostButton:
    """The quiet second action in a dialog: outlined, not filled."""

    def __init__(self, cv, x1, y1, x2, y2, text, command) -> None:
        self.cv = cv
        self.command = command
        self.tag = f"ghost{id(self)}"
        self.box = round_rect(cv, x1, y1, x2, y2, 9, fill=WHITE,
                              outline=FIELD_LINE, width=1, tags=self.tag)
        self.label = cv.create_text((x1 + x2) / 2, (y1 + y2) / 2, text=text,
                                    font=(FACE, 10, "bold"), fill=BODY,
                                    tags=self.tag)
        # Recolour only — see Button for why nothing here may be recreated.
        cv.tag_bind(self.tag, "<Enter>", lambda _e: self._hover(True))
        cv.tag_bind(self.tag, "<Leave>", lambda _e: self._hover(False))
        cv.tag_bind(self.tag, "<ButtonRelease-1>", lambda _e: self.command())

    def _hover(self, on: bool) -> None:
        self.cv.itemconfigure(self.box, fill="#f4f7fc" if on else WHITE,
                              outline=BLUE if on else FIELD_LINE)
        self.cv.itemconfigure(self.label, fill=INK if on else BODY)
        self.cv.configure(cursor="hand2" if on else "")


def _wrap(text: str, width: int) -> list:
    """Wrap a message to ``width`` characters, honouring its own line breaks.

    Server messages arrive as one sentence or as several joined by newlines, and
    both have to land inside a fixed-width dialog without a scrollbar.
    """
    out = []
    for para in str(text or "").splitlines():
        if not para.strip():
            out.append("")
            continue
        line = ""
        for word in para.split():
            if line and len(line) + 1 + len(word) > width:
                out.append(line)
                line = word
            else:
                line = f"{line} {word}".strip()
        out.append(line)
    return out[:8] or [""]


def alert(parent, message: str, *, title: str = "", kind: str = "error") -> None:
    """Show a modal alert. Never raises — an alert that crashes is worse than
    the condition it was reporting."""
    try:
        Dialog(parent, title or _default_title(kind), message, kind=kind)
    except Exception:
        pass


def confirm(parent, message: str, *, title: str = "", ok: str = "Continue",
            cancel: str = "Cancel", kind: str = "warning") -> bool:
    """Modal yes/no. Returns False if the dialog cannot be shown, because every
    caller uses it to gate something destructive."""
    try:
        return Dialog(parent, title or _default_title(kind), message, kind=kind,
                      ok=ok, cancel=cancel).result
    except Exception:
        return False


def _default_title(kind: str) -> str:
    return {"error": "Something went wrong", "warning": "Please confirm",
            "success": "Done", "info": brand.NAME}.get(kind, brand.NAME)


class Status:
    """The single status line. Replaces, never accumulates.

    A failure is shown in red so it does not read like one more progress step —
    the customer must be able to tell "this went wrong" from "this is still
    working" without reading the sentence.
    """

    def __init__(self, cv: tk.Canvas, item) -> None:
        self.cv = cv
        self.item = item

    def set(self, text: str, error: bool = False) -> None:
        try:
            self.cv.itemconfigure(self.item, text=text,
                                  fill="#b91c1c" if error else MUTED)
        except Exception:
            pass


class Button:
    """The gradient primary action, with hover, press and disabled states.

    THE ITEMS ARE CREATED ONCE AND ONLY EVER RECOLOURED. This is not an
    optimisation — it is the difference between a working window and a hung one.
    An earlier version repainted by deleting the tag and rebuilding it, which
    looked harmless: ~500 one-pixel lines redraw instantly.

    But deleting the item under the pointer makes Tk fire <Leave>, and creating
    a new item under the pointer makes it fire <Enter>. With the repaint bound to
    those two events, one mouse-over started a loop that fed itself: Enter →
    repaint → Leave → repaint → Enter, forever, at 100% of a core. The window
    still showed the last frame it had drawn, so it looked like a slow app; it
    was an app whose event loop would never reach another keystroke. It only
    bit once the pointer crossed the button, which is why the window appeared
    healthy right up until somebody tried to use it.

    Recolouring touches no item's existence, so no crossing event is ever
    synthesised and the loop cannot start.
    """

    def __init__(self, cv: tk.Canvas, x1, y1, x2, y2, text, command,
                 icon_name="cloud") -> None:
        self.cv = cv
        self.box = (x1, y1, x2, y2)
        self.text = text
        self.command = command
        self.icon_name = icon_name
        self.state = "normal"
        self.tag = f"btn{id(self)}"
        self._lines = []
        self._icon_items = []
        self._glyph_items = []
        self._label = None
        self._spinner = None          # created on the first busy(), then reused
        self._spin_job = None
        self._angle = 0
        self._build()
        self._paint(BLUE, BLUE_LIGHT)
        cv.tag_bind(self.tag, "<Enter>", self._enter)
        cv.tag_bind(self.tag, "<Leave>", self._leave)
        cv.tag_bind(self.tag, "<Button-1>", self._press)
        cv.tag_bind(self.tag, "<ButtonRelease-1>", self._release)

    # -- construction (runs exactly once) ------------------------------------ #
    def _build(self) -> None:
        x1, y1, x2, y2 = self.box
        gradient_rect(self.cv, x1, y1, x2, y2, 10, BLUE, BLUE_LIGHT, self.tag)
        # The gradient's own lines, in x order — recoloured left-to-right later.
        self._lines = list(self.cv.find_withtag(self.tag))
        mid_y = (y1 + y2) / 2
        start = self._text_start()
        if self.icon_name:
            before = set(self.cv.find_withtag(self.tag))
            icon(self.cv, self.icon_name, start + 11, mid_y, color=WHITE,
                 size=20, tag=self.tag)
            self._icon_items = [i for i in self.cv.find_withtag(self.tag)
                                if i not in before]
            before = set(self.cv.find_withtag(self.tag))
            icon(self.cv, "upload", start + 11, mid_y + 1, color=BLUE,
                 size=11, tag=self.tag)
            self._glyph_items = [i for i in self.cv.find_withtag(self.tag)
                                 if i not in before]
        self._label = self.cv.create_text(self._label_x(), mid_y, text=self.text,
                                          anchor="w", font=(FACE, 11, "bold"),
                                          fill=WHITE, tags=self.tag)

    def _text_start(self) -> float:
        """Left edge of the icon+label group, so the pair reads as centred."""
        x1, _, x2, _ = self.box
        tw = tkfont.Font(family=FACE, size=11, weight="bold").measure(self.text)
        pad = 30 if self.icon_name else 0
        return (x1 + x2) / 2 - (tw + pad) / 2

    def _label_x(self) -> float:
        return self._text_start() + (30 if self.icon_name else 0)

    # -- painting (recolour only) -------------------------------------------- #
    def _paint(self, c1, c2, fg=WHITE) -> None:
        n = max(1, len(self._lines) - 1)
        for i, item in enumerate(self._lines):
            self.cv.itemconfigure(item, fill=_mix(c1, c2, i / n))
        for item in self._icon_items:
            self._recolour(item, fg)
        for item in self._glyph_items:
            # The small arrow punched out of the cloud is the BUTTON's colour,
            # so it has to track the gradient rather than the foreground.
            self._recolour(item, c1)
        if self._label is not None:
            self.cv.coords(self._label, self._label_x(),
                           (self.box[1] + self.box[3]) / 2)
            self.cv.itemconfigure(self._label, text=self.text, fill=fg)

    def _recolour(self, item, colour: str) -> None:
        """Set an item's colour whatever KIND of item it is.

        An icon is a mix of lines (which have `fill` only) and shapes (which
        have both `fill` and `outline`); passing `outline` to a line is a
        TclError, so the option set follows the item type rather than being
        guessed.
        """
        try:
            kind = self.cv.type(item)
        except Exception:
            return
        try:
            if kind in ("oval", "rectangle", "polygon", "arc"):
                self.cv.itemconfigure(item, fill=colour, outline=colour)
            else:
                self.cv.itemconfigure(item, fill=colour)
        except tk.TclError:
            pass

    # -- states -------------------------------------------------------------- #
    def _enter(self, _e=None):
        if self.state == "normal":
            self._paint(BLUE_DEEP, BLUE)
            self.cv.configure(cursor="hand2")

    def _leave(self, _e=None):
        self.cv.configure(cursor="")
        if self.state == "normal":
            self._paint(BLUE, BLUE_LIGHT)

    def _press(self, _e=None):
        if self.state == "normal":
            self._paint("#1a41b8", BLUE_DEEP)

    def _release(self, _e=None):
        # "busy" and "disabled" both mean: this click is not a second job.
        if self.state != "normal":
            return
        self._paint(BLUE_DEEP, BLUE)
        try:
            self.command()
        except Exception:
            pass

    # -- working state ------------------------------------------------------- #
    def busy(self, text: str = "") -> None:
        """Show that the click landed and the work is running.

        A disabled button with the same label on it is not feedback: the
        customer pressed Continue, the colour went slightly pale, and nothing
        else happened for as long as the network took. They press it again.

        The spinner is an ARC whose start angle is stepped — one item, animated
        by reconfiguring it, never by redrawing. See this class's docstring for
        why nothing here may be created or destroyed while the pointer is over
        it.
        """
        if text:
            self.text = text
        self.state = "busy"
        self._paint("#5b8ff0", "#7aa6f5")
        if self._spinner is None:
            x1, y1, x2, y2 = self.box
            # Left of the label, where the icon sits on the idle button.
            cx, cy = self._text_start() + 11, (y1 + y2) / 2
            self._spinner = self.cv.create_arc(cx - 9, cy - 9, cx + 9, cy + 9,
                                               start=0, extent=270, style="arc",
                                               outline=WHITE, width=3,
                                               tags=self.tag)
        for item in self._icon_items + self._glyph_items:
            self.cv.itemconfigure(item, state="hidden")
        self.cv.itemconfigure(self._spinner, state="normal")
        self._spin()

    def _spin(self) -> None:
        if self.state != "busy" or self._spinner is None:
            return
        self._angle = (self._angle - 20) % 360
        try:
            self.cv.itemconfigure(self._spinner, start=self._angle)
            self._spin_job = self.cv.after(40, self._spin)
        except tk.TclError:
            self._spin_job = None

    def _stop_spin(self) -> None:
        if self._spin_job is not None:
            try:
                self.cv.after_cancel(self._spin_job)
            except Exception:
                pass
            self._spin_job = None
        if self._spinner is not None:
            try:
                self.cv.itemconfigure(self._spinner, state="hidden")
            except tk.TclError:
                pass
        for item in self._icon_items + self._glyph_items:
            try:
                self.cv.itemconfigure(item, state="normal")
            except tk.TclError:
                pass

    def configure(self, *, state=None, text=None, command=None) -> None:
        """Mirrors the ttk API the calling code already uses.

        Setting any state other than "busy" also stops the spinner, so callers
        that simply re-enable the button on completion get the idle look back
        without knowing the spinner exists.
        """
        if text is not None:
            self.text = text
        if command is not None:
            self.command = command
        if state is not None:
            self.state = "normal" if state == "normal" else "disabled"
        self._stop_spin()
        if self.state == "normal":
            self._paint(BLUE, BLUE_LIGHT)
        else:
            self._paint("#a9c3ee", "#bcd2f4", fg="#f2f6fd")
