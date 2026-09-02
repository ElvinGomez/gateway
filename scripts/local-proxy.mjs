#!/usr/bin/env node
/**
 * Local reverse proxy matching vercel.json path routing.
 * Same entry point as https://api.tripsi.app for the simulator / device.
 *
 *   npm run dev
 *
 * Listens on PORT (default 3080) and forwards:
 *   /file              → CDN_ORIGIN
 *   /config, /internal → CONFIG_ORIGIN
 *   /feedback          → FEEDBACK_ORIGIN
 *   /notifications     → NOTIFICATIONS_ORIGIN
 *   /posts             → POST_ORIGIN
 *   /stories           → STORIES_ORIGIN
 *   /users             → USER_MANAGEMENT_ORIGIN
 *   /spots, /spot, /reviews, /review → SPOTS_ORIGIN
 *   /v1                → AI_ORIGIN (optional)
 */
import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT) || 3080;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** Longer prefixes first so /spots wins over /spot. */
const ROUTES = [
  ['/internal', 'CONFIG_ORIGIN'],
  ['/config', 'CONFIG_ORIGIN'],
  ['/feedback', 'FEEDBACK_ORIGIN'],
  ['/notifications', 'NOTIFICATIONS_ORIGIN'],
  ['/file', 'CDN_ORIGIN'],
  ['/posts', 'POST_ORIGIN'],
  ['/stories', 'STORIES_ORIGIN'],
  ['/users', 'USER_MANAGEMENT_ORIGIN'],
  ['/spots', 'SPOTS_ORIGIN'],
  ['/spot', 'SPOTS_ORIGIN'],
  ['/reviews', 'SPOTS_ORIGIN'],
  ['/review', 'SPOTS_ORIGIN'],
  ['/v1', 'AI_ORIGIN'],
].sort((a, b) => b[0].length - a[0].length);

function originFor(pathname) {
  for (const [prefix, envKey] of ROUTES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const origin = (process.env[envKey] || '').trim().replace(/\/+$/, '');
      return { envKey, origin };
    }
  }
  return null;
}

function copyHeaders(src) {
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (value == null) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function proxy(req, res) {
  const incoming = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = incoming.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'gateway' }));
    return;
  }

  const match = originFor(pathname);
  if (!match) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'No gateway route for this path', statusCode: 404 }));
    return;
  }
  if (!match.origin) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        message: `${match.envKey} is not set`,
        statusCode: 502,
      }),
    );
    return;
  }

  let target;
  try {
    target = new URL(`${pathname}${incoming.search}`, `${match.origin}/`);
  } catch {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `Invalid ${match.envKey}`, statusCode: 502 }));
    return;
  }

  const isTls = target.protocol === 'https:';
  const transport = isTls ? https : http;
  const headers = copyHeaders(req.headers);
  headers.host = target.host;

  const proxyReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isTls ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
      timeout: 0,
    },
    (proxyRes) => {
      const outHeaders = copyHeaders(proxyRes.headers);
      res.writeHead(proxyRes.statusCode || 502, outHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
  });

  proxyReq.on('error', (err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        message: `Upstream ${match.envKey} failed${code ? ` (${code})` : ''}`,
        statusCode: 502,
      }),
    );
  });

  req.pipe(proxyReq);
}

const server = http.createServer(proxy);
server.timeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Local API gateway listening on http://127.0.0.1:${PORT}`);
});
