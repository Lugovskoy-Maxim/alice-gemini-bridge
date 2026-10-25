# Установка на VPS с Nginx

Руководство для Ubuntu/Debian и отдельного VPS с публичным IPv4. Приложение слушает только `127.0.0.1:8787`; наружу Nginx публикует только webhook `/alice/`. Панель и Google API-ключ доступны через SSH-туннель.

## 1. Сеть и DNS

В панели VPS откройте входящие TCP-порты **80 и 443**. Включите те же порты в `ufw`, если он используется. Порт `8787` наружу не открывайте.

Для обычного сертификата укажите DNS-запись `A` домена на статический IP VPS. Например, `alice.example.ru → 203.0.113.10`. Можно также использовать сертификат непосредственно на IP (инструкция ниже). Если домен использует проксирование Cloudflare, для конфигурации ниже установите DNS only либо отдельно настройте Nginx real-IP для адресов Cloudflare.

## 2. Установите Node.js и Nginx

Установите Nginx, Git и Node.js 20 или новее из подходящего для вашей системы источника:

```sh
sudo apt update
sudo apt install -y nginx git
node --version
```

Если Node.js не установлен или его версия ниже 20, сначала поставьте поддерживаемую версию, затем продолжайте. Приложению не нужны npm-зависимости.

## 3. Разместите исходники и создайте пользователя службы

Скопируйте в `/opt/alice-gemini` файлы `server.mjs`, `index.html` и `package.json` из репозитория. Сделать это можно через `git clone` (для закрытого репозитория настройте на VPS read-only SSH deploy key) или через SCP.

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin alicegemini
sudo install -d -o root -g root -m 755 /opt/alice-gemini
sudo install -d -o alicegemini -g alicegemini -m 700 /var/lib/alice-gemini
sudo chown -R root:root /opt/alice-gemini
```

Проверьте, что каталог содержит файлы приложения:

```sh
ls -l /opt/alice-gemini/server.mjs /opt/alice-gemini/index.html /opt/alice-gemini/package.json
```

Создайте `/etc/systemd/system/alice-gemini.service`:

```ini
[Unit]
Description=Alice Gemini webhook
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=alicegemini
Group=alicegemini
WorkingDirectory=/opt/alice-gemini
Environment=PORT=8787
Environment=APP_DATA_DIR=/var/lib/alice-gemini
ExecStart=/usr/bin/node /opt/alice-gemini/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/alice-gemini

[Install]
WantedBy=multi-user.target
```

Если `node --version` показал, что Node расположен не в `/usr/bin/node`, замените путь в `ExecStart` на результат `command -v node`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now alice-gemini
sudo systemctl status alice-gemini --no-pager
sudo ss -ltnp | grep ':8787'
```

В выводе `ss` должен быть адрес `127.0.0.1:8787`, а не `0.0.0.0:8787`.

## 4. Подготовьте HTTP для выпуска сертификата

Создайте каталог проверки Let's Encrypt:

```sh
sudo install -d -o www-data -g www-data -m 755 /var/www/letsencrypt/.well-known/acme-challenge
```

Временно или постоянно установите HTTP-блок Nginx, подставив домен либо IPv4 вместо примера:

```nginx
server {
    listen 80;
    server_name alice.example.ru;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 404;
    }
}
```

Сохраните его в `/etc/nginx/sites-available/alice-gemini`, включите сайт и проверьте конфигурацию:

```sh
sudo ln -s /etc/nginx/sites-available/alice-gemini /etc/nginx/sites-enabled/alice-gemini
sudo nginx -t
sudo systemctl reload nginx
```

### Вариант A: сертификат на домен

Убедитесь, что `alice.example.ru` уже указывает на IP VPS и порт 80 доступен из интернета. Установите Certbot с плагином Nginx и запросите сертификат:

```sh
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d alice.example.ru
```

Certbot обычно добавляет HTTPS-настройки сам. Затем проверьте блок ниже, оставив нужный `server_name` и пути к сертификату.

