"""
x402 print queue panel for KlipperScreen.

Two modes:
  QR   — queue is empty; shows QR code linking to the marketplace
  List — queue has jobs; shows Task N from <WALLET[-6:]>, ETA, status icon

Polls printer-server GET /status every 5 s via GLib.timeout_add.
Falls back to QR mode on any network error.
"""

import json
import threading
import urllib.request
from datetime import datetime, timezone

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk, GdkPixbuf

try:
    import qrcode
    from PIL import Image
    _HAS_QR = True
except ImportError:
    _HAS_QR = False

PRINTER_STATUS_URL = "http://localhost:5555/status"
MARKETPLACE_URL = "https://x402.nb3.me"
POLL_INTERVAL_MS = 5000


def _generate_qr_pixbuf(url: str, size: int = 300) -> GdkPixbuf.Pixbuf | None:
    if not _HAS_QR:
        return None
    qr = qrcode.QRCode(border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    img = img.resize((size, size), Image.NEAREST)
    data = img.tobytes()
    return GdkPixbuf.Pixbuf.new_from_data(
        data, GdkPixbuf.Colorspace.RGB, False, 8, size, size, size * 3
    )


def _fmt_eta(iso: str | None) -> str:
    if not iso:
        return "?"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        local = dt.astimezone()
        return local.strftime("%H:%M")
    except Exception:
        return iso[:16]


class Panel(Gtk.Box):
    """KlipperScreen panel — registers itself as screen 'x402_queue'."""

    name = "x402_queue"
    title = "Print Queue"

    def __init__(self, screen, title):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self._screen = screen
        self._timeout_id = None

        # --- Stack: qr_page / queue_page ---
        self._stack = Gtk.Stack()
        self._stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self._stack.set_transition_duration(200)

        # QR page
        self._qr_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self._qr_page.set_halign(Gtk.Align.CENTER)
        self._qr_page.set_valign(Gtk.Align.CENTER)

        self._qr_image = Gtk.Image()
        self._qr_label = Gtk.Label(label=MARKETPLACE_URL)
        self._qr_label.get_style_context().add_class("title_1")

        self._qr_page.pack_start(self._qr_image, False, False, 0)
        self._qr_page.pack_start(self._qr_label, False, False, 0)

        # Queue page
        self._queue_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self._queue_page.set_margin_top(12)
        self._queue_page.set_margin_start(16)
        self._queue_page.set_margin_end(16)

        self._queue_title = Gtk.Label()
        self._queue_title.set_halign(Gtk.Align.START)
        self._queue_title.get_style_context().add_class("title_1")
        self._queue_page.pack_start(self._queue_title, False, False, 0)

        self._listbox = Gtk.ListBox()
        self._listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        self._listbox.get_style_context().add_class("frame")
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.add(self._listbox)
        self._queue_page.pack_start(scroll, True, True, 0)

        self._stack.add_named(self._qr_page, "qr")
        self._stack.add_named(self._queue_page, "queue")
        self.pack_start(self._stack, True, True, 0)

        # Pre-render QR
        pixbuf = _generate_qr_pixbuf(MARKETPLACE_URL)
        if pixbuf:
            self._qr_image.set_from_pixbuf(pixbuf)
        else:
            self._qr_image.set_from_icon_name("dialog-error", Gtk.IconSize.DIALOG)

        self._stack.set_visible_child_name("qr")
        self.show_all()

        # Start polling
        self._timeout_id = GLib.timeout_add(POLL_INTERVAL_MS, self._poll)
        GLib.idle_add(self._poll)

    # ------------------------------------------------------------------
    def _poll(self) -> bool:
        """Fetch /status in a background thread; update UI on main thread."""
        threading.Thread(target=self._fetch_status, daemon=True).start()
        return True  # keep timer alive

    def _fetch_status(self):
        try:
            with urllib.request.urlopen(PRINTER_STATUS_URL, timeout=4) as resp:
                data = json.loads(resp.read())
            GLib.idle_add(self._update_ui, data)
        except Exception:
            GLib.idle_add(self._show_qr)

    # ------------------------------------------------------------------
    def _show_qr(self):
        self._stack.set_visible_child_name("qr")

    def _update_ui(self, data: dict):
        queue = data.get("queue", [])
        if not queue:
            self._show_qr()
            return

        # Update queue page
        self._queue_title.set_text(f"Print queue ({len(queue)} job{'s' if len(queue) != 1 else ''})")

        # Rebuild list rows
        for row in self._listbox.get_children():
            self._listbox.remove(row)

        for i, job in enumerate(queue):
            payer = job.get("payer_short") or "??????"
            eta_str = _fmt_eta(job.get("eta"))
            status = job.get("status", "")
            icon = "▶ " if status == "printing" else "   "
            label_text = f"{icon}Task {i + 1} from {payer} — done at {eta_str}"

            label = Gtk.Label(label=label_text)
            label.set_halign(Gtk.Align.START)
            label.set_margin_top(6)
            label.set_margin_bottom(6)
            label.set_margin_start(8)
            if status == "printing":
                label.get_style_context().add_class("title_2")

            row = Gtk.ListBoxRow()
            row.add(label)
            self._listbox.add(row)

        self._listbox.show_all()
        self._stack.set_visible_child_name("queue")

    # ------------------------------------------------------------------
    def on_leave(self):
        """Called by KlipperScreen when navigating away from this panel."""
        if self._timeout_id is not None:
            GLib.source_remove(self._timeout_id)
            self._timeout_id = None

    def on_enter(self):
        """Called by KlipperScreen when navigating to this panel."""
        if self._timeout_id is None:
            self._timeout_id = GLib.timeout_add(POLL_INTERVAL_MS, self._poll)
            GLib.idle_add(self._poll)
