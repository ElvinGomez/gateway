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
 *   /rewards           → REWARDS_ORIGIN
 *   /users             → USER_MANAGEMENT_ORIGIN
 *   /commercial        → COMMERCIAL_API_ORIGIN
 *   /partners          → PARTNERS_API_ORIGIN
 *   /restaurants       → RESTAURANTS_ORIGIN
 *   /hotels            → HOTELS_ORIGIN
 *   /spots, /spot, /reviews, /review → SPOTS_ORIGIN
 *   /v1                → AI_ORIGIN (optional)
 */
import { realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 3080;

// Long-lived streams (feature flags SSE) must not hit the upstream idle timeout.
const STREAM_PATHS = new Set(['/config/stream']);

function msFrom(env, key, fallback) {
  if (env[key] === undefined || String(env[key]).trim() === '') return fallback;
  const value = Number(env[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sendJson(res, statusCode, message) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message, statusCode }));
}

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

/**
 * Longer prefixes first so /spots wins over /spot. A route may list several env
 * keys; the first one that is set wins (used for renamed origins).
 */
const ROUTES = [
  ['/internal', 'CONFIG_ORIGIN'],
  ['/config', 'CONFIG_ORIGIN'],
  ['/feedback', 'FEEDBACK_ORIGIN'],
  ['/notifications', 'NOTIFICATIONS_ORIGIN'],
  ['/file', 'CDN_ORIGIN'],
  ['/posts', 'POST_ORIGIN'],
  ['/stories', 'STORIES_ORIGIN'],
  ['/rewards', 'REWARDS_ORIGIN'],
  ['/users', 'USER_MANAGEMENT_ORIGIN'],
  ['/commercial', 'COMMERCIAL_API_ORIGIN'],
  ['/partners', 'PARTNERS_API_ORIGIN'],
  ['/restaurants', 'RESTAURANTS_ORIGIN'],
  ['/hotels', 'HOTELS_ORIGIN'],
  ['/spots', 'SPOTS_ORIGIN'],
  ['/spot', 'SPOTS_ORIGIN'],
  ['/reviews', 'SPOTS_ORIGIN'],
  ['/review', 'SPOTS_ORIGIN'],
  ['/v1', 'AI_ORIGIN'],
].sort((a, b) => b[0].length - a[0].length);

