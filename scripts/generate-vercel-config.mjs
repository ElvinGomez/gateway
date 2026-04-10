#!/usr/bin/env node
/**
 * Emits gateway/vercel.json with external rewrites from process.env at build time.
 * Required env: CDN_ORIGIN, CONFIG_ORIGIN, POST_ORIGIN, SPOTS_ORIGIN, STORIES_ORIGIN, USER_MANAGEMENT_ORIGIN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.join(__dirname, '..');
const outFile = path.join(gatewayRoot, 'vercel.json');

const REQUIRED = [
  'CDN_ORIGIN',
  'CONFIG_ORIGIN',
  'POST_ORIGIN',
  'SPOTS_ORIGIN',
  'STORIES_ORIGIN',
  'USER_MANAGEMENT_ORIGIN',
];

function normalizeOrigin(raw, name) {
  const v = String(raw ?? '').trim();
  if (!v) {
    console.error(`generate-vercel-config: missing required env ${name}`);
    process.exit(1);
  }
  let url;
  try {
    url = new URL(v.includes('://') ? v : `https://${v}`);
  } catch {
    console.error(`generate-vercel-config: invalid URL for ${name}: ${v}`);
    process.exit(1);
  }
  if (url.protocol !== 'https:') {
    console.error(`generate-vercel-config: ${name} must use https (got ${url.protocol})`);
    process.exit(1);
  }
  const origin = `${url.protocol}//${url.host}`;
  return origin;
}

function main() {
  const origins = {};
  for (const key of REQUIRED) {
    origins[key] = normalizeOrigin(process.env[key], key);
  }

  const {
    CDN_ORIGIN,
    CONFIG_ORIGIN,
    POST_ORIGIN,
    SPOTS_ORIGIN,
    STORIES_ORIGIN,
    USER_MANAGEMENT_ORIGIN,
  } = origins;

  /** @type {{ source: string, destination: string }[]} */
  const rewrites = [{ source: '/health', destination: '/api/health' }];

  /** Exact path + `/:path*` so `/resource` and `/resource/...` both proxy. */
  function addPassthrough(origin, basePath) {
    const b = basePath.replace(/^\/+/, '');
    rewrites.push({
      source: `/${b}`,
      destination: `${origin}/${b}`,
    });
    rewrites.push({
      source: `/${b}/:path*`,
      destination: `${origin}/${b}/:path*`,
    });
  }

  addPassthrough(CDN_ORIGIN, 'api/upload');
  addPassthrough(CDN_ORIGIN, 'api/read');
  addPassthrough(CONFIG_ORIGIN, 'config');
  addPassthrough(CONFIG_ORIGIN, 'internal');
  addPassthrough(POST_ORIGIN, 'posts');
  addPassthrough(STORIES_ORIGIN, 'stories');
  addPassthrough(USER_MANAGEMENT_ORIGIN, 'users');
  addPassthrough(SPOTS_ORIGIN, 'spots');
  addPassthrough(SPOTS_ORIGIN, 'spot');
  addPassthrough(SPOTS_ORIGIN, 'review');
  addPassthrough(SPOTS_ORIGIN, 'reviews');

  const vercelJson = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    rewrites,
  };

  fs.writeFileSync(outFile, `${JSON.stringify(vercelJson, null, 2)}\n`, 'utf8');
  console.log(`generate-vercel-config: wrote ${path.relative(process.cwd(), outFile)}`);
}

main();
