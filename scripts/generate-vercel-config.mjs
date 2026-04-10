#!/usr/bin/env node
/**
 * Emits gateway/vercel.json with legacy `routes` (src/dest) from process.env at build time.
 * Matches behavior that works on Vercel for this project (see /health → /api/health).
 * Required env: CDN_ORIGIN, CONFIG_ORIGIN, POST_ORIGIN, SPOTS_ORIGIN, STORIES_ORIGIN, USER_MANAGEMENT_ORIGIN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(gatewayRoot, '.env') });

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

  /** @type {{ src: string, dest: string }[]} */
  const routes = [{ src: '/health', dest: '/api/health' }];

  /**
   * Exact path + regex rest so `/resource` and `/resource/...` both proxy.
   * Uses `(.*)` + `$1` instead of `:path*` — external routes with `:path*`
   * are unreliable on some Vercel deployments (NOT_FOUND before origin).
   */
  function addPassthrough(origin, basePath) {
    const b = basePath.replace(/^\/+/, '');
    routes.push({
      src: `/${b}`,
      dest: `${origin}/${b}`,
    });
    routes.push({
      src: `/${b}/(.*)`,
      dest: `${origin}/${b}/$1`,
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

  // Vercel expects this directory when Output Directory is "public" (default for Other/static).
  fs.mkdirSync(path.join(gatewayRoot, 'public'), { recursive: true });

  const vercelJson = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    outputDirectory: 'public',
    routes,
  };

  fs.writeFileSync(outFile, `${JSON.stringify(vercelJson, null, 2)}\n`, 'utf8');
  console.log(`generate-vercel-config: wrote ${path.relative(process.cwd(), outFile)}`);
}

main();
