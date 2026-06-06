# Hackathon x402

Prototype of a public-use 3D printer that accepts print orders, displays the upcoming job, takes payment via the x402 protocol (HTTP 402, Algorand), and starts printing.

Hackathon is organized by a company integrating x402 payments with Algorand.

## Requirements

### Physical stand (prepared before the hackathon)

- **Raspberry Pi 4** — runs Klipper + Moonraker + KlipperScreen
- **Mega2560 board** — stub MCU for Klipper (so Moonraker doesn't hang in "MCU not connected" state); no real printer mechanics
- **Android 6.0 phone** — display via X11/VNC client

### Cloud backend (developed during the hackathon)

- Supports multiple devices (one in practice)
- Accepts GCode file uploads
- Manages a print queue
- Processes x402 payments (Algorand)
- Dispatches print jobs to stands

### Device-side UI (KlipperScreen custom panel)

- Show incoming/upcoming order
- Display print parameters (estimated time, filament mass)
- Payment status via x402
- One-click start, no local file history browsing

## Usage

- `stand/install_ubuntu.md` — full stack install on Ubuntu Server 26.04 LTS / RPi 4 (Klipper, Moonraker, KlipperScreen headless via TigerVNC)
- `stand/printer.cfg` — Klipper config for the stub MCU (Seeeduino Mega), validated with klippy
- `stand/mcu_setup.md` — MCU wiring & flashing instructions (part of the RPi install guide)

## Output / Result Files

<!-- Where to find results, logs, artefacts -->

## Related Research

- KlipperScreen custom panel architecture: complexity 2/5, panels are Python modules in `panels/`, registered via `klipperscreen.conf`, Moonraker API via `self._screen._ws.klippy.*`. See `runs/2026-06-04_init.md`.
