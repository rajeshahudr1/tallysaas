"""The Dashboard's chrome: sidebar, header, pages, and the live sync stepper.

WHAT THIS MODULE IS. Presentation only. It draws the window and exposes a small
set of setters (:meth:`Chrome.set_connection`, :meth:`SyncPage.set_step`, …).
Every decision about WHAT to show — is the service running, did the cycle fail,
how far along is the push — stays in :class:`gui_agent.DashboardView`, which owns
the engine, the service and the config. Splitting it this way is what let the
window be redrawn without touching a line of the sync logic.

THE STEPPER IS NOT DECORATION. Its five steps are the five things a cycle really
does, in the order the engine really does them:

    Preparing      the loop started; licence + heartbeat
    Checking Data  probing Tally, reading which companies are open
    Uploading      Tally -> Cloud, with the engine's own record counts
    Downloading    Cloud -> Tally, likewise
    Finalizing     the cycle closed and the status file was written

They are driven by the events the engine already emits (``started``,
``progress`` with a phase, ``cycle``), so a step lights up because that work
happened — not on a timer. A stepper that advances on its own is a progress bar
that lies, and this screen exists to be believed at a glance.

WHAT IS DELIBERATELY ABSENT. There is no Backup or Restore page and no Pause
button, because the agent has no backup engine and the sync loop has no pause —
only stop and start, which is what those buttons say. A nav item that opens an
empty page is a support call.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk

import ui_signin as U          # palette, icons, canvas primitives, dialogs
import brand

# --------------------------------------------------------------------------- #
# Palette — the sign-in screen's, extended with the surfaces a data screen needs
# --------------------------------------------------------------------------- #
PAGE = "#f4f7fc"          # the window behind the cards
CARD = U.WHITE
LINE = "#e4ebf5"
SIDEBAR = U.WHITE
NAV_ON = "#eaf1fe"        # selected nav row
INK = U.INK
BODY = U.BODY
MUTED = U.MUTED
BLUE = U.BLUE
GREEN = U.GREEN
AMBER = "#d97706"
RED = "#dc2626"
FACE = U.FACE

# Sized to fit a 1366x768 laptop with its taskbar — the machine this actually
# runs on in a back office, not the monitor it was designed on. The window
# resizes, so a bigger screen simply gets more room for the activity table.
WIDTH = 1180
HEIGHT = 660
SIDE_W = 232
RAIL_W = 340

# The five steps, in engine order. ``key`` is what DashboardView passes to
# set_step(); the label is what the customer reads.
STEPS = [
    ("prepare", "Preparing"),
    ("check", "Checking Data"),
    ("upload", "Uploading"),
    ("download", "Downloading"),
    ("finalize", "Finalizing"),
]
STEP_ICONS = {"prepare": "check", "check": "shield", "upload": "upload",
              "download": "cloud", "finalize": "check"}


def card(parent, **pack) -> tk.Frame:
    """A content card: white, hairline border, on the page wash."""
    f = tk.Frame(parent, bg=CARD, highlightbackground=LINE,
                 highlightcolor=LINE, highlightthickness=1, bd=0)
    if pack:
        f.pack(**pack)
    return f


def label(parent, text, *, size=10, bold=False, fg=BODY, bg=CARD, **grid):
    lb = tk.Label(parent, text=text, font=(FACE, size, "bold" if bold else "normal"),
                  fg=fg, bg=bg, anchor="w", justify="left")
    if grid:
        lb.pack(**grid)
    return lb


class Chrome:
    """The window: sidebar + header + a stack of pages.

    Pages are created up front and raised on demand. Building them lazily would
    save nothing measurable here and would mean every setter had to cope with a
    page that does not exist yet.
    """

    def __init__(self, root: tk.Tk, *, on_nav=None) -> None:
        self.root = root
        self.on_nav = on_nav
        self._nav_rows: dict[str, tuple] = {}
        self._current = ""

        try:
            root.configure(bg=PAGE)
            root.minsize(1020, 600)
            root.resizable(True, True)
            # Opened CENTRED at a known size, exactly like the sign-in window.
            # Left to Tk the window inherits whatever geometry the previous view
            # set, so the Dashboard arrived in the sign-in screen's 1000x600
            # box in the top-left corner — a different size and place every time
            # depending on what came before it.
            root.update_idletasks()
            sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
            # Leave a real margin. Sized against the screen rather than clamped
            # to it: on a scaled 1366-wide laptop the old "screen minus 120"
            # produced a window that filled the display edge to edge, so a
            # centred window still read as shoved into a corner.
            w = max(1020, min(WIDTH, int(sw * 0.86)))
            h = max(600, min(HEIGHT, int(sh * 0.86)))
            root.geometry("%dx%d+%d+%d" % (w, h, max(0, (sw - w) // 2),
                                           max(0, (sh - h) // 2 - 16)))
        except Exception:
            pass

        # The settings page is the one place still built from ttk widgets, and
        # ttk's defaults come from the old theme's paper background — which
        # leaves grey boxes sitting on a white card. Repointing them here (and
        # not in ui_theme) keeps the change with the screen that needs it; the
        # sign-in window draws its own controls and is unaffected.
        try:
            st = ttk.Style(root)
            st.configure("TCheckbutton", background=CARD)
            st.map("TCheckbutton", background=[("active", CARD)])
            st.configure("TLabel", background=CARD)
            st.configure("TFrame", background=CARD)
        except Exception:
            pass

        self.outer = tk.Frame(root, bg=PAGE)
        self.outer.pack(fill="both", expand=True)

        self._build_sidebar()
        right = tk.Frame(self.outer, bg=PAGE)
        right.pack(side="left", fill="both", expand=True)
        self._build_header(right)

        self.stack = tk.Frame(right, bg=PAGE)
        self.stack.pack(fill="both", expand=True)
        self.pages: dict[str, tk.Frame] = {}

    # -- sidebar ------------------------------------------------------------ #
    def _build_sidebar(self) -> None:
        side = tk.Frame(self.outer, bg=SIDEBAR, width=SIDE_W)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)
        tk.Frame(self.outer, bg=LINE, width=1).pack(side="left", fill="y")

        brand = tk.Frame(side, bg=SIDEBAR)
        brand.pack(fill="x", padx=18, pady=(18, 22))
        mark = tk.Canvas(brand, width=38, height=38, bg=SIDEBAR,
                         highlightthickness=0, bd=0)
        mark.pack(side="left")
        U.round_rect(mark, 0, 0, 38, 38, 11, fill=BLUE, outline="")
        U.icon(mark, "cloud", 19, 20, color=U.WHITE, size=19)
        txt = tk.Frame(brand, bg=SIDEBAR)
        txt.pack(side="left", padx=(10, 0))
        label(txt, brand.NAME, size=11, bold=True, fg=INK, bg=SIDEBAR,
              anchor="w")
        label(txt, "Desktop Sync Agent", size=8, fg=MUTED, bg=SIDEBAR, anchor="w")

        self.nav_box = tk.Frame(side, bg=SIDEBAR)
        self.nav_box.pack(fill="x")

        # System status sits at the BOTTOM of the sidebar: it is the thing the
        # customer glances at, not the thing they act on.
        self.sysbox = tk.Frame(side, bg="#f7fafd", highlightbackground=LINE,
                               highlightthickness=1)
        self.sysbox.pack(side="bottom", fill="x", padx=14, pady=14)
        label(self.sysbox, "System Status", size=9, bold=True, fg=INK,
              bg="#f7fafd", anchor="w", padx=12, pady=(10, 6))
        # One row per thing that can independently be up or down. They used to
        # be summarised into a single "Connected", which said the cloud was
        # reachable and let the customer read it as "everything is fine" — while
        # Tally was closed and nothing had synced in an hour.
        self._sys_rows: dict[str, tk.Label] = {}
        for key, cap in (("connection", "Cloud"), ("tally", "Tally"),
                         ("agent", "Syncer"), ("service", "Service"),
                         ("last", "Last Sync"), ("next", "Next Sync")):
            row = tk.Frame(self.sysbox, bg="#f7fafd")
            row.pack(fill="x", padx=12, pady=2)
            label(row, cap, size=8, fg=MUTED, bg="#f7fafd", side="left")
            v = tk.Label(row, text="—", font=(FACE, 8, "bold"), fg=BODY,
                         bg="#f7fafd", anchor="e")
            v.pack(side="right")
            self._sys_rows[key] = v
        tk.Frame(self.sysbox, bg="#f7fafd", height=8).pack()

    def add_nav(self, key: str, text: str, icon_name: str) -> None:
        row = tk.Frame(self.nav_box, bg=SIDEBAR, cursor="hand2")
        row.pack(fill="x", padx=10, pady=1)
        cv = tk.Canvas(row, width=22, height=30, bg=SIDEBAR,
                       highlightthickness=0, bd=0)
        cv.pack(side="left", padx=(8, 0))
        ic = U.icon(cv, icon_name, 11, 15, color=MUTED, size=16)
        lb = tk.Label(row, text=text, font=(FACE, 9), fg=BODY, bg=SIDEBAR,
                      anchor="w")
        lb.pack(side="left", padx=(8, 0), pady=6)
        for w in (row, cv, lb):
            w.bind("<Button-1>", lambda _e, k=key: self.select(k))
        self._nav_rows[key] = (row, cv, lb, icon_name)

    def select(self, key: str) -> None:
        if key not in self.pages:
            return
        self._current = key
        for k, (row, cv, lb, icon_name) in self._nav_rows.items():
            on = k == key
            bg = NAV_ON if on else SIDEBAR
            row.configure(bg=bg)
            cv.configure(bg=bg)
            lb.configure(bg=bg, fg=BLUE if on else BODY,
                         font=(FACE, 9, "bold" if on else "normal"))
            # The icon is redrawn rather than recoloured: it is a handful of
            # items on a 22px canvas, and nothing is bound to them, so there is
            # no crossing-event loop to worry about here (see ui_signin.Button).
            cv.delete("all")
            U.icon(cv, icon_name, 11, 15, color=BLUE if on else MUTED, size=16)
        self.pages[key].tkraise()
        if self.on_nav:
            try:
                self.on_nav(key)
            except Exception:
                pass

    def set_system(self, key: str, text: str, colour: str = BODY) -> None:
        row = self._sys_rows.get(key)
        if row is not None:
            row.configure(text=text, fg=colour)

    # -- header -------------------------------------------------------------- #
    def _build_header(self, parent) -> None:
        head = tk.Frame(parent, bg=CARD, height=64)
        head.pack(fill="x")
        head.pack_propagate(False)
        tk.Frame(parent, bg=LINE, height=1).pack(fill="x")

        self.lbl_page = tk.Label(head, text="", font=(FACE, 13, "bold"),
                                 fg=INK, bg=CARD, anchor="w")
        self.lbl_page.pack(side="left", padx=22)

        pill = tk.Frame(head, bg="#eef7f1")
        pill.pack(side="right", padx=22, pady=12)
        self._dot = tk.Canvas(pill, width=14, height=14, bg="#eef7f1",
                              highlightthickness=0, bd=0)
        self._dot.pack(side="left", padx=(10, 6), pady=8)
        self._dot_item = self._dot.create_oval(3, 3, 11, 11, fill=GREEN,
                                               outline="")
        box = tk.Frame(pill, bg="#eef7f1")
        box.pack(side="left", padx=(0, 12))
        self.lbl_conn = tk.Label(box, text="Connecting…", font=(FACE, 9, "bold"),
                                 fg=GREEN, bg="#eef7f1", anchor="w")
        self.lbl_conn.pack(anchor="w")
        self.lbl_conn_sub = tk.Label(box, text="", font=(FACE, 8), fg=MUTED,
                                     bg="#eef7f1", anchor="w")
        self.lbl_conn_sub.pack(anchor="w")
        self._pill = pill

    def set_connection(self, text: str, sub: str, colour: str, wash: str) -> None:
        """The one true statement in the window: are we talking to the cloud."""
        try:
            self._pill.configure(bg=wash)
            for w in self._pill.winfo_children():
                w.configure(bg=wash)
                for c in getattr(w, "winfo_children", lambda: [])():
                    c.configure(bg=wash)
            self._dot.configure(bg=wash)
            self._dot.itemconfigure(self._dot_item, fill=colour)
            self.lbl_conn.configure(text=text, fg=colour)
            self.lbl_conn_sub.configure(text=sub)
        except Exception:
            pass

    # -- pages --------------------------------------------------------------- #
    def add_page(self, key: str, title: str) -> tk.Frame:
        page = tk.Frame(self.stack, bg=PAGE)
        page.place(x=0, y=0, relwidth=1, relheight=1)
        self.pages[key] = page
        page._title = title                                   # noqa: SLF001
        return page

    def page_title(self, key: str) -> str:
        return getattr(self.pages.get(key), "_title", "")


class Stepper:
    """The five-stage strip. Steps go done / active / pending, never backwards
    inside a cycle — a step that un-completes reads as an error even when the
    truth is just "the next cycle started"."""

    R = 17

    def __init__(self, parent) -> None:
        self.cv = tk.Canvas(parent, height=86, bg=CARD, highlightthickness=0, bd=0)
        self.cv.pack(fill="x", padx=6)
        self.items: dict[str, dict] = {}
        self._built = False
        self.cv.bind("<Configure>", lambda _e: self._build())

    def _build(self) -> None:
        w = self.cv.winfo_width()
        if w < 50:
            return
        self.cv.delete("all")
        self.items.clear()
        n = len(STEPS)
        gap = w / n
        for i, (key, text) in enumerate(STEPS):
            cx = gap * (i + 0.5)
            if i:                                   # the connector behind
                self.items.setdefault("_lines", {})
                ln = self.cv.create_line(gap * (i - 0.5) + self.R + 4, 26,
                                         cx - self.R - 4, 26, fill=LINE, width=2)
                self.items["_lines"][key] = ln
            ring = self.cv.create_oval(cx - self.R, 26 - self.R, cx + self.R,
                                       26 + self.R, fill="#eef2f8", outline="")
            glyph = U.icon(self.cv, STEP_ICONS[key], cx, 26, color=MUTED, size=16)
            name = self.cv.create_text(cx, 58, text=text, font=(FACE, 9, "bold"),
                                       fill=BODY)
            state = self.cv.create_text(cx, 74, text="Pending", font=(FACE, 8),
                                        fill=MUTED)
            self.items[key] = {"ring": ring, "name": name, "state": state,
                               "cx": cx}
        self._built = True
        self.apply(getattr(self, "_last", {}))

    def apply(self, states: dict) -> None:
        """states: {step_key: 'done'|'active'|'pending'}"""
        self._last = states or {}
        if not self._built:
            return
        for key, _ in STEPS:
            it = self.items.get(key)
            if not it:
                continue
            s = self._last.get(key, "pending")
            fill, tone, word = {
                "done": ("#e3f4ea", GREEN, "Completed"),
                "active": ("#e6efff", BLUE, "In Progress"),
            }.get(s, ("#eef2f8", MUTED, "Pending"))
            self.cv.itemconfigure(it["ring"], fill=fill)
            self.cv.itemconfigure(it["state"], text=word, fill=tone)
            self.cv.itemconfigure(it["name"],
                                  fill=INK if s != "pending" else BODY)
        line_map = self.items.get("_lines", {})
        for key, ln in line_map.items():
            done = self._last.get(key) in ("done", "active")
            self.cv.itemconfigure(ln, fill=BLUE if done else LINE)


class ActivityTable:
    """The run log as a table — time, status, detail.

    A Treeview and not a text console: these are rows with the same three
    columns every time, and a console makes the customer parse them.
    """

    MAX = 200

    def __init__(self, parent) -> None:
        style = ttk.Style()
        style.configure("Act.Treeview", background=CARD, fieldbackground=CARD,
                        foreground=BODY, rowheight=28, borderwidth=0,
                        font=(FACE, 9))
        style.configure("Act.Treeview.Heading", background=CARD, foreground=MUTED,
                        font=(FACE, 8, "bold"), relief="flat")
        style.map("Act.Treeview", background=[("selected", "#eef4ff")],
                  foreground=[("selected", INK)])
        # ttk's default Treeview sits in a sunken 2px frame that reads as a
        # 1990s list box on a flat card, and the option lives on the WIDGET, not
        # the style, so it has to be turned off here.
        style.configure("Act.Treeview", relief="flat", borderwidth=0)
        style.layout("Act.Treeview", [("Act.Treeview.treearea",
                                       {"sticky": "nswe"})])
        self.tree = ttk.Treeview(parent, style="Act.Treeview", show="headings",
                                 columns=("time", "status", "detail"), height=9)
        self.tree.heading("time", text="TIME")
        self.tree.heading("status", text="STATUS")
        self.tree.heading("detail", text="DETAILS")
        self.tree.column("time", width=110, anchor="w", stretch=False)
        self.tree.column("status", width=150, anchor="w", stretch=False)
        self.tree.column("detail", width=420, anchor="w")
        self.tree.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(parent, orient="vertical", command=self.tree.yview)
        sb.pack(side="right", fill="y")
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.tag_configure("ok", foreground=GREEN)
        self.tree.tag_configure("warn", foreground=AMBER)
        self.tree.tag_configure("err", foreground=RED)
        self.tree.tag_configure("run", foreground=BLUE)

    def add(self, when: str, status: str, detail: str, tag: str = "") -> None:
        try:
            self.tree.insert("", "end", values=(when, status, detail),
                             tags=(tag,) if tag else ())
            kids = self.tree.get_children()
            if len(kids) > self.MAX:
                for i in kids[: len(kids) - self.MAX]:
                    self.tree.delete(i)
            self.tree.see(self.tree.get_children()[-1])
        except Exception:
            pass

    def clear(self) -> None:
        try:
            for i in self.tree.get_children():
                self.tree.delete(i)
        except Exception:
            pass


class DetailRail:
    """The right-hand "Sync Details" card: the facts about THIS run."""

    # Only rows the agent can actually fill. A "Tally Version" line sat here
    # reading "—" forever because nothing in the agent knows it; a permanently
    # empty field trains people to stop reading the card.
    ROWS = [("company", "Company Name"), ("path", "Tally Data Path"),
            ("type", "Sync Type"), ("records", "Records"),
            ("start", "Start Time"), ("status", "Status")]

    def __init__(self, parent) -> None:
        box = card(parent, fill="x")
        label(box, "Sync Details", size=11, bold=True, fg=INK,
              anchor="w", padx=16, pady=(14, 10))
        self.vals: dict[str, tk.Label] = {}
        for key, cap in self.ROWS:
            label(box, cap, size=8, fg=MUTED, anchor="w", padx=16)
            # Wrapped, not truncated: a company name or a data path cut off
            # mid-word is the one thing on this card somebody actually needs to
            # read back to support.
            v = tk.Label(box, text="—", font=(FACE, 9, "bold"), fg=INK, bg=CARD,
                         anchor="w", justify="left", wraplength=RAIL_W - 48)
            v.pack(anchor="w", padx=16, pady=(0, 10))
            self.vals[key] = v

    def set(self, key: str, text: str) -> None:
        v = self.vals.get(key)
        if v is not None:
            v.configure(text=text or "—")


class ProgressBar:
    """A flat progress bar with a percentage beside it.

    Mimics the slice of ttk.Progressbar's API the sync logic already calls
    (``start``/``stop``/``configure(mode=…, maximum=…, value=…)``) so that logic
    did not have to change to get a new look.
    """

    def __init__(self, parent) -> None:
        wrap = tk.Frame(parent, bg=CARD)
        wrap.pack(fill="x", pady=(4, 2))
        self.cv = tk.Canvas(wrap, height=10, bg=CARD, highlightthickness=0, bd=0)
        self.cv.pack(side="left", fill="x", expand=True)
        self.lbl = tk.Label(wrap, text="", font=(FACE, 11, "bold"), fg=INK,
                            bg=CARD, width=6, anchor="e")
        self.lbl.pack(side="right", padx=(12, 0))
        self.track = self.cv.create_rectangle(0, 2, 0, 10, fill="#e8eef7",
                                              outline="")
        self.fill = self.cv.create_rectangle(0, 2, 0, 10, fill=BLUE, outline="")
        self._mode = "determinate"
        self._value = 0.0
        self._max = 100.0
        self._job = None
        self._sweep = 0.0
        self.cv.bind("<Configure>", lambda _e: self._draw())

    # -- ttk-shaped API ------------------------------------------------------ #
    def configure(self, **kw) -> None:
        if "mode" in kw:
            self._mode = kw["mode"]
        if "maximum" in kw:
            self._max = max(1.0, float(kw["maximum"]))
        if "value" in kw:
            self._value = float(kw["value"])
        self._draw()

    def start(self, _ms: int = 60) -> None:
        self._mode = "indeterminate"
        if self._job is None:
            self._tick()

    def stop(self) -> None:
        if self._job is not None:
            try:
                self.cv.after_cancel(self._job)
            except Exception:
                pass
            self._job = None
        self._mode = "determinate"
        self._draw()

    # -- drawing ------------------------------------------------------------- #
    def _tick(self) -> None:
        self._sweep = (self._sweep + 0.02) % 1.0
        self._draw()
        try:
            self._job = self.cv.after(40, self._tick)
        except tk.TclError:
            self._job = None

    def _draw(self) -> None:
        try:
            w = max(1, self.cv.winfo_width())
            self.cv.coords(self.track, 0, 2, w, 10)
            if self._mode == "indeterminate":
                seg = w * 0.22
                x = (w + seg) * self._sweep - seg
                self.cv.coords(self.fill, max(0, x), 2, min(w, x + seg), 10)
                self.lbl.configure(text="")
            else:
                pct = max(0.0, min(1.0, self._value / self._max))
                self.cv.coords(self.fill, 0, 2, w * pct, 10)
                self.lbl.configure(text=f"{int(pct * 100)}%" if pct else "")
        except tk.TclError:
            pass
