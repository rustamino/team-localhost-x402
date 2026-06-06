# printer-server

HTTP сервер принтера для маркетплейса 3D-печати. Принимает запросы котировок от маркетплейса, выставляет цену на конкретный job и защищает маршрут оплаты через протокол [x402](https://x402.org) (USDC на Algorand Testnet).

## Как это работает

```
Marketplace                    Printer Server
    │
    ├── GET /info ──────────────► возвращает метаданные принтера
    │
    ├── POST /quote ────────────► вычисляет цену, создаёт job,
    │     {job_id, grams,          регистрирует x402 маршрут
    │      minutes, gcode_url}  ◄─ {can_start_at, payment_url}
    │
    │   (маркетплейс выбирает лучшее предложение, агент платит)
    │
    └── GET /pay/{job_id} ──────► 402 Payment Required  ← первый запрос (без proof)
          X-PAYMENT header ──────► 200 OK               ← повторный запрос с proof
                                    {status: "paid", gcode_url, ...}
```

Первый `GET /pay/{job_id}` без заголовка оплаты перехватывается x402 middleware и возвращает `402` с описанием требования (сумма, адрес, сеть). Клиент (маркетплейс) платит on-chain, получает proof и повторяет запрос — middleware пропускает его к обработчику, который переводит job в статус `paid`.

## Установка

```bash
# pnpm (рекомендуется для разработки на Windows)
pnpm install

# npm (Linux / CI)
npm install
```

Требуется Node.js 20+.

## Конфигурация

Создайте `.env` (или `.env.printer1`, `.env.printer2`, … для нескольких принтеров):

```env
# Обязательные
AVM_ADDRESS=YOUR_ALGORAND_ADDRESS_HERE
FACILITATOR_URL=https://facilitator.example.com

# Сеть
PORT=5555
PUBLIC_BASE_URL=http://192.168.1.42:5555   # адрес, достижимый с маркетплейса

# Идентификация принтера
PRINTER_ID=printer_42
PRINTER_NAME=BerlinMaker FDM-1
PRINTER_LAT=52.52
PRINTER_LON=13.40
PRINTER_CITY=Berlin

# Ценообразование
PRICE_PER_GRAM_USDC=0.03       # USDC за грамм филамента
PRICE_PER_MINUTE_USDC=0.005    # USDC за минуту печати
FLAT_FEE_USDC=0.10             # фиксированная наценка

# Коррекция времени
PRINTER_TIME_MULTIPLIER=1.15   # поправочный коэффициент к оценке слайсера
                               # 1.15 = этот принтер на 15% медленнее

# Очередь
CAN_START_DELAY_MINUTES=20     # через сколько минут принтер готов начать
```

`AVM_ADDRESS` — Algorand-адрес, на который зачисляется USDC. Аккаунт должен быть opt-in в USDC ASA (`10458941` на Testnet).

`PUBLIC_BASE_URL` — URL, по которому маркетплейс будет обращаться к этому серверу. Не `localhost`, если они на разных машинах.

## Запуск

```bash
# Linux / npm
npm start                             # загружает .env
ENV_FILE=.env.printer1 npm start      # произвольный env-файл

# Windows / pnpm
pnpm exec dotenv -e .env.printer1 -- pnpm exec tsx ./printerServer.ts
```

## API

### `GET /info`

Метаданные принтера. Используется маркетплейсом для отображения в UI.

```json
{
  "printer_id": "printer_42",
  "name": "BerlinMaker FDM-1",
  "location": { "lat": 52.52, "lon": 13.40, "city": "Berlin" },
  "capabilities": { "materials": ["PLA", "PETG"], "max_volume_cm3": 400 }
}
```

---

### `POST /quote`

Рассчитать стоимость и зарегистрировать job.

**Тело запроса:**
```json
{
  "job_id":    "j_abc123",
  "grams":     12.4,
  "minutes":   47,
  "gcode_url": "https://marketplace.example.com/files/j_abc123.gcode"
}
```

| Поле | Тип | Описание |
|---|---|---|
| `job_id` | string | Уникальный идентификатор, назначается маркетплейсом |
| `grams` | number | Масса изделия по оценке слайсера |
| `minutes` | number | Время печати по оценке слайсера |
| `gcode_url` | string | URL для скачивания G-Code (сейчас только логируется; скачивание — следующий этап) |

**Ответ `200`:**
```json
{
  "can_start_at":  "2025-01-15T14:32:00.000Z",
  "payment_url":   "http://192.168.1.42:5555/pay/j_abc123"
}
```

`payment_url` — URL, который маркетплейс передаёт x402-клиенту для оплаты.

**Формула цены:**
```
printer_minutes = ceil(minutes × PRINTER_TIME_MULTIPLIER)
price_usdc      = ceil_6(grams × PRICE_PER_GRAM
                       + printer_minutes × PRICE_PER_MINUTE
                       + FLAT_FEE)
```

---

### `GET /pay/{job_id}`

Защищён x402 middleware.

- **Без заголовка оплаты** → `402 Payment Required` + JSON с требованиями (сумма в USDC, адрес, сеть Algorand Testnet)
- **С валидным `X-PAYMENT` proof** → `200 OK`

```json
{
  "status":    "paid",
  "job_id":    "j_abc123",
  "printer_id":"printer_42",
  "price_usdc": 0.641,
  "gcode_url": "https://marketplace.example.com/files/j_abc123.gcode",
  "message":   "Payment confirmed. Print job can be started."
}
```

После успешной оплаты маршрут деактивируется — повторный запрос с тем же proof вернёт `402` (replay protection).

---

### `GET /jobs`

Debug-эндпоинт. Возвращает все jobs в памяти. Удалить перед production.

```json
{ "jobs": [ { "job_id": "j_abc123", "status": "paid", ... } ] }
```

## Тесты

```bash
npm test       # разово
npm run test:watch   # watch mode
```

19 unit-тестов: чистые функции (расчёт цены, валидация) + HTTP-эндпоинты через `app.fetch` без сетевых зависимостей.

Тестирование x402-перехвата (`402 → pay → 200`) требует живого facilitator'а и является интеграционным тестом.

## Структура проекта

```
printer-server/
├── printerServer.ts   # точка входа: читает .env, запускает сервер
├── app.ts             # Hono-приложение, бизнес-логика, типы
├── printerServer.test.ts  # vitest тесты
└── package.json
```

## Следующие этапы

- **Скачивание G-Code** — сейчас `gcode_url` логируется. При интеграции с Klipper принтер будет скачивать и кэшировать файл на этапе `/quote`, чтобы к моменту оплаты G-Code был готов к печати.
- **Саморегистрация в маркетплейсе** — heartbeat `POST /api/printers/register` каждые 30 с, чтобы маркетплейс знал о принтере без статической конфигурации. Описание: `printer_registration.md`.
- **Авторизация** — `MARKETPLACE_TOKEN` в заголовке `Authorization` для защиты от анонимных регистраций.
- **Mainnet** — заменить `ALGORAND_TESTNET_CAIP2` и `USDC_TESTNET_ASA_ID` (`10458941`) на mainnet-константы (`31566704`).
