#!/usr/bin/env python3
"""
Persistent machine identity for klipperpi fleet.

ID format: {hostname}_{last4_of_rpi_serial}
Example:   klipperpi_a0c6

The RPi SoC serial (/proc/cpuinfo "Serial") is burned in at manufacture,
survives SD-card replacement, hostname changes, and gold-image cloning —
each unit keeps its own serial.

Fallback: last 4 hex chars of /etc/machine-id SHA-256 (non-RPi or no cpuinfo).

The computed ID is cached at CACHE_PATH so it survives /proc disappearing
in containers or edge cases.
"""

import hashlib
import logging
import os
import re
import socket
import urllib.request
import urllib.error

log = logging.getLogger(__name__)

CACHE_PATH = os.path.expanduser("~/printer_data/machine_id")
STATUS_URL = "https://x402.nb3.me/status"


def _rpi_serial() -> str | None:
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.lower().startswith("serial"):
                    serial = line.split(":", 1)[1].strip()
                    # ignore all-zero serials (QEMU / some early RPi)
                    if re.fullmatch(r"0+", serial):
                        return None
                    return serial
    except OSError:
        pass
    return None


def _fallback_serial() -> str:
    try:
        with open("/etc/machine-id") as f:
            raw = f.read().strip()
        return hashlib.sha256(raw.encode()).hexdigest()
    except OSError:
        return hashlib.sha256(socket.gethostname().encode()).hexdigest()


def generate_machine_id() -> str:
    serial = _rpi_serial() or _fallback_serial()
    suffix = serial[-4:].lower()
    hostname = socket.gethostname().split(".")[0]  # strip domain if any
    return f"{hostname}_{suffix}"


def get_machine_id() -> str:
    """Return cached machine_id, computing and caching it on first call."""
    try:
        with open(CACHE_PATH) as f:
            cached = f.read().strip()
        if cached:
            return cached
    except OSError:
        pass

    machine_id = generate_machine_id()
    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        with open(CACHE_PATH, "w") as f:
            f.write(machine_id + "\n")
        log.info(f"machine_id generated and cached: {machine_id}")
    except OSError as e:
        log.warning(f"could not cache machine_id: {e}")
    return machine_id


def post_status(machine_id: str) -> bool:
    import json
    payload = json.dumps({"machine_id": machine_id}).encode()
    req = urllib.request.Request(
        STATUS_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            log.info(f"status ping OK: {resp.status} — {resp.read(256)}")
            return True
    except urllib.error.URLError as e:
        log.warning(f"status ping failed: {e}")
        return False


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                        datefmt="%H:%M:%S")
    mid = get_machine_id()
    print(f"machine_id: {mid}")
    post_status(mid)
