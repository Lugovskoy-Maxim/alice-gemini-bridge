# Постоянный адрес webhook для Алисы

Этот Cloudflare Worker выдаёт постоянный URL на `workers.dev` и пересылает запросы Яндекса в локальное приложение на ноутбуке через Quick Tunnel. Gemini API-ключ остаётся в приложении на ноутбуке и в Cloudflare не отправляется.

## Развёртывание

1. Войдите в Cloudflare Dashboard и откройте Workers & Pages.
2. Из этой папки установите Wrangler: `npm install`.
3. В `wrangler.jsonc` укажите текущую основу Quick Tunnel в `UPSTREAM_ORIGIN`, без `/alice`.
4. Выполните `npx wrangler deploy` и получите адрес Worker вида `https://<имя>.<аккаунт>.workers.dev`.
5. В настройках навыка укажите адрес Worker с `/alice`, например `https://<имя>.<аккаунт>.workers.dev/alice`.

## Важно для работы

- Приложение AliceGemini и Quick Tunnel на ноутбуке должны оставаться запущенными: Worker перенаправляет запросы к ним.
- Quick Tunnel получает новый адрес после перезапуска. Тогда нужно обновить `UPSTREAM_ORIGIN` в `wrangler.jsonc` и заново выполнить `npx wrangler deploy`.
- Worker не записывает и не выводит тексты запросов. `/health` сообщает только, настроен ли upstream.
- `.dev.vars` исключён из Git. Не добавляйте API-ключ Gemini в конфигурацию Worker.

Для локального просмотра скопируйте `.dev.vars.example` в `.dev.vars` и выполните `npx wrangler dev`.
