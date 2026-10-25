# Деплой на VPS: Docker, WireGuard и webhook Алисы

Compose запускает приложение через Gluetun с WireGuard. Исходящие запросы приложения к Gemini идут через VPN. Алиса подключается к публичному HTTPS адресу VPS напрямую через Nginx, без VPN. Nginx проксирует только `/alice/`; приложение и панель привязаны только к `127.0.0.1`.

## 1. Установите Docker и Nginx

Установите Docker Engine с Compose plugin по [официальной инструкции Docker](https://docs.docker.com/engine/install/). Затем установите Nginx и Certbot:

```sh
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx git
docker --version
docker compose version
```

Откройте на VPS и у хостинг-провайдера входящие TCP-порты `80` и `443`. Порт `8787` наружу не открывайте. Compose публикует его только на loopback. Docker предупреждает, что опубликованные контейнерные порты могут обходить UFW, поэтому здесь привязка к `127.0.0.1`. [Docker: Docker и ufw](https://docs.docker.com/engine/network/packet-filtering-firewalls/)

## 2. Получите код приложения

Репозиторий приватный. Настройте SSH-доступ к GitHub на VPS, например read-only deploy key, и скопируйте код:

```sh
sudo mkdir -p /opt/alice-gemini
sudo chown "$USER":"$USER" /opt/alice-gemini
git clone git@github.com:Lugovskoy-Maxim/alice-gemini-bridge.git /opt/alice-gemini
cd /opt/alice-gemini
```

## 3. Положите секреты в файлы

Создайте `.env` для API-ключа и папку для WireGuard-файла:

```sh
cp .env.example .env
mkdir -p wireguard
chmod 700 wireguard
nano .env
nano wireguard/wg0.conf
chmod 600 .env wireguard/wg0.conf
```

В `.env` вставьте ключ Google AI Studio:

```dotenv
GEMINI_API_KEY=ваш_ключ_Gemini
APP_PORT=8787
DOCKER_SUBNET=172.30.0.0/24
DOCKER_GATEWAY=172.30.0.1
```

WireGuard-конфиг храните отдельным файлом `wireguard/wg0.conf`. Скопируйте туда конфиг клиента, который выдал ваш VPN-провайдер, с секциями `[Interface]` и `[Peer]`. Убедитесь, что в `Endpoint` стоит IP-адрес сервера (не DNS-имя), а `AllowedIPs` содержит `0.0.0.0/0`, если весь исходящий трафик приложения должен идти через VPN. Gluetun поддерживает WireGuard-конфиг отдельным файлом; custom WireGuard пока требует IP-адрес endpoint. [WireGuard custom provider](https://github.com/qdm12/gluetun-wiki/blob/main/setup/providers/custom.md#wireguard)

В Compose настроено `DOCKER_SUBNET=172.30.0.0/24` с шлюзом `172.30.0.1`. Если сеть пересекается с адресами WireGuard, поменяйте оба значения в `.env` на свободную подсеть и её адрес шлюза (обычно первый адрес, `.1`). Compose разрешит приложению обращаться к Docker-шлюзу напрямую, чтобы ответ SSH-туннелю/локальному Nginx не ушёл в VPN. Gemini-запросы продолжат идти через VPN. Gluetun позволяет настраивать разрешённые входящие порты и локальные подсети отдельно. [Публикация портов](https://github.com/qdm12/gluetun-wiki/blob/main/setup/port-mapping.md), [Firewall](https://github.com/qdm12/gluetun-wiki/blob/main/setup/options/firewall.md)

Файлы `.env` и `wireguard/wg0.conf` исключены из Git и Docker build context. Не загружайте их в репозиторий.

## 4. Соберите и запустите

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f gluetun alice-gemini
```

Дождитесь успешного подключения WireGuard в журнале `gluetun`. Приложение запустится после успешного healthcheck VPN-контейнера. Gluetun использует kill switch: если VPN отключится, исходящий трафик приложения блокируется, а не переключается на обычный интернет. Алиса при этом продолжает доходить до webhook через Nginx; Gemini временно может быть недоступен.

Проверьте локальный порт:

```sh
sudo ss -ltnp | grep ':8787'
```

Должен слушать только `127.0.0.1:8787`. Данные панели и системный prompt сохраняются в Docker volume `alice_data`. Gemini key берётся из `.env` и не копируется в volume или образ.

## 5. Настройте HTTPS webhook через Nginx

Для постоянного адреса проще использовать домен с A-записью на белый IP VPS. Выпустите TLS-сертификат:

```sh
sudo certbot --nginx -d alice.example.ru
```

В HTTPS server-блоке этого домена добавьте проксирование:

```nginx
location = /alice {
    return 308 /alice/;
}

location = /alice/ {
    limit_req zone=alice_webhook burst=20 nodelay;
    proxy_pass http://127.0.0.1:8787/alice/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_connect_timeout 1s;
    proxy_send_timeout 4s;
    proxy_read_timeout 4s;
}

location / {
    return 404;
}
```

На уровне `http`, перед server-блоком, задайте лимит:

```nginx
limit_req_zone $binary_remote_addr zone=alice_webhook:10m rate=120r/m;
```

Проверьте и перезагрузите Nginx:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

В Яндекс Диалогах укажите адрес:

```text
https://alice.example.ru/alice/
```

Внешние запросы к Gemini идут через WireGuard внутри контейнера. Входящий webhook Алисы идёт напрямую к Nginx на VPS, HTTPS завершается на Nginx и доходит до приложения через loopback-порт. Это отдельные направления сети.

Если у вас только IP без домена, нужен TLS-сертификат, выданный именно для IP, и соответствующая конфигурация Nginx. Такие IP-сертификаты краткосрочные, поэтому заранее настройте и проверьте автоматическое продление.

## 6. Панель приложения

Панель не доступна публично. Подключайтесь к ней через SSH-туннель со своего компьютера:

```sh
ssh -N -L 18787:127.0.0.1:8787 USER@IP_ВАШЕГО_VPS
```

Пока команда работает, откройте `http://127.0.0.1:18787`. В панели можно проверить состояние и изменить системный prompt. API-ключ читается из `.env`; поле ключа в интерфейсе его не показывает и не заменяет.

## Обновление и журналы

```sh
cd /opt/alice-gemini
git pull
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 gluetun alice-gemini
```

Остановить контейнеры, сохранив данные:

```sh
docker compose down
```

Не добавляйте `-v`, если хотите оставить volume с настройками приложения.

Если запуск не удался, сначала проверьте `docker compose logs gluetun`, WireGuard-ключи и IP в `Endpoint`, затем убедитесь, что подсети Docker и WireGuard не пересекаются. Для Nginx выполните `sudo nginx -t` и проверьте сертификат и домен.
