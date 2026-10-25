function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const MAX_BODY_BYTES = 64 * 1024;

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (request.method === 'GET' && incoming.pathname === '/health') {
      return json({ ok: true, configured: Boolean(env.UPSTREAM_ORIGIN) });
    }

    if (incoming.pathname.replace(/\/+$/, '') !== '/alice') {
      return json({ error: 'Не найдено' }, 404);
    }
    if (request.method !== 'POST') {
      return json({ error: 'Метод не поддерживается' }, 405);
    }
    if (!env.UPSTREAM_ORIGIN) {
      return json({ error: 'Не настроен адрес приложения' }, 503);
    }

    let upstream;
    try {
      const origin = new URL(env.UPSTREAM_ORIGIN);
      if (origin.protocol !== 'https:') throw new Error('HTTPS required');
      upstream = new URL(`${incoming.pathname}${incoming.search}`, origin);
    } catch {
      return json({ error: 'Некорректный адрес приложения' }, 500);
    }

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ray');
    headers.delete('x-forwarded-for');
    // Quick Tunnels apply Cloudflare bot checks to the original Yandex UA.
    headers.set('user-agent', 'AliceGeminiWebhook/1.0');

    try {
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) {
        return json({ error: 'Слишком большой запрос' }, 413);
      }
      const response = await fetch(new Request(upstream, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
      }));
      const outgoingHeaders = new Headers(response.headers);
      outgoingHeaders.set('cache-control', 'no-store');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outgoingHeaders,
      });
    } catch (error) {
      console.error('Webhook upstream request failed', error.name || 'error');
      return json({ error: 'Приложение на ноутбуке сейчас недоступно' }, 502);
    }
  },
};