function originFor(pathname, env) {
  for (const [prefix, envKeys] of ROUTES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const keys = Array.isArray(envKeys) ? envKeys : [envKeys];
      const envKey = keys.find((key) => (env[key] || '').trim()) ?? keys[0];
      const origin = (env[envKey] || '').trim().replace(/\/+$/, '');
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

function clientAddress(req) {
  const cloudflare = req.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare.trim()) return cloudflare.trim();
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function proxy(req, res, env) {
  const incoming = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = incoming.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'gateway' }));
    return;
  }

  // Reject private routes before forwarding, including paths Express could decode
  // or normalize differently. Public callers never reach a service's internals.
  let normalized = pathname;
  try {
    for (let i = 0; i < 4; i += 1) {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) break;
      normalized = decoded;
    }
    normalized = new URL(normalized.replace(/\\/g, '/').replace(/\/+/g, '/'), 'http://localhost').pathname;
  } catch { normalized = '/partners/internal'; }
  if (/^\/(partners|restaurants|hotels|commercial|stories|rewards)\/internal(?:\/|$)/i.test(normalized)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not found', statusCode: 404 }));
    return;
  }

  const match = originFor(pathname, env);
  if (!match) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'No gateway route for this path', statusCode: 404 }));
    return;
  }
  // Clients get a generic 502; the variable name and cause stay in the gateway log.
  if (!match.origin) {
    console.error(`[gateway] ${match.envKey} is not set (${req.method} ${pathname})`);
    sendJson(res, 502, 'Bad gateway');
    return;
  }

  let target;
  try {
    target = new URL(`${pathname}${incoming.search}`, `${match.origin}/`);
  } catch {
    console.error(`[gateway] invalid ${match.envKey} (${req.method} ${pathname})`);
    sendJson(res, 502, 'Bad gateway');
    return;
  }

  const isTls = target.protocol === 'https:';
  const transport = isTls ? https : http;
  const headers = copyHeaders(req.headers);
  headers.host = target.host;
  // The person's address for the services' rate limits, like Vercel's `x-real-ip`: Cloudflare's
  // when the request came through the tunnel, else the socket's. What the client sent is replaced.
  // `x-forwarded-for` is overwritten too (as Vercel does): services read its first value, and
  // Cloudflare only appends to whatever the client sent.
  const clientIp = clientAddress(req);
  headers['x-real-ip'] = clientIp;
  headers['x-forwarded-for'] = clientIp;
  delete headers['x-tripsi-client-ip'];

  const isStream = STREAM_PATHS.has(pathname);
  const upstreamIdleMs = isStream ? 0 : msFrom(env, 'GATEWAY_UPSTREAM_TIMEOUT_MS', 60_000);

  const proxyReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isTls ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
      timeout: upstreamIdleMs,
    },
    (proxyRes) => {
      const outHeaders = copyHeaders(proxyRes.headers);
      res.writeHead(proxyRes.statusCode || 502, outHeaders);
      proxyRes.pipe(res);
    },
  );

  let timedOut = false;
  proxyReq.on('timeout', () => {
    timedOut = true;
    proxyReq.destroy();
  });

  proxyReq.on('error', (err) => {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    console.error(
      `[gateway] upstream ${match.envKey} ${timedOut ? 'timed out' : 'failed'}${code ? ` (${code})` : ''} (${req.method} ${pathname})`,
    );
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, timedOut ? 504 : 502, timedOut ? 'Gateway timeout' : 'Bad gateway');
  });

  if (env.GATEWAY_ACCESS_LOG === '1') {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // Path only: query strings can carry signed URLs or tokens.
      console.log(JSON.stringify({ method: req.method, path: pathname, status: res.statusCode, ms: Math.round(ms), upstream: match.envKey }));
    });
  }

  req.pipe(proxyReq);
}

export function createGatewayServer(env = process.env) {
  const server = http.createServer((req, res) => proxy(req, res, env));
  // No socket inactivity timeout: the flags SSE stays open. Requests are bounded instead by
  // headers/request timeouts, and upstream calls by GATEWAY_UPSTREAM_TIMEOUT_MS.
  server.timeout = 0;
  // Longer than the idle timeout of the proxy in front (Traefik: 90 s), so the gateway never
  // closes a kept-alive connection the proxy is about to reuse (that race surfaces as 502s).
  server.keepAliveTimeout = msFrom(env, 'GATEWAY_KEEPALIVE_TIMEOUT_MS', 95_000);
  server.headersTimeout = Math.max(msFrom(env, 'GATEWAY_HEADERS_TIMEOUT_MS', 100_000), server.keepAliveTimeout + 1_000);
  server.requestTimeout = msFrom(env, 'GATEWAY_REQUEST_TIMEOUT_MS', 120_000);
  return server;
}

/** Stops accepting connections and lets in-flight requests finish, up to `graceMs`. */
export function shutdownGracefully(server, graceMs = 10_000) {
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, graceMs);
    force.unref();
    // Keep-alive connections turn idle after their last response; close them as they do.
    const sweep = setInterval(() => server.closeIdleConnections(), 100);
    sweep.unref();
    server.close(() => {
      clearTimeout(force);
      clearInterval(sweep);
      resolve();
    });
    server.closeIdleConnections();
  });
}

// pm2 (QA) loads this file from its own container, so argv[1] is not the
// script; it exposes the real entry as pm_exec_path. Either path may go through
// a symlink (releases/gateway/current/...), while import.meta.url is resolved.
const entry = process.env.pm_exec_path || process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  const server = createGatewayServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Local API gateway listening on http://127.0.0.1:${PORT}`);
  });
  // Containers get SIGTERM on every redeploy; let in-flight requests finish first.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      console.log(`[gateway] ${signal}: draining connections`);
      shutdownGracefully(server, msFrom(process.env, 'GATEWAY_SHUTDOWN_GRACE_MS', 10_000)).then(() => process.exit(0));
    });
  }
}
