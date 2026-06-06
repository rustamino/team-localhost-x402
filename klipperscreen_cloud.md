# KlipperScreen × printer-server: план интеграции

## Цель

Запустить `printer-server` на Pi и добавить в KlipperScreen экран, который
показывает QR-код со ссылкой на `x402.nb3.me`, пока очередь пуста, или список
задач с адресом плательщика и временем окончания, когда задачи есть.

---

## Что уже есть

| Компонент | Статус |
|---|---|
| `KlipperScreen/panels/x402_order.py` | Есть: QR-код `x402.nb3.me/order`, статичный |
| `printer-server` (TypeScript/Hono) | Работает, но не на Pi и без Moonraker |
| WS-реестр принтеров | Реализован: printer-server → backend через WS |
| `machine_id.py` | В планах (из runs/2026-06-06_klipper_panel.md) |
| Moonraker API на Pi | Работает на `localhost:7125` |

---

## Общая схема

```
                      Pi (klipperpi)
  ┌─────────────────────────────────────────────────┐
  │                                                 │
  │  KlipperScreen                                  │
  │  └── x402_queue panel                           │
  │       HTTP GET localhost:5555/status  ◄──────┐  │
  │                                              │  │
  │  printer-server (:5555)                      │  │
  │  ├── /status  ──────────────────────────────►│  │
  │  ├── /quote, /info, /pay/* (через WS-тоннель)│  │
  │  └── Moonraker client                        │  │
  │       POST localhost:7125/...  (старт печати) │  │
  │                                              │  │
  │  Moonraker (:7125) ◄── Klipper              │  │
  └─────────────────────────────────────────────────┘
             │  WebSocket (outbound)
             ▼
       x402.nb3.me (backend)
       ├── WS-реестр принтеров
       └── /printer/{id}/pay/* proxy
```

**Ключевой принцип**: весь трафик от backend к printer-server идёт через уже
реализованный WS-тоннель. Pi за NAT — не проблема. KlipperScreen общается
с printer-server только локально (HTTP polling `localhost:5555`).

---

## Часть 1: printer-server на Pi

### 1.1 Node.js

Установить через NodeSource (system-wide, нужен для systemd):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Проверка: `node -v` должен дать `v22.x.x`.

### 1.2 Развёртывание

```
/home/pi/printer-server/
├── app.ts
├── printerServer.ts
├── marketplaceClient.ts
├── package.json
├── node_modules/
└── .env            ← .env.printer1 из репозитория
```

```bash
cd /home/pi/printer-server
npm install
```

### 1.3 systemd-сервис

Файл `/etc/systemd/system/x402-printer.service`:

```ini
[Unit]
Description=x402 Printer Server
After=network-online.target moonraker.service
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/printer-server
EnvironmentFile=/home/pi/printer-server/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable x402-printer
sudo systemctl start x402-printer
```

После успешного WS-соединения backend выдаёт `proxy_base_url` и логирует
`[marketplace] registered. Payment proxy base: https://x402.nb3.me/printer/...`.

---

## Часть 2: Moonraker-интеграция в printer-server

Добавить в `app.ts` (в хэндлер `GET /pay/:job_id`, после `job.status = "paid"`):

### 2.1 Извлечение адреса плательщика

`X-PAYMENT` header содержит base64-encoded payload транзакции AVM. Для
Algorand-схемы в нём есть поле `from` (адрес отправителя):

```
header X-PAYMENT → base64 decode → JSON parse → payload.from
                                            или payload.senderAddress
```

Точный ключ зависит от версии `@x402/avm`. Если недоступен — fallback к первым
8 символам `job_id`.

Сохранить в `PrintJob`: добавить поле `payer_address: string`.

### 2.2 Старт печати через Moonraker

После подтверждения оплаты выполнить последовательно:

```
1. GET  {gcode_url}
        → скачать байты G-code (может быть большим, стримить)

2. POST http://localhost:7125/server/files/upload
        multipart: file={gcode_bytes}, filename={job_id}.gcode, root=gcodes
        → Moonraker кладёт файл в ~/printer_data/gcodes/

3. POST http://localhost:7125/printer/print/start
        body: {"filename": "{job_id}.gcode"}
        → Klipper начинает печать

4. Записать job.started_at = new Date().toISOString()
   (printer_minutes уже есть из расчёта при /quote)
```

При ошибке любого шага: логировать, статус остаётся `paid` (ручное
вмешательство), не бросать исключение в хэндлер (200 уже отправлен).

### 2.3 Расчёт ETA

```
eta = new Date(Date.parse(job.started_at) + job.printer_minutes * 60_000)
```

Уточнение через Moonraker (опционально):
```
GET http://localhost:7125/printer/objects/query?print_stats
→ result.status.print_stats.print_duration / total_duration → прогресс
→ более точный ETA
```

### 2.4 Новый эндпоинт `/status`

```
GET /status
```

Ответ:

