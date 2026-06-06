# Подключение и прошивка MCU (Seeeduino Mega / ATmega2560)

Часть инструкции по установке стенда. Предполагается, что на Raspberry Pi уже
установлены Klipper и Moonraker (например, через [KIAUH](https://github.com/dw-0/kiauh)),
а конфиг `printer.cfg` из этого каталога скопирован в `~/printer_data/config/printer.cfg`.

## 1. Подключение платы

1. Подключи Seeeduino Mega к Raspberry Pi обычным USB-кабелем.
   На плате стоит USB-TTL конвертер FTDI FT232 — в системе появится `/dev/ttyUSB0`
   (драйвер `ftdi_sio`).
2. Проверь стабильный путь устройства:

   ```bash
   ls /dev/serial/by-id/
   # usb-FTDI_FT232R_USB_UART_XXXXXXXX-if00-port0
   ```

3. Убедись, что пользователь входит в группу `dialout`:

   ```bash
   sudo usermod -aG dialout $USER   # после этого перелогинься
   ```

## 2. Подключение актуаторов

Общая земля обязательна: GND ленты и серво должны быть соединены с GND платы.

### WS2812B (лента)

| Лента | Куда |
|---|---|
| DIN | **D11** (PB5) — желательно через резистор 300–500 Ом |
| +5V | внешний БП 5 В (не с платы — лента может тянуть >1 А) |
| GND | GND БП **и** GND платы |

Рекомендуется конденсатор 470–1000 мкФ между +5V и GND у начала ленты.
Логика Mega — 5 В, уровень совпадает с лентой, конвертер уровней не нужен.

В конфиге задано `chain_count: 10` — поправь под реальную длину. Тайминг
bit-bang на AVR 16 МГц впритык: если лента глючит, укорачивай цепочку или
переноси её на GPIO самой Pi.

### Сервомотор двери

| Серво | Куда |
|---|---|
| Сигнал (PPM) | **D6** (PH3) |
| +5V | внешний БП 5 В (под нагрузкой серво тянет до 1 А) |
| GND | GND БП **и** GND платы |

## 3. Сборка прошивки Klipper

На Raspberry Pi:

```bash
cd ~/klipper
make clean
make menuconfig
```

В menuconfig:

- **Micro-controller Architecture**: `Atmega AVR`
- **Processor model**: `atmega2560`
- **Processor speed**: `16 MHz`
- **Communication interface**: `UART0`
- **Baud rate**: `250000` (по умолчанию)

Сохрани (`Q` → `Y`) и собери:

```bash
make -j4
```

## 4. Прошивка

Загрузчик у Seeeduino Mega стандартный для Mega 2560 (stk500v2/wiring),
`make flash` прошивает через avrdude:

```bash
sudo service klipper stop
make flash FLASH_DEVICE=/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_XXXXXXXX-if00-port0
sudo service klipper start
```

Если avrdude не синхронизируется — нажми Reset на плате непосредственно
перед запуском команды, либо прошей напрямую:

```bash
avrdude -p atmega2560 -c wiring -b 115200 \
    -P /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_XXXXXXXX-if00-port0 \
    -D -U flash:w:out/klipper.elf.hex:i
```

## 5. Привязка в printer.cfg

Пропиши реальный by-id путь в секции `[mcu]`:

```ini
[mcu]
serial: /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_XXXXXXXX-if00-port0
baud: 250000
```

Перезапусти Klipper (`sudo service klipper restart` или `RESTART` из консоли).

## 6. Проверка

1. В логе `~/printer_data/logs/klippy.log` не должно быть ошибок MCU;
   статус Klipper — `Ready` (виден в Moonraker: `curl localhost:7125/printer/info`).
2. Температура хотенда отображается как ~20 °C (dummy-сенсор на A0/PF0,
   пин висит в воздухе — это норма).
3. Тест актуаторов из консоли (Moonraker/KlipperScreen):

   ```
   LIGHTS_ON
   STATUS_AWAITING_PAYMENT
   LIGHTS_OFF
   DOOR_OPEN
   DOOR_CLOSE
   ```

4. Тест фейковой печати: загрузи любой gcode в `~/printer_data/gcodes/`
   и запусти печать — G28 и команды нагрева перехватываются макросами,
   «печать» идёт без движения и нагрева.
