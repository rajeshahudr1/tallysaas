"""The in-place UPDATE screen — presentation only.

WHY THIS MODULE EXISTS. This screen used to be the last ttk view in the product:
a flat blue header band, square buttons and a monospace log on grey. Beside the
sign-in and Dashboard windows — white surfaces, rounded cards, the logo's
blue->green gradient on the action — it read as a different, older application,
and it is the screen a customer meets during an upgrade, when they are least
inclined to trust what they are looking at. It is now drawn on the same
``ui_signin`` canvas toolkit as every other window, from the same palette.

THE PERCENTAGE IS REAL. The splash bar is deliberately indeterminate because
"import modules, probe for Tally" has no honest denominator (see ui_splash). An
update does: the work is dominated by copying one file of known size, and the
remaining steps are a fixed, countable list. So this screen reports a true
figure — bytes copied, weighted into a step budget by
:class:`gui_agent.UpdateView` — rather than a bar that sweeps while the customer
wonders whether it is stuck. That was the complaint: nothing on screen said how
far along an update was.

WHAT THIS MODULE DOES NOT DO. It never copies, starts a service or decides
anything. :class:`gui_agent.UpdateView` owns all of that and drives this class
through the small API below, exactly as DashboardView drives ui_dashboard.

USAGE
-----
    ui = ui_update.Screen(root, on_setup=..., on_close=...)
    ui.state("Update available:  v1.0.4  ->  v1.0.5")
    ui.append("[i] Installed: v1.0.4")
    ui.offer(on_update=..., on_later=...)   # show the two choice buttons
    ui.progress(0.42, "Copying the application")
    ui.state("Updated", tone="ok")
"""

from __future__ import annotations

import tkinter as tk

import ui_signin as U

WIDTH = 760
HEIGHT = 620

PAGE = "#f4f7fc"          # the wash behind the card — ui_dashboard's PAGE
CARD = U.WHITE
LINE = U.LINE
LOG_BG = "#f8fafc"

# The card, the progress track and the log, in canvas pixels. Absolute
# coordinates rather than a layout manager because the window is fixed: there is
# one card and one list, and neither has anything to gain from reflowing.
PAD = 28
CARD_TOP, CARD_BOT = 104, 232
BAR_TOP, BAR_H = 296, 10
LOG_TOP, LOG_BOT = 330, 512
BTN_TOP, BTN_BOT = 546, 584


