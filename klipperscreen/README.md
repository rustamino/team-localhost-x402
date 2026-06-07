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

User: `netbug`, home: `/home/netbug`, Node via nvm.

```bash
# Install Node.js via nvm (if not present)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22

# Deploy
cp -r print_server /home/netbug/print_server
cd /home/netbug/print_server
cp .env.example .env   # fill in your values
npm install
```

### systemd service

```bash
sudo tee /etc/systemd/system/x402-printer.service << 'EOF'
[Unit]
Description=x402 Print Server
After=time-sync.target network-online.target moonraker.service
Wants=network-online.target time-sync.target

[Service]
Type=simple
User=netbug
WorkingDirectory=/home/netbug/print_server
EnvironmentFile=/home/netbug/print_server/.env
ExecStart=/home/netbug/.nvm/versions/node/v22.22.3/bin/node --import tsx/esm server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable x402-printer
sudo systemctl start x402-printer
systemctl status x402-printer
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
       /home/netbug/KlipperScreen/panels/x402_queue.py
```

Install Python dependencies if not present:

```bash
pip3 install qrcode[pil] pillow
```

### Make it the default screen

Option A — use the provided config (replaces home menu):

```bash
sudo cp klipperscreen_patches/config/KlipperScreen.conf \
       /home/netbug/printer_data/config/KlipperScreen.conf
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