### Вариант B: сертификат прямо на статический IPv4

Let's Encrypt выпускает IP-сертификаты с коротким сроком действия около 160 часов. Нужен Certbot 5.4 или новее; его Nginx-плагин пока не устанавливает сертификат на IP автоматически, поэтому Nginx настраивается вручную. Выпуск через `webroot`:

```sh
sudo certbot --version
sudo certbot certonly --preferred-profile shortlived \
  --webroot --webroot-path /var/www/letsencrypt \
  --ip-address 203.0.113.10
```

Замените `203.0.113.10` на статический адрес VPS. Путь к файлам будет `/etc/letsencrypt/live/203.0.113.10/fullchain.pem` и `privkey.pem`. Поскольку сертификат живёт около шести дней, обязательно проверьте автоматическое продление:

```sh
systemctl list-timers | grep -i certbot
sudo certbot renew --dry-run
```

Чтобы Nginx перечитывал обновлённый сертификат, добавьте deploy hook:

```sh
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx >/dev/null <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
```

## 5. Включите HTTPS webhook в Nginx

Добавьте HTTPS-блок в `/etc/nginx/sites-available/alice-gemini`. Для домена используйте его имя в `server_name` и каталоге сертификата. Для IP поставьте IP в `server_name` и используйте пути из предыдущего раздела.

```nginx
limit_req_zone $binary_remote_addr zone=alice_webhook:10m rate=120r/m;

server {
    listen 443 ssl;
    server_name alice.example.ru;

    ssl_certificate     /etc/letsencrypt/live/alice.example.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alice.example.ru/privkey.pem;

    client_max_body_size 64k;

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
}
```

В доменном варианте удалите временный HTTP-блок из раздела 4 или замените `location /` в нём на переадресацию к HTTPS, сохранив путь `/.well-known/acme-challenge/` для последующих продлений. Затем проверьте и перечитайте конфигурацию:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Webhook приложения отвечает по HTTPS. Яндекс ждёт ответ не дольше 4,5 секунды; приложение ограничивает запрос к Gemini тремя секундами и возвращает запасной текст при таймауте. Источник: [формат ответа Яндекса](https://yandex.ru/dev/dialogs/alice/doc/ru/response).

## 6. Секретно внесите Gemini API-ключ

Создайте SSH-туннель со своего компьютера:

```sh
ssh -N -L 18787:127.0.0.1:8787 USER@203.0.113.10
```

Не закрывая терминал, откройте `http://127.0.0.1:18787`, введите ключ Gemini API в панели приложения и сохраните его. Ключ записывается в `/var/lib/alice-gemini/config.json`, а не в Git. Проверьте права:

```sh
sudo stat -c '%a %U:%G %n' /var/lib/alice-gemini/config.json
```

Ожидаемые права файла: `600`, владелец `alicegemini`.

## 7. Подключите навык

В Яндекс Диалогах в поле Webhook URL укажите один из адресов:

- домен: `https://alice.example.ru/alice/`
- статический IPv4: `https://203.0.113.10/alice/`

Не указывайте `http://` и не публикуйте порт `8787`. Сохраните черновик и проверьте приветствие, обычный вопрос и повторную реплику в разделе тестирования. Публикацию отправляйте после проверки всех обязательных данных и значка.

## 8. Обновление и журнал

После замены кода перезапустите службу:

```sh
sudo systemctl restart alice-gemini
sudo journalctl -u alice-gemini -n 100 --no-pager
```

При проблемах с TLS:

```sh
sudo nginx -t
sudo certbot renew --dry-run
sudo journalctl -u nginx -n 100 --no-pager
```

**Ограничение доступа:** webhook — публичный endpoint и не имеет отдельной авторизации на уровне протокола Яндекс Диалогов. Nginx rate limit ограничивает частоту с одного IP, но не является пользовательской авторизацией. Панель приложения оставляйте за SSH-туннелем, включите бюджетные лимиты Google AI Studio и следите за расходом API.