class Screen:
    """The window: header, state card, progress, log, actions."""

    def __init__(self, root: tk.Tk, *, on_setup=None, on_close=None) -> None:
        self.root = root
        self._on_setup = on_setup
        self._on_close = on_close
        self._log_lines: list[str] = []
        self._pct = 0.0
        self._fill_items: list[int] = []
        self._btn_update = None
        self._btn_later = None

        try:
            root.configure(bg=PAGE)
            root.resizable(False, False)
            root.update_idletasks()
            sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
            root.geometry("%dx%d+%d+%d" % (
                WIDTH, HEIGHT, max(0, (sw - WIDTH) // 2),
                max(0, (sh - HEIGHT) // 2 - 20)))
        except Exception:
            pass

        self.cv = tk.Canvas(root, width=WIDTH, height=HEIGHT, bg=PAGE,
                            highlightthickness=0, bd=0)
        self.cv.pack(fill="both", expand=True)

        self._build_header()
        self._build_card()
        self._build_progress()
        self._build_log()
        self._build_actions()

    # -- construction -------------------------------------------------------- #
    def _build_header(self) -> None:
        """The product, said once. White band, hairline under it — the web app's
        page head, not the old solid-blue slab."""
        self.cv.create_rectangle(0, 0, WIDTH, 84, fill=CARD, outline="")
        self.cv.create_line(0, 84, WIDTH, 84, fill=LINE)
        logo = U.mark_image(44)
        if logo:
            self.cv.create_image(PAD + 22, 42, image=logo)
        else:
            U.round_rect(self.cv, PAD, 20, PAD + 44, 64, 12, fill=U.BLUE,
                         outline="")
        x = PAD + 58
        self.cv.create_text(x, 32, text=U.brand.NAME, anchor="w",
                            font=(U.FACE, 15, "bold"), fill=U.INK)
        self.cv.create_text(x, 54, text="Updating your installation", anchor="w",
                            font=(U.FACE, 9), fill=U.MUTED)

    def _build_card(self) -> None:
        U.round_rect(self.cv, PAD, CARD_TOP, WIDTH - PAD, CARD_BOT, 14,
                     fill=CARD, outline=LINE, width=1)
        self._state = self.cv.create_text(
            PAD + 26, CARD_TOP + 42, text="Checking...", anchor="w",
            font=(U.FACE, 17, "bold"), fill=U.INK)
        self._folder = self.cv.create_text(
            PAD + 26, CARD_TOP + 76, text="", anchor="w",
            font=(U.FACE, 9), fill=U.MUTED)
        self.cv.create_text(
            PAD + 26, CARD_TOP + 98,
            text="Your licence and settings are kept — nothing to re-enter.",
            anchor="w", font=(U.FACE, 9), fill=U.MUTED)

    def _build_progress(self) -> None:
        x1, x2 = PAD, WIDTH - PAD
        self._step = self.cv.create_text(x1, BAR_TOP - 18, text="", anchor="w",
                                         font=(U.FACE, 9), fill=U.BODY)
        # The figure sits at the END of the bar, where the eye already goes to
        # see how much is left.
        self._pct_text = self.cv.create_text(x2, BAR_TOP - 18, text="", anchor="e",
                                             font=(U.FACE, 10, "bold"),
                                             fill=U.INK)
        U.round_rect(self.cv, x1, BAR_TOP, x2, BAR_TOP + BAR_H, BAR_H / 2,
                     fill=LINE, outline="")

    def _build_log(self) -> None:
        """The running detail, on its own quiet surface.

        A real ``tk.Text`` rather than canvas items: the list can outgrow the
        panel, and text the customer can select is text they can paste into a
        support mail.
        """
        U.round_rect(self.cv, PAD, LOG_TOP, WIDTH - PAD, LOG_BOT, 12,
                     fill=LOG_BG, outline=LINE, width=1)
        self.log = tk.Text(self.cv, wrap="word", relief="flat", bd=0,
                           bg=LOG_BG, fg=U.BODY, font=("Consolas", 9),
                           highlightthickness=0, cursor="arrow")
        self.log.configure(state="disabled")
        self.cv.create_window(PAD + 14, LOG_TOP + 12, anchor="nw",
                              window=self.log,
                              width=WIDTH - 2 * PAD - 28,
                              height=LOG_BOT - LOG_TOP - 24)

    def _build_actions(self) -> None:
        # "Set up as a new install instead" is the escape hatch, so it is a
        # link on the left rather than a button competing with the action.
        self._setup = self.cv.create_text(
            PAD, (BTN_TOP + BTN_BOT) / 2, text="Set up as a new install instead",
            anchor="w", font=(U.FACE, 9, "underline"), fill=U.BLUE)
        self.cv.tag_bind(self._setup, "<Button-1>", lambda _e: self._fire(self._on_setup))
        self.cv.tag_bind(self._setup, "<Enter>",
                         lambda _e: self.cv.configure(cursor="hand2"))
        self.cv.tag_bind(self._setup, "<Leave>",
                         lambda _e: self.cv.configure(cursor=""))

        self._close = U._GhostButton(self.cv, WIDTH - PAD - 96, BTN_TOP,
                                     WIDTH - PAD, BTN_BOT, "Close",
                                     lambda: self._fire(self._on_close))
        self._close_enabled = False
        self.set_close_enabled(False)

    # -- API ----------------------------------------------------------------- #
    def state(self, text: str, tone: str = "brand") -> None:
        """The one line the whole window exists to say."""
        colour = {"brand": U.BLUE, "ok": U.GREEN, "bad": "#B23A2E"}.get(tone, U.INK)
        try:
            self.cv.itemconfigure(self._state, text=text, fill=colour)
        except Exception:
            pass

    def folder(self, path: str) -> None:
        try:
            self.cv.itemconfigure(self._folder, text="Folder: " + path)
        except Exception:
            pass

    def append(self, line: str) -> None:
        try:
            self.log.configure(state="normal")
            self.log.insert("end", line + "\n")
            self.log.see("end")
            self.log.configure(state="disabled")
        except Exception:
            pass

    def progress(self, fraction: float, step: str = "") -> None:
        """Paint the bar at ``fraction`` (0..1) and print the figure.

        Repaints the FILL only — the track is drawn once. The fill is the same
        blue->green gradient as the primary action, so "work happening" and
        "the thing you pressed" are visibly the same product.
        """
        try:
            f = max(0.0, min(1.0, float(fraction)))
        except (TypeError, ValueError):
            return
        self._pct = f
        x1, x2 = PAD, WIDTH - PAD
        for item in self._fill_items:
            try:
                self.cv.delete(item)
            except Exception:
                pass
        self._fill_items = []
        end = x1 + (x2 - x1) * f
        if end > x1 + BAR_H:
            tag = "updfill"
            self.cv.delete(tag)
            U.gradient_rect(self.cv, x1, BAR_TOP, end, BAR_TOP + BAR_H,
                            BAR_H / 2, U.GRAD_A, U.GRAD_B, tag)
            self._fill_items = list(self.cv.find_withtag(tag))
        try:
            self.cv.itemconfigure(self._pct_text, text="%d%%" % round(f * 100))
            if step:
                self.cv.itemconfigure(self._step, text=step)
        except Exception:
            pass

    def offer(self, on_update, on_later) -> None:
        """Show the two choice buttons. Called once, when there IS a choice."""
        if self._btn_update is not None:
            return
        self._btn_later = U._GhostButton(
            self.cv, WIDTH - PAD - 96 - 8 - 92, BTN_TOP, WIDTH - PAD - 96 - 8,
            BTN_BOT, "Not now", lambda: self._fire(on_later))
        self._btn_update = U.Button(
            self.cv, WIDTH - PAD - 96 - 8 - 92 - 8 - 148, BTN_TOP,
            WIDTH - PAD - 96 - 8 - 92 - 8, BTN_BOT, "Update now",
            lambda: self._fire(on_update), icon_name=None)

    def hide_choice(self) -> None:
        """The decision is made; from here it is work, not a question."""
        for btn in (self._btn_update, self._btn_later):
            if btn is None:
                continue
            try:
                self.cv.delete(btn.tag)
            except Exception:
                pass
        self._btn_update = self._btn_later = None

    def hide_setup(self) -> None:
        try:
            self.cv.itemconfigure(self._setup, state="hidden")
        except Exception:
            pass

    def set_close_enabled(self, on: bool) -> None:
        """Close stays dead while the exe is being replaced — the one moment
        closing the window would leave a half-written install."""
        self._close_enabled = bool(on)
        try:
            self.cv.itemconfigure(self._close.label,
                                  fill=U.BODY if on else "#b6c2d4")
            self.cv.itemconfigure(self._close.box,
                                  outline=U.FIELD_LINE if on else "#edf1f7")
        except Exception:
            pass

    # -- plumbing ------------------------------------------------------------ #
    def _fire(self, fn) -> None:
        if fn is None:
            return
        if fn is self._on_close and not self._close_enabled:
            return
        try:
            fn()
        except Exception:
            pass
