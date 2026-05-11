// Node/Express server that hosts the Breeze OS web app + API in a single
// Docker-friendly process.
//
// Why this file exists:
//   The /api/*.js handlers were written for Vercel's serverless runtime,
//   which auto-parses JSON bodies, exposes (req, res), and routes by file
//   path. To run the same code under a long-lived Node process (Docker,
//   Fly.io, bare VM), we walk the /api tree, import each handler, and
//   mount it at the route that mirrors its file path. Body-parsing is
//   honoured per-handler so the streaming /api/stt route still gets raw
//   bytes instead of a parsed object.
//
// Environment variables (all optional, sensible defaults):
//   PORT                - port to listen on (default 3000)
//   DIST_DIR            - directory containing the Vite build output
//                         (default ./dist)
//   API_DIR             - directory containing the Vercel-style handlers
//                         (default ./api)
//   TRUST_PROXY         - 'true' to honour X-Forwarded-* (set this when
//                         running behind Fly / Render / nginx / Caddy)
//   API_JSON_LIMIT      - max JSON body size, e.g. '10mb' (default '5mb')
//
// Routing rules (mirror vercel.json):
//   GET   /api/health           → 200 { ok: true } (added here, useful
//                                  for container healthchecks; vercel
//                                  has /api/db-health but that needs DB)
//   *     /api/<file>           → handler from api/<file>.js
//   *     /api/<dir>/<file>     → handler from api/<dir>/<file>.js
//   *     /api/<anything else>  → api/rentmanager.js (Vercel rewrite
//                                  catch-all that proxies Rent Manager)
//   GET   /                     → index.html from DIST_DIR
//   GET   /<anything else>      → static file from DIST_DIR or
//                                  index.html (SPA fallback)

import express from 'express';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const DIST_DIR = resolve(__dirname, process.env.DIST_DIR || 'dist');
const API_DIR = resolve(__dirname, process.env.API_DIR || 'api');
const JSON_LIMIT = process.env.API_JSON_LIMIT || '5mb';

const app = express();

// Behind Fly / Render / nginx we want req.ip and req.protocol to reflect
// the real client. Off by default so local dev doesn't trust spoofed
// headers.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', true);
}

// Container healthcheck. Docker / Fly hit this — it must not depend on
// Postgres or any upstream service so it stays green during cold starts.
app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});

// Walk the /api dir and return every .js file.
function walkJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkJsFiles(full, out);
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Translate /api/admin/owners.js → /api/admin/owners
function fileToRoute(file) {
  const rel = relative(API_DIR, file).replace(/\\/g, '/').replace(/\.js$/, '');
  return '/api/' + rel;
}

async function mountApi() {
  if (!existsSync(API_DIR)) {
    console.warn(`[server] no api directory at ${API_DIR}, skipping mount`);
    return;
  }

  const jsonBody = express.json({ limit: JSON_LIMIT });
  const urlencoded = express.urlencoded({ extended: true, limit: JSON_LIMIT });

  const files = walkJsFiles(API_DIR);
  let rentmanagerHandler = null;

  for (const file of files) {
    const route = fileToRoute(file);
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      console.error(`[server] failed to load ${file}:`, err);
      continue;
    }

    const handler = mod.default;
    if (typeof handler !== 'function') {
      console.warn(`[server] ${file} has no default export, skipping`);
      continue;
    }

    // Hold the rentmanager handler aside — it's also the catch-all for
    // any /api/<anything-else> path per vercel.json. We mount it twice:
    // once at its explicit path and once as the final fallback.
    if (route === '/api/rentmanager') {
      rentmanagerHandler = handler;
    }

    const skipBodyParse = mod.config?.api?.bodyParser === false;
    const middlewares = skipBodyParse ? [] : [jsonBody, urlencoded];
    app.all(route, ...middlewares, wrapHandler(handler, route));
    console.log(
      `[server] mounted ${route}${skipBodyParse ? ' (raw body)' : ''}`,
    );
  }

  // Final catch-all: any /api/* path not explicitly mounted falls
  // through to rentmanager, which proxies the request to the Rent
  // Manager API. Matches vercel.json's `/api/(.*)` rewrite.
  if (rentmanagerHandler) {
    app.all(/^\/api\/.+/, jsonBody, urlencoded, wrapHandler(rentmanagerHandler, '/api/* (rentmanager fallback)'));
    console.log('[server] mounted /api/* fallback → rentmanager');
  }
}

// Wrap a Vercel-style handler so unhandled exceptions become 500s
// instead of crashing the whole process. Vercel does this for free; in
// long-running Node we do it ourselves.
function wrapHandler(handler, label) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[server] handler error at ${label}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || 'Internal error' });
      } else {
        next(err);
      }
    }
  };
}

// Serve the built frontend. In production the Vite build runs in the
// Docker build stage and writes to /app/dist; the runtime stage copies
// that directory in and we serve it as static. SPA routes (deep links
// like /properties/123) fall back to index.html so the React router can
// take over client-side.
function mountStatic() {
  const indexHtml = join(DIST_DIR, 'index.html');
  if (!existsSync(indexHtml)) {
    console.warn(
      `[server] no built frontend at ${DIST_DIR} — only the /api routes ` +
        'will respond. Run `npm run build` (or build the Docker image) first.',
    );
    return;
  }

  app.use(
    express.static(DIST_DIR, {
      // index.html is served by hand below so we can apply no-cache.
      index: false,
      maxAge: '1y',
      etag: true,
    }),
  );

  // SPA fallback. Anything that isn't an /api/* route and isn't a real
  // static file should render the React shell at index.html.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}

await mountApi();
mountStatic();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown so docker stop / fly deploy don't drop in-flight
// requests. Give existing connections 10s to finish, then force-exit.
function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => {
    console.warn('[server] forced exit after 10s grace');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
