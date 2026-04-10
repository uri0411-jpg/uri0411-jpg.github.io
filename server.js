// ─────────────────────────────────────────────────────────────────────────────
// server.js — LOCAL DEVELOPMENT ONLY
//
// This minimal static server is for running the PWA locally. It is NOT
// suitable for production (no compression, no security headers, no rate
// limiting, no TLS). In production use a proper static host instead:
//
//   Nginx / Caddy   — set headers in nginx.conf / Caddyfile
//   Vercel          — add vercel.json "headers" rules
//   Netlify         — add a _headers file in the publish directory
//   GitHub Pages    — serve via a custom Actions workflow with headers
//
// Recommended production HTTP response headers:
//   Strict-Transport-Security : max-age=31536000; includeSubDomains; preload
//   X-Frame-Options           : DENY
//   X-Content-Type-Options    : nosniff
//   Referrer-Policy           : strict-origin-when-cross-origin
//   Permissions-Policy        : geolocation=(self), notifications=(self), camera=()
//   Content-Security-Policy   : default-src 'self';
//     connect-src 'self' https://*.open-meteo.com https://nominatim.openstreetmap.org
//       https://overpass-api.de https://overpass.kumi.systems https://unpkg.com;
//     script-src 'self'; style-src 'self' https://fonts.googleapis.com;
//     font-src 'self' https://fonts.gstatic.com;
//     img-src 'self' data: https://*.openstreetmap.org https://*.cartocdn.com;
//     worker-src 'self'
//
// Cache-Control split (use two rules in your CDN):
//   sw.js + index.html → Cache-Control: no-cache          (always revalidate)
//   Everything else    → Cache-Control: public, max-age=31536000, immutable
//
// DEV PROXY (/proxy/*):
//   The browser preview sandbox blocks direct fetch to external APIs, but
//   Node.js has unrestricted network access. Requests to /proxy/<name>?...
//   are transparently forwarded to the real upstream API. Enabled only when
//   running locally (js/config.js switches to proxy URLs on localhost).
// ─────────────────────────────────────────────────────────────────────────────
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ── Dev API proxy ─────────────────────────────────────────────────────────────
// Maps /proxy/<name> → upstream host + path prefix.
// The browser's query string is forwarded as-is; POST bodies are piped through.
const PROXY_MAP = {
  '/proxy/weather':       { host: 'api.open-meteo.com',              path: '/v1/forecast'      },
  '/proxy/airq':          { host: 'air-quality-api.open-meteo.com',  path: '/v1/air-quality'   },
  '/proxy/archive':       { host: 'archive-api.open-meteo.com',      path: '/v1/archive'       },
  '/proxy/geocode':       { host: 'nominatim.openstreetmap.org',     path: '/reverse'          },
  '/proxy/overpass':      { host: 'overpass-api.de',                 path: '/api/interpreter'  },
  '/proxy/overpass-kumi': { host: 'overpass.kumi.systems',           path: '/api/interpreter'  },
};

function handleProxy(req, res, proxyKey) {
  const target = PROXY_MAP[proxyKey];
  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Unknown proxy route');
    return;
  }

  const qs      = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const options = {
    hostname: target.host,
    port:     443,
    path:     target.path + qs,
    method:   req.method,
    headers:  {
      'User-Agent':      'TWILIGHT-PWA/1.0 (dev-proxy)',
      'Accept-Language': 'he,en;q=0.9',
      'Referer':         'https://twilight.app/',
      'Accept':          'application/json',
    },
  };
  // Forward Content-Type for POST requests (Overpass)
  if (req.method === 'POST') {
    options.headers['Content-Type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
  }

  const proxyReq = https.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type':                proxyRes.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: err.message }));
  });

  if (req.method === 'POST') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// ── Static file server ────────────────────────────────────────────────────────
http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0]; // pathname without query string

  // Route dev proxy requests before static file handling
  if (urlPath.startsWith('/proxy/')) {
    handleProxy(req, res, urlPath);
    return;
  }

  const filePath    = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  const ext         = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type':  contentType,
      'Cache-Control': 'no-cache', // dev server: always fresh
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`[server] Serving ${ROOT} on http://localhost:${PORT}`);
  console.log(`[server] Dev proxy active: /proxy/weather, /proxy/airq, /proxy/geocode, /proxy/overpass`);
});
