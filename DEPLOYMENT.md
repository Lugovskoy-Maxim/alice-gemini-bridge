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

### Какие порты открыть

На VPS и в сетевом экране хостера разрешите входящие:

| Протокол/порт | Для чего | Доступ |
| --- | --- | --- |
| TCP 22 | SSH для администрирования | Лучше ограничить своим IP, если у него постоянный адрес |
| TCP 80 | HTTP и проверка домена для TLS-сертификата | Из интернета |
| TCP 443 | HTTPS webhook Алисы | Из интернета |

Не открывайте TCP `8787`: это внутренний порт приложения и панели, опубликованный Docker только на `127.0.0.1`. Не открывайте входящий UDP-порт WireGuard на VPS: в этой схеме VPS сам подключается как WireGuard-клиент, ему нужно исходящее соединение к VPN endpoint. Если исходящий трафик ограничен политиками VPS, разрешите UDP к IP и порту `Endpoint` из `wg0.conf`.

Для UFW сначала разрешите используемый порт SSH, чтобы не потерять доступ к серверу, затем включите HTTP/HTTPS:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status verbose
```

Если SSH работает на другом порту, добавьте правило для него вместо `OpenSSH`. Включайте UFW только после проверки правила SSH:

```sh
sudo ufw enable
```

Также задайте те же входящие правила в панели VPS/облачного firewall. Docker предупреждает, что опубликованные контейнерные порты могут обходить UFW; этот Compose публикует `8787` только на loopback, не на внешний интерфейс. [Docker: Docker и ufw](https://docs.docker.com/engine/network/packet-filtering-firewalls/)

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

Для постоянного адреса проще использовать домен с A-записью на белый IP VPS. Создайте каталог ACME challenge:

```sh
sudo install -d -o www-data -g www-data -m 755 /var/www/letsencrypt/.well-known/acme-challenge
```

Создайте временный HTTP-сайт `/etc/nginx/sites-available/alice-gemini`:

```nginx
server {
    listen 80;
    server_name alice.example.ru;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

Включите сайт и проверьте Nginx:

```sh
sudo ln -s /etc/nginx/sites-available/alice-gemini /etc/nginx/sites-enabled/alice-gemini
sudo nginx -t
sudo systemctl reload nginx
```

Когда DNS A-запись домена указывает на VPS и порт 80 доступен снаружи, выпустите сертификат:

```sh
sudo certbot certonly --webroot -w /var/www/letsencrypt -d alice.example.ru
```

В `/etc/nginx/conf.d/alice-gemini-rate-limit.conf` задайте зону ограничения частоты (этот файл подключается внутри `http`):

```nginx
limit_req_zone $binary_remote_addr zone=alice_webhook:10m rate=120r/m;
```

В HTTPS server-блоке домена укажите сертификат и добавьте проксирование webhook:

```nginx
server {
    listen 443 ssl;
    server_name alice.example.ru;

    ssl_certificate     /etc/letsencrypt/live/alice.example.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alice.example.ru/privkey.pem;

    client_max_body_size 64k;

    # Яндекс обращается только к webhook. Панель наружу не публикуется.
    location = /alice {
        return 308 /alice/;
    }

    location = /alice/ {
        limit_req zone=alice_webhook burst=20 nodelay;
        limit_req_status 429;
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
}
```

После выпуска сертификата замените временный HTTP server-блок финальным. Оставьте ACME-путь доступным для продления сертификата и перенаправляйте остальной HTTP на HTTPS:

```nginx
server {
    listen 80;
    server_name alice.example.ru;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

Проверьте синтаксис и примените настройки:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Убедитесь, что извне доступны 80/443, webhook отвечает по HTTPS, а панель снаружи возвращает 404. На хосте порт приложения должен слушать только `127.0.0.1:8787`.

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
