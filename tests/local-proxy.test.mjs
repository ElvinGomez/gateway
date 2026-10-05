import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createGatewayServer } from '../scripts/local-proxy.mjs';

const servers = [];
let gateway;
async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
before(async () => {
  const env = {};
  for (const [name, key] of [['partners', 'PARTNERS_API_ORIGIN'], ['restaurants', 'RESTAURANTS_ORIGIN'], ['hotels', 'HOTELS_ORIGIN']]) {
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

for (const vertical of ['partners', 'restaurants', 'hotels']) {
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
  for (const [prefix, key] of [['partners', 'PARTNERS_API_ORIGIN'], ['restaurants', 'RESTAURANTS_ORIGIN'], ['hotels', 'HOTELS_ORIGIN']]) {
    const route = routes.find((route) => route.dest === '${' + key + '}/' + prefix + '$1');
    assert.ok(route);
    const denied = routes.find((route) => new RegExp(route.src).test(`/${prefix}/internal/query`));
    assert.equal(denied.status, 404);
  }
});
