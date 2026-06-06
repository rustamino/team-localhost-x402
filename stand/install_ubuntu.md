# Установка Klipper / Moonraker / KlipperScreen на Ubuntu Server для Raspberry Pi 4

Целевая ОС: **Ubuntu Server 26.04 LTS (64-bit)**, без Desktop и DM — графика не
нужна: KlipperScreen работает в собственном виртуальном VNC-дисплее (TigerVNC),
который смотрит телефон.

> Примечание: инструкция написана по состоянию пакетной базы Ubuntu 24.04-эры;
> имена пакетов в 26.04 проверяй по факту (`apt search <pkg>`). KIAUH и
> install-скрипты Klipper официально таргетят Debian/RaspiOS, но на Ubuntu
> работают — отличия отмечены ниже.

## 1. Образ и первый запуск

1. В [Raspberry Pi Imager](https://www.raspberrypi.com/software/) выбери
   **Ubuntu Server 26.04 LTS (64-bit)** для Pi 4.
2. В настройках образа (шестерёнка) задай: hostname (`printstand`), пользователя,
   SSH по ключу, Wi-Fi (если без Ethernet).
3. Загрузись, зайди по SSH, обнови систему:

   ```bash
   sudo apt update && sudo apt full-upgrade -y
   sudo timedatectl set-timezone Europe/Moscow   # свой пояс
   ```

## 2. Подготовка системы

```bash
# git и базовые утилиты
sudo apt install -y git python3-virtualenv python3-dev build-essential

# КРИТИЧНО для нашей платы: brltty захватывает FTDI FT232 и отбирает
# /dev/ttyUSB0 у Klipper. На Ubuntu он часто предустановлен — удаляем.
sudo apt purge -y brltty

# доступ к serial-портам и фреймбуферу
sudo usermod -aG dialout,tty,video $USER
# перелогинься после этого
```

Опционально для киоска: отключи автообновления, чтобы apt не лочился во время
демо — `sudo systemctl disable --now unattended-upgrades`.

## 3. Klipper + Moonraker через KIAUH

```bash
cd ~ && git clone https://github.com/dw-0/kiauh.git
./kiauh/kiauh.sh
```

В меню KIAUH: `Install` → **Klipper** (1 instance) → **Moonraker**.
Опционально **Mainsail** — удобен как отладочный веб-интерфейс на время
подготовки стенда (порт 80).

KIAUH создаст структуру `~/printer_data/` (config, gcodes, logs) и systemd-сервисы
`klipper.service`, `moonraker.service`.

> Если KIAUH споткнётся об Ubuntu: в репо Klipper есть
> `scripts/install-ubuntu-22.04.sh` — ручная установка Klipper тем же путём,
> Moonraker ставится своим `~/moonraker/scripts/install-moonraker.sh`.

### moonraker.conf

Проверь/добавь в `~/printer_data/config/moonraker.conf` доступ с LAN
(телефон и облачный бэкенд ходят по сети):

```ini
[authorization]
trusted_clients:
    127.0.0.1
    192.168.0.0/16
cors_domains:
    *
```

После правок: `sudo systemctl restart moonraker`.

## 4. Конфиг принтера и прошивка MCU

1. Скопируй стабовый конфиг:

   ```bash
   cp ~/claude/hackathon_x402/stand/printer.cfg ~/printer_data/config/printer.cfg
   ```

   (или передай на Pi через `scp`).

2. Прошей Seeeduino Mega и подключи актуаторы — см. **mcu_setup.md**.
   Для сборки AVR-прошивки нужен тулчейн:

   ```bash
   sudo apt install -y gcc-avr binutils-avr avr-libc avrdude
   ```

3. Пропиши реальный by-id путь платы в `[mcu]`, перезапусти Klipper,
   убедись в статусе Ready: `curl localhost:7125/printer/info`.

## 5. KlipperScreen в headless/VNC-режиме

X-сервер и DM не нужны: KlipperScreen рисует в виртуальный дисплей TigerVNC.

1. Установи KlipperScreen (через KIAUH → `Install` → KlipperScreen, либо вручную):

   ```bash
   cd ~ && git clone https://github.com/KlipperScreen/KlipperScreen.git
   ./KlipperScreen/scripts/KlipperScreen-install.sh
   ```

   Скрипт создаст venv `~/.KlipperScreen-env` и сервис `KlipperScreen.service`.

2. VNC-бэкенд (официальный механизм KlipperScreen):

   ```bash
   sudo apt install -y tigervnc-standalone-server
   ```

   Создай `~/KlipperScreen/scripts/launch_KlipperScreen.sh`:

   ```bash
   #!/bin/bash
   # Virtual VNC display for KlipperScreen (no local X needed).
   # Resolution = phone screen; adjust -geometry to match the client.
   Xtigervnc -rfbport 5900 -noreset -AlwaysShared -SecurityTypes none \
             -geometry 1280x720 :10 &
   DISPLAY=:10 $KS_XCLIENT &
   wait
   ```

   ```bash
   chmod +x ~/KlipperScreen/scripts/launch_KlipperScreen.sh
   sudo systemctl restart KlipperScreen.service
   ```

   Сервис KlipperScreen сам подхватывает этот скрипт, если он существует.

3. Телефон (Android 6.0): поставь VNC-клиент — **bVNC** или **MultiVNC**
   (оба работают на старых Android), подключайся к `IP_малинки:5900`,
   без пароля (`SecurityTypes none` — приемлемо в изолированной LAN стенда;
   наружу порт 5900 не публиковать). В клиенте включи полноэкранный режим
   и зафиксируй ориентацию.

   Альтернатива VNC: **XServer XSDL** на телефоне (телефон сам X-сервер,
   KlipperScreen запускается с `DISPLAY=IP_телефона:0`) — меньше задержка.
   Настройка — в разделе 5b ниже.

## 5b. Вариант: XServer XSDL по USB-tethering

Телефон подключён к Pi проводом и работает X-сервером: KlipperScreen рисует
напрямую в дисплей телефона, без VNC-прослойки. Связь — через USB-tethering
(RNDIS): телефон поднимает сеть `usb0` на Pi.

### Сеть (Pi)

1. Включи на телефоне **USB-модем** (Settings → Tethering → USB tethering).
   На Pi появится интерфейс `usb0` (драйвер `rndis_host`):

   ```bash
   ip link show usb0
   ```

2. Netplan-конфиг для DHCP на `usb0` — создай `/etc/netplan/60-usb-tether.yaml`:

   ```yaml
   network:
     version: 2
     ethernets:
       usb0:
         dhcp4: true
         optional: true
         dhcp4-overrides:
           route-metric: 700   # default через телефон не должен перебивать Ethernet/Wi-Fi
   ```

   ```bash
   sudo chmod 600 /etc/netplan/60-usb-tether.yaml
   sudo netplan apply
   ```

3. Телефон в этой сети — шлюз (классика AOSP: `192.168.42.129`, Pi получает
   `192.168.42.x`). Проверка:

   ```bash
   ip -4 route show default dev usb0   # default via 192.168.42.129 ...
   ping -c1 192.168.42.129
   ```

### Телефон

1. Установи [XServer XSDL](https://play.google.com/store/apps/details?id=x.org.server)
   (работает на Android 6.0; APK также есть на SourceForge — пригодится, если
   на телефоне нет Google Play).
2. Запусти приложение. В первые секунды доступен экран настроек
   («Change device configuration»):
   - **Display resolution** — нативное разрешение экрана;
   - **Display scale** — подбери так, чтобы элементы KlipperScreen были «пальце-нажимаемыми»;
   - Mouse emulation оставь по умолчанию — тапы работают как клики.
3. Зафиксируй ориентацию экрана в Android. XSDL сам держит экран включённым,
   пока активен.
4. На синем экране XSDL появится подсказка вида
   `export DISPLAY=192.168.42.129:0` — это адрес, на который пойдёт KlipperScreen.

### KlipperScreen → XSDL

```bash
sudo apt install -y netcat-openbsd
```

Замени `~/KlipperScreen/scripts/launch_KlipperScreen.sh` (вместо VNC-варианта
из раздела 5):

```bash
#!/bin/bash
# Render KlipperScreen on the phone's XServer XSDL over USB tethering.
# The phone is the default gateway of the usb0 tethered link.
IFACE=usb0

PHONE_IP=""
while [ -z "$PHONE_IP" ]; do
    PHONE_IP=$(ip -4 route show default dev "$IFACE" 2>/dev/null | awk '{print $3; exit}')
    [ -z "$PHONE_IP" ] && sleep 2
done

# Wait until XSDL is listening (TCP 6000 = display :0)
until nc -z -w 2 "$PHONE_IP" 6000; do
    sleep 2
done

DISPLAY=$PHONE_IP:0 $KS_XCLIENT &
wait
```

```bash
chmod +x ~/KlipperScreen/scripts/launch_KlipperScreen.sh
sudo systemctl restart KlipperScreen.service
```

Скрипт сам ждёт появления сети и запуска XSDL, поэтому порядок включения
не важен. Если XSDL перезапустили — `sudo systemctl restart KlipperScreen`.

### Эксплуатационные заметки

- **USB tethering слетает** при переподключении кабеля и перезагрузке
  телефона — Android 6 не включает его обратно сам. Перед демо: воткнуть
  кабель → включить tethering → запустить XSDL.
- X-протокол по TCP идёт без аутентификации — допустимо только потому, что
  линк USB точка-точка; не маршрутизируй эту сеть наружу.
- Если вендорская прошивка телефона использует не `192.168.42.x` — скрипт
  всё равно отработает: IP берётся из default-маршрута, не захардкожен.

## 6. Проверка

```bash
systemctl status klipper moonraker KlipperScreen   # все active (running)
curl -s localhost:7125/printer/info | python3 -m json.tool   # state: ready
```

- Телефон показывает UI KlipperScreen, температура хотенда ~20 °C.
- Из консоли (Mainsail или KlipperScreen) проходят `DOOR_OPEN`, `STATUS_READY`.
- Фейковая печать: загрузить gcode в `~/printer_data/gcodes/`, запустить —
  идёт без нагрева и движения (см. mcu_setup.md, раздел 6).

## Порты стенда

| Порт | Сервис | Кто ходит |
|---|---|---|
| 7125 | Moonraker API | облачный бэкенд, KlipperScreen |
| 5900 | VNC (KlipperScreen) | телефон |
| 80 | Mainsail (опционально) | отладка с ноутбука |
