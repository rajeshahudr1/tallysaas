"""The boot splash — the part of it that MOVES.

WHY THERE ARE TWO SPLASHES
--------------------------
A --onefile build unpacks ~46 MB to a fresh temp folder before Python starts, and
because the folder name is new every time, antivirus rescans all of it. That is
several seconds during which no Python code can run at all. Only PyInstaller's C
bootloader can put anything on screen in that window, and all it can do is blit
a static PNG.

So the PNG (``splash.png``) carries the artwork and an EMPTY progress track, and
this module — which starts the moment Python does — reopens the same picture in
a borderless Tk window and animates the fill inside that track, over the exact
pixels the empty one occupies. The handover is invisible: the customer sees one
splash whose bar starts moving once the app is actually loading.

The bar is INDETERMINATE (a shuttle that sweeps), not a percentage. There is no
honest percentage available here — the work is "import modules, read config,
probe for Tally", whose durations are unknown and machine-dependent — and a fake
percentage that jumps 0→90→hang is worse than no number at all.

USAGE
-----
    splash = ui_splash.show(root)      # returns None if the art is missing
    ...                                # slow startup work
    splash.status("Checking Tally...") # optional, one short line
    splash.close()                     # always, even on failure
"""

from __future__ import annotations

import tkinter as tk

import ui_signin

# The empty track baked into splash.png, in image pixels. Measured from the
# artwork itself — if the picture is re-rendered at a different size these move,
# which is why the picture is fixed at 720x480 in the build.
BAR_X, BAR_Y, BAR_W, BAR_H = 200, 323, 320, 7
STATUS_Y = 301           # the blank line the art reserves for the step name

SHUTTLE_W = 96           # the moving segment, as a fraction of the track
STEP = 7                 # px per frame
FRAME_MS = 16            # ~60fps; the animation must look smooth or not exist


class Splash:
    """A borderless window showing splash.png with a live progress shuttle."""

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self._job = None
        self._x = float(BAR_X - SHUTTLE_W)
        self._closed = False

        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)          # no title bar: it is a splash
        try:
            self.win.attributes("-topmost", True)
        except Exception:
            pass

        self.img = tk.PhotoImage(file=ui_signin.asset("splash.png"))
        w, h = self.img.width(), self.img.height()
        sw, sh = self.win.winfo_screenwidth(), self.win.winfo_screenheight()
        self.win.geometry(f"{w}x{h}+{(sw - w) // 2}+{max(0, (sh - h) // 2 - 30)}")

        self.cv = tk.Canvas(self.win, width=w, height=h, highlightthickness=0,
                            bd=0, bg="#081733")
        self.cv.pack()
        self.cv.create_image(0, 0, image=self.img, anchor="nw")

        # The shuttle is three stacked segments: a bright core with dimmer ends,
        # which is how a glow is faked on a canvas that has no blur.
        self._parts = [
            self.cv.create_rectangle(0, 0, 0, 0, fill=c, outline="")
            for c in ("#1e4fd0", "#3b82f6", "#7cb1ff")
        ]
        # Starts as "Starting..." so the line is never blank: the picture the
        # bootloader showed had nothing there, and the first thing the customer
        # sees this window do should be filling it in, not emptying it.
        self._status = self.cv.create_text(w / 2, STATUS_Y, text="Starting...",
                                           font=(ui_signin.FACE, 12, "bold"),
                                           fill="#ffffff")
        self._tick()

    # -- animation ---------------------------------------------------------- #
    def _tick(self) -> None:
        """One frame. Sweeps left to right, then restarts from off-track left."""
        if self._closed:
            return
        self._x += STEP
        if self._x > BAR_X + BAR_W:
            self._x = float(BAR_X - SHUTTLE_W)
        left = self._x
        right = min(BAR_X + BAR_W, left + SHUTTLE_W)
        left = max(BAR_X, left)
        y1, y2 = BAR_Y, BAR_Y + BAR_H
        widths = (SHUTTLE_W, SHUTTLE_W * 0.66, SHUTTLE_W * 0.3)
        for part, wf in zip(self._parts, widths):
            # Each segment is centred on the shuttle and clipped to the track,
            # so the glow never spills past the rounded ends of the empty bar.
            centre = (left + right) / 2
            a = max(BAR_X, centre - wf / 2)
            b = min(BAR_X + BAR_W, centre + wf / 2)
            if b <= a:
                self.cv.coords(part, 0, 0, 0, 0)
            else:
                self.cv.coords(part, a, y1, b, y2)
        try:
            self._job = self.win.after(FRAME_MS, self._tick)
        except Exception:
            self._closed = True

    # -- API ---------------------------------------------------------------- #
    def status(self, text: str) -> None:
        """Replace the line under the title. Kept short; it is read at a glance."""
        if self._closed:
            return
        try:
            self.cv.itemconfigure(self._status, text=text)
            self.win.update_idletasks()
        except Exception:
            pass

    def pump(self) -> None:
        """Keep the animation running across a slow, blocking startup step.

        Tk animates from the event loop, and startup work happens BEFORE
        mainloop() — so without this the bar would freeze exactly when the app is
        busiest, which is the moment the customer most needs to see it is alive.
        Call it between steps; anything that blocks for seconds at a stretch
        belongs on a thread instead.
        """
        if self._closed:
            return
        try:
            self.win.update()
        except Exception:
            self._closed = True

    def close(self) -> None:
        """Tear the splash down. Safe to call twice, and never raises."""
        if self._closed:
            return
        self._closed = True
        try:
            if self._job:
                self.win.after_cancel(self._job)
        except Exception:
            pass
        try:
            self.win.destroy()
        except Exception:
            pass


def show(root: tk.Tk):
    """Create the splash, or return None if it cannot be drawn.

    A splash is reassurance, not function: if the art is missing or Tk refuses
    the window, the app must still start. Every caller therefore has to cope
    with None, which is cheaper than a fallback splash nobody would ever see.
    """
    try:
        if not ui_signin.asset("splash.png"):
            return None
        return Splash(root)
    except Exception:
        return None
