"""
x402 print queue panel for KlipperScreen.

Single-screen layout:
  - QR code (top portion, links to marketplace)
  - URL label
  - Up to 2 most recent jobs at the bottom (always-on, no flapping)

Polls GET /status every 5 s via GLib.timeout_add.
"""

import json
import threading
import urllib.request
from datetime import datetime

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk, GdkPixbuf

from ks_includes.screen_panel import ScreenPanel

try:
    import qrcode
    from PIL import Image
    _HAS_QR = True
except ImportError:
    _HAS_QR = False

PRINTER_STATUS_URL = "http://localhost:5555/status"
MARKETPLACE_URL = "https://x402.nb3.me"
POLL_INTERVAL_MS = 5000


def _generate_qr_pixbuf(url: str, size: int) -> GdkPixbuf.Pixbuf | None:
    if not _HAS_QR:
        return None
    try:
        qr = qrcode.QRCode(border=2)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white").convert("RGBA")
        img = img.resize((size, size), Image.NEAREST)
        data = img.tobytes()
        return GdkPixbuf.Pixbuf.new_from_bytes(
            GLib.Bytes.new(data),
            GdkPixbuf.Colorspace.RGB, True, 8,
            size, size, size * 4,
        )
    except Exception:
        return None


def _fmt_eta(iso: str | None) -> str:
    if not iso:
        return "?"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%H:%M")
    except Exception:
        return iso[:16]


class Panel(ScreenPanel):
    """Single-screen x402 panel: QR code + last 2 jobs."""

    def __init__(self, screen, title):
        title = title or "x402 Queue"
        super().__init__(screen, title)

        self._timeout_id = None

        # Available size (approximate)
        avail_w = self._screen.width - self._gtk.action_bar_width
        avail_h = self._screen.height - 50  # minus titlebar

        # QR size: leave room for 2 task rows (~36px each) + separator + URL label
        task_area_h = 90
        qr_size = max(120, min(avail_w, avail_h - task_area_h) - 16)

        # ── QR image ──────────────────────────────────────────────────
        pixbuf = _generate_qr_pixbuf(MARKETPLACE_URL, qr_size)
        self._qr_image = Gtk.Image()
        if pixbuf:
            self._qr_image.set_from_pixbuf(pixbuf)
        else:
            self._qr_image.set_from_icon_name("dialog-error", Gtk.IconSize.DIALOG)
        self._qr_image.set_halign(Gtk.Align.CENTER)

        # ── URL label ─────────────────────────────────────────────────
        url_label = Gtk.Label(label=MARKETPLACE_URL)
        url_label.get_style_context().add_class("title_2")
        url_label.set_halign(Gtk.Align.CENTER)

        # ── Separator (hidden while queue is empty) ───────────────────
        self._sep = Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL)
        self._sep.set_margin_top(6)
        self._sep.set_margin_bottom(2)

        # ── Task rows (2 slots) ───────────────────────────────────────
        self._task_rows: list[Gtk.Label] = []
        self._task_box = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=2,
            hexpand=True,
        )
        for _ in range(2):
            lbl = Gtk.Label()
            lbl.set_halign(Gtk.Align.START)
            lbl.set_margin_start(12)
            lbl.set_margin_end(12)
            lbl.set_margin_top(4)
            lbl.set_margin_bottom(4)
            lbl.set_line_wrap(True)
            lbl.get_style_context().add_class("title_2")
            self._task_rows.append(lbl)
            self._task_box.pack_start(lbl, False, False, 0)

        # ── Assemble ──────────────────────────────────────────────────
        outer = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=4,
            hexpand=True, vexpand=True,
            valign=Gtk.Align.CENTER,
        )
        outer.pack_start(self._qr_image, False, False, 0)
        outer.pack_start(url_label, False, False, 0)
        outer.pack_start(self._sep, False, False, 0)
        outer.pack_start(self._task_box, False, False, 0)

        self.content.add(outer)
        self.content.show_all()

        # Hide separator and task rows initially (queue empty)
        self._sep.set_visible(False)
        self._task_box.set_visible(False)

        # Initial poll (spawns background thread, returns immediately)
        self._poll()
        self._timeout_id = GLib.timeout_add(POLL_INTERVAL_MS, self._poll)

    # ------------------------------------------------------------------
    def activate(self):
        if self._timeout_id is None:
            self._poll()
            self._timeout_id = GLib.timeout_add(POLL_INTERVAL_MS, self._poll)

    def deactivate(self):
        if self._timeout_id is not None:
            GLib.source_remove(self._timeout_id)
            self._timeout_id = None

    # ------------------------------------------------------------------
    def _poll(self) -> bool:
        threading.Thread(target=self._fetch_status, daemon=True).start()
        return True  # keep GLib timer alive

    def _fetch_status(self):
        try:
            with urllib.request.urlopen(PRINTER_STATUS_URL, timeout=4) as resp:
                data = json.loads(resp.read())
            GLib.idle_add(self._update_ui, data)
        except Exception:
            pass  # keep whatever is displayed; don't flap on transient errors

    # ------------------------------------------------------------------
    def _update_ui(self, data: dict):
        queue = data.get("queue", [])

        # Show up to the 2 most recent jobs
        recent = queue[-2:] if len(queue) >= 2 else queue
        has_jobs = bool(recent)

        self._sep.set_visible(has_jobs)
        self._task_box.set_visible(has_jobs)

        for i, lbl in enumerate(self._task_rows):
            if i < len(recent):
                job = recent[i]
                payer = job.get("payer_short") or "??????"
                eta_str = _fmt_eta(job.get("eta"))
                status = job.get("status", "")
                icon = "▶ " if status == "printing" else "   "
                lbl.set_text(f"{icon}{payer} — done {eta_str}")
                lbl.set_visible(True)
            else:
                lbl.set_visible(False)
