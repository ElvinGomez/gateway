import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createGatewayServer, shutdownGracefully } from '../scripts/local-proxy.mjs';

const servers = [];
let gateway;
async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
before(async () => {
  const env = {};
  for (const [name, key] of [['partners', 'PARTNERS_API_ORIGIN'], ['restaurants', 'RESTAURANTS_ORIGIN'], ['hotels', 'HOTELS_ORIGIN'], ['commercial', 'COMMERCIAL_API_ORIGIN'], ['rewards', 'REWARDS_ORIGIN']]) {
    env[key] = await listen(http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(207, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name, method: req.method, url: req.url, auth: req.headers.authorization, body }));
    }));
  }
  gateway = await listen(createGatewayServer(env));
});
after(async () => { await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }))); });

for (const vertical of ['partners', 'restaurants', 'hotels', 'commercial', 'rewards']) {
  test(`routes ${vertical} and preserves request and response semantics`, async () => {
    const response = await fetch(`${gateway}/${vertical}/some-id?x=one%20two`, {
      method: 'PATCH', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: '{"title":"New"}',
    });
    assert.equal(response.status, 207);
    assert.deepEqual(await response.json(), { name: vertical, method: 'PATCH', url: `/${vertical}/some-id?x=one%20two`, auth: 'Bearer test', body: '{"title":"New"}' });
  });
  for (const path of [`/${vertical}/internal`, `/${vertical}/internal/`, `/${vertical}//internal/a`, `/${vertical}/%69nternal/a`, `/${vertical}%2finternal/a`, `/${vertical}/%2569nternal/a`, `/${vertical}/INTERNAL/a`]) {
    test(`blocks public access to ${path}`, async () => {
      assert.equal((await fetch(`${gateway}${path}`)).status, 404);
    });
  }
}
test('does not route /hotelsx to hotels', async () => { assert.equal((await fetch(`${gateway}/hotelsx`)).status, 404); });
test('deployment routes use the same distinct origins and reject internal paths first', () => {
  const { routes } = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
  for (const [prefix, key] of [['partners', 'PARTNERS_API_ORIGIN'], ['restaurants', 'RESTAURANTS_ORIGIN'], ['hotels', 'HOTELS_ORIGIN'], ['commercial', 'COMMERCIAL_API_ORIGIN'], ['rewards', 'REWARDS_ORIGIN'], ['stories', 'STORIES_ORIGIN']]) {
    const route = routes.find((route) => route.dest === '${' + key + '}/' + prefix + '$1');
    assert.ok(route);
    const denied = routes.find((route) => new RegExp(route.src).test(`/${prefix}/internal/query`));
    assert.equal(denied.status, 404);
  }
});
test('sends the person\'s address in x-real-ip and drops the address headers a client makes up', async () => {
  const upstream = await listen(http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ realIp: req.headers['x-real-ip'], clientIp: req.headers['x-tripsi-client-ip'] ?? null }));
  }));
  const proxy = await listen(createGatewayServer({ PARTNERS_API_ORIGIN: upstream }));
  const spoofed = await fetch(`${proxy}/partners/listings/restaurants/r1/coupons`, {
    headers: { 'x-real-ip': '6.6.6.6', 'x-tripsi-client-ip': '6.6.6.6' },
  });
  assert.deepEqual(await spoofed.json(), { realIp: '127.0.0.1', clientIp: null });
  const viaTunnel = await fetch(`${proxy}/partners/listings/restaurants/r1/coupons`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.deepEqual(await viaTunnel.json(), { realIp: '203.0.113.9', clientIp: null });
});
test('overwrites x-forwarded-for with the person\'s address so services cannot be fed a made-up first hop', async () => {
  const upstream = await listen(http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ forwardedFor: req.headers['x-forwarded-for'] }));
  }));
  const proxy = await listen(createGatewayServer({ SPOTS_ORIGIN: upstream }));
  // What Cloudflare forwards when a client sends its own header: "<spoofed>, <real>".
  const viaCloudflare = await fetch(`${proxy}/spots/nearby`, {
    headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'cf-connecting-ip': '203.0.113.9' },
  });
  assert.deepEqual(await viaCloudflare.json(), { forwardedFor: '203.0.113.9' });
  const direct = await fetch(`${proxy}/spots/nearby`, { headers: { 'x-forwarded-for': '6.6.6.6' } });
  assert.deepEqual(await direct.json(), { forwardedFor: '127.0.0.1' });
});
test('answers a missing origin with a generic 502 that names no variable', async () => {
  const proxy = await listen(createGatewayServer({}));
  const response = await fetch(`${proxy}/spots/nearby`);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { message: 'Bad gateway', statusCode: 502 });
  assert.doesNotMatch(body, /ORIGIN|ECONN/);
});
test('answers an unreachable upstream with a generic 502 that hides the cause', async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const proxy = await listen(createGatewayServer({ SPOTS_ORIGIN: `http://127.0.0.1:${port}` }));
  const response = await fetch(`${proxy}/spots/nearby`);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { message: 'Bad gateway', statusCode: 502 });
  assert.doesNotMatch(body, /ORIGIN|ECONN/);
});
test('gives up on a silent upstream with a generic 504', async () => {
  const silent = await listen(http.createServer(() => {}));
  const proxy = await listen(createGatewayServer({ SPOTS_ORIGIN: silent, GATEWAY_UPSTREAM_TIMEOUT_MS: '150' }));
  const response = await fetch(`${proxy}/spots/nearby`);
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { message: 'Gateway timeout', statusCode: 504 });
});
test('keeps the feature-flag stream open past the upstream idle timeout', async () => {
  const stream = await listen(http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => res.end('event: snapshot\ndata: {}\n\n'), 400);
  }));
  const proxy = await listen(createGatewayServer({ CONFIG_ORIGIN: stream, GATEWAY_UPSTREAM_TIMEOUT_MS: '150' }));
  const response = await fetch(`${proxy}/config/stream`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'event: snapshot\ndata: {}\n\n');
});
test('bounds requests with header/request timeouts and outlives the proxy keep-alive', () => {
  const server = createGatewayServer({});
  assert.equal(server.timeout, 0);
  assert.equal(server.keepAliveTimeout, 95_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
  assert.equal(server.requestTimeout, 120_000);
  const tuned = createGatewayServer({ GATEWAY_KEEPALIVE_TIMEOUT_MS: '', GATEWAY_REQUEST_TIMEOUT_MS: '30000' });
  assert.equal(tuned.keepAliveTimeout, 95_000);
  assert.equal(tuned.requestTimeout, 30_000);
});
test('drains in-flight requests on shutdown, then closes', async () => {
  const slow = await listen(http.createServer((req, res) => setTimeout(() => { res.writeHead(200); res.end('done'); }, 200)));
  const server = createGatewayServer({ SPOTS_ORIGIN: slow });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pending = fetch(`http://127.0.0.1:${server.address().port}/spots/nearby`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const startedAt = Date.now();
  await shutdownGracefully(server, 2_000);
  assert.ok(Date.now() - startedAt < 1_000, 'closed once the request finished, not at the grace deadline');
  assert.equal(await (await pending).text(), 'done');
  assert.equal(server.listening, false);
});