```json
{
  "printer_id": "printer_berlin_fast",
  "queue": [
    {
      "job_id": "j_abc123",
      "payer_short": "7GE6UC",
      "started_at": "2026-06-06T18:00:00.000Z",
      "eta": "2026-06-06T19:20:00.000Z",
      "status": "printing"
    },
    {
      "job_id": "j_def456",
      "payer_short": "2WBP5A",
      "started_at": null,
      "eta": "2026-06-06T19:20:00.000Z",
      "status": "paid"
    }
  ]
}
```

`payer_short` = последние 6 символов Algorand-адреса (`address.slice(-6)`).
`queue` содержит все задачи со статусом `paid` или `printing`, отсортированные
по `started_at` (nulls last).

---

## Часть 3: KlipperScreen панель

### 3.1 Изменить или заменить `x402_order.py`

Текущий `x402_order.py` показывает статичный QR. Заменить на `x402_queue.py`
(или расширить тот же файл) с двумя режимами отображения.

### 3.2 Источник данных

Раз в 5 секунд делать `GET http://localhost:5555/status` через `urllib.request`
(или `requests` если установлен). Вызов в отдельном потоке (`threading.Thread`)
или через `GLib.timeout_add` с non-blocking `http.client`.

При недоступности printer-server (исключение при запросе): показывать QR-код
(безопасный fallback).

### 3.3 Логика отображения

```
if status.queue пустой:
    режим QR: показать QR-код "https://x402.nb3.me"

else:
    режим очереди:
        заголовок: "Print queue ({N} jobs)"
        список:
            "Task 1 from 7GE6UC — done at 19:20"
            "Task 2 from 2WBP5A — done at 20:45"  (queued)
        если job.status == "printing": жирный шрифт или иконка ▶
```

Время окончания: форматировать как `HH:MM` локального времени.

### 3.4 GTK-компоненты

```
Gtk.Box (vertical)
  ├── [QR-режим] Gtk.Image ← GdkPixbuf.Pixbuf (генерация как в текущем x402_order.py)
  └── [очередь-режим] Gtk.ListBox
        Gtk.ListBoxRow × N
          Gtk.Label "Task N from {payer_short} — done at {time}"
```

Переключение режимов: `Gtk.Stack` с двумя дочерними виджетами (`qr_page` и
`queue_page`), `stack.set_visible_child_name(...)` при обновлении данных.

### 3.5 Интеграция с KlipperScreen

Заменить кнопку "cloud" в `base_panel.py` (или добавить отдельную) так, чтобы
она открывала `x402_queue`. Панель добавить в `config.cfg` как главный экран
при старте.

---

## Альтернативы: monolithic vs WebSocket

### Рекомендуется: monolithic (local HTTP polling)

```
KlipperScreen → GET localhost:5555/status → printer-server
```

Плюсы: printer-server уже HTTP-сервер, ноль новых зависимостей, надёжно при
перезапуске любой из сторон, KlipperScreen не держит постоянного соединения.

Минусы: задержка обновления до 5 секунд, polling даже когда ничего не меняется.

### Опционально: local WebSocket (улучшение после MVP)

```
printer-server добавляет WS-endpoint /ws/screen
KlipperScreen подключается при старте панели
printer-server пушит обновления при каждом изменении queue
```

Оправдано, если нужна немедленная реакция (например, звук или анимация при
начале печати). Для MVP не нужно.

---

## Порядок реализации

1. **printer-server: `/status` endpoint** — добавить в `app.ts`, отдаёт текущий
   `jobs` Map со статусами `paid`/`printing`
2. **printer-server: Moonraker-клиент** — скачать gcode, загрузить, запустить;
   выделить в `moonrakerClient.ts` чтобы не мешать основной логике
3. **printer-server: payer address** — извлечь из `X-PAYMENT` header, сохранить
   в `PrintJob`
4. **printer-server: systemd** — развернуть на Pi, проверить WS-регистрацию
5. **KlipperScreen: `x402_queue.py`** — QR-режим (копия из текущего) + очередь
6. **Интеграция**: подключить панель в KlipperScreen, проверить polling

---

## Открытые вопросы

- **Payer address**: нужно проверить формат payload `X-PAYMENT` в `@x402/avm`
  для AVM-схемы — есть ли там `from` или нужен другой ключ.
- **Очередь на Pi одна**: Pi физически печатает один job за раз; задачи со
  статусом `paid` и `started_at == null` — это очередь ожидания. Нужно ли
  автоматически запускать следующую задачу по окончании текущей (через Moonraker
  webhook или polling) — решается при реализации Moonraker-клиента.
- **gcode_url доступность**: при текущей архитектуре `gcode_url` может указывать
  на backend (`https://x402.nb3.me/files/...`). Нужно убедиться, что Pi может
  скачать файл с этого URL.
- **Переименование панели**: `x402_order.py` → `x402_queue.py` или расширить
  существующий файл на месте — решить перед реализацией чтобы не сломать
  конфигурацию KlipperScreen.
