# klipperscreen — Pi integration

Two components:

```
klipperscreen/
├── print_server/          TypeScript/Hono server (runs on Pi)
│   ├── app.ts             Hono app: /quote /pay/:id /status /info
│   ├── server.ts          Entry point (serve + marketplace WS)
│   ├── moonrakerClient.ts Moonraker API: download → upload → print
│   ├── marketplaceClient.ts  WS client → backend tunnel
│   ├── package.json
│   └── .env.example
└── klipperscreen_patches/
    ├── panels/x402_queue.py     GTK panel (QR or task list)
    └── config/KlipperScreen.conf  Makes x402_queue the home screen
```

---

## print_server

### Setup on Pi

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Deploy
cp -r print_server /home/pi/print_server
cd /home/pi/print_server
cp .env.example .env   # fill in your values
npm install
npm start
```

### systemd service

Save to `/etc/systemd/system/x402-printer.service`:

```ini
[Unit]
Description=x402 Printer Server
After=network-online.target moonraker.service
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/print_server
EnvironmentFile=/home/pi/print_server/.env
ExecStart=/usr/bin/node --import tsx/esm server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable x402-printer
sudo systemctl start x402-printer
```

### /status endpoint

```
GET localhost:5555/status
```
```json
{
  "printer_id": "printer_berlin_fast",
  "queue": [
    { "job_id": "j_abc", "payer_short": "GE6UCU", "status": "printing", "started_at": "…", "eta": "…" },
    { "job_id": "j_def", "payer_short": "WBP5AG", "status": "paid",     "started_at": null, "eta": null }
  ]
}
```

`payer_short` is the last 6 characters of the payer's Algorand address, extracted from
the signed transaction in the `payment-signature` (x402 AVM header). Not related to filename.

---

## klipperscreen_patches

### Install panel

```bash
sudo cp klipperscreen_patches/panels/x402_queue.py \
       /home/pi/KlipperScreen/panels/x402_queue.py
```

Install Python dependencies if not present:

```bash
pip3 install qrcode[pil] pillow
```

### Make it the default screen

Option A — use the provided config (replaces home menu):

```bash
sudo cp klipperscreen_patches/config/KlipperScreen.conf \
       /home/pi/printer_data/config/KlipperScreen.conf
```

Option B — add just the panel to your existing config:

```ini
[menu __main]
name: x402 Queue
icon: custom-cloud
panel: x402_queue
```

Then restart KlipperScreen:

```bash
sudo systemctl restart KlipperScreen
```

The panel polls `localhost:5555/status` every 5 s. When the queue is empty it
shows a QR code linking to `https://x402.nb3.me`. When jobs exist it lists
`Task N from <LAST6> — done at HH:MM` with ▶ for the actively printing job.
