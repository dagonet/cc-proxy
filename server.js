import { createServer } from 'node:http';

const PORT = parseInt(process.env.PROXY_PORT || '3456', 10);
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE_MB || '10', 10) * 1024 * 1024;

const ANTHROPIC_URL = process.env.ANTHROPIC_UPSTREAM_URL || 'https://api.anthropic.com/v1/messages';
const DEEPSEEK_URL = process.env.DEEPSEEK_UPSTREAM_URL || 'https://api.deepseek.com/anthropic/v1/messages';

let reqCounter = 0;
function ts() { return new Date().toISOString(); }
function log(route, model, msg) { console.log(`${ts()} #${++reqCounter} [${route}] model=${model} ${msg}`); }
function logErr(route, model, msg) { console.error(`${ts()} #${reqCounter} [${route}] model=${model} ${msg}`); }
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL_OVERRIDE || 'https://api.anthropic.com';

if (!ANTHROPIC_API_KEY && !DEEPSEEK_API_KEY) {
  console.error('At least one of ANTHROPIC_API_KEY or DEEPSEEK_API_KEY must be set');
  process.exit(1);
}
if (!DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY env var is required');
  process.exit(1);
}

const ANTHROPIC_AUTH_MODE = ANTHROPIC_API_KEY ? 'api-key' : 'passthrough';

function routeRequest(model) {
  if (model && model.includes('deepseek')) return 'deepseek';
  if (model && model.includes('claude')) return 'anthropic';
  return null;
}

function getUpstreamConfig(route, query) {
  if (route === 'deepseek') {
    // DeepSeek ignores beta features — strip query string to avoid confusing their parser
    return { url: DEEPSEEK_URL, key: DEEPSEEK_API_KEY };
  }
  return { url: ANTHROPIC_URL + (query || ''), key: ANTHROPIC_API_KEY };
}

function collectBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject({ status: 413, body: JSON.stringify({ error: 'request body too large' }) });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyRequest(req, res) {
  let body;
  try {
    body = await collectBody(req, MAX_BODY_SIZE);
  } catch (err) {
    if (err.status) {
      res.writeHead(err.status, { 'Content-Type': 'application/json' });
      res.end(err.body);
    }
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }

  const model = parsed.model;
  const route = routeRequest(model);
  if (!route) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `unsupported model: ${model}` }));
    return;
  }

  // Anthropic requires max_tokens; DeepSeek's API does not.
  // When Claude Code targets a DeepSeek model it may omit max_tokens.
  // If the proxy routes that request to Anthropic instead, inject a default.
  if (route === 'anthropic' && typeof parsed.max_tokens !== 'number') {
    parsed.max_tokens = 4096;
    body = Buffer.from(JSON.stringify(parsed));
  }

  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstream = getUpstreamConfig(route, query);

  const headers = {};
  if (route === 'deepseek') {
    // DeepSeek: minimal headers only — health check proves this works.
    // Forwarding client headers risks leaking subscription tokens (causes 401).
    headers['content-type'] = 'application/json';
    headers['x-api-key'] = upstream.key;
  } else {
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host') continue;
      if (k === 'x-api-key') {
        if (ANTHROPIC_AUTH_MODE === 'api-key') continue;
        headers[k] = v;
        continue;
      }
      if (k === 'content-length') { headers[k] = v; continue; }
      headers[k] = v;
    }
    if (ANTHROPIC_AUTH_MODE === 'api-key') {
      headers['x-api-key'] = upstream.key;
    }
    headers['content-type'] = 'application/json';
  }

  // Debug: verify auth key for first DeepSeek request
  if (route === 'deepseek' && !proxyRequest._dsDebugged) {
    proxyRequest._dsDebugged = true;
    const sentKey = headers['x-api-key'] || '<missing>';
    const expectedKey = DEEPSEEK_API_KEY;
    const match = sentKey === expectedKey;
    console.log(`${ts()} [deepseek:debug] key match=${match} sent=${sentKey.slice(0, 6)}...${sentKey.slice(-4)} expected=${expectedKey.slice(0, 6)}...${expectedKey.slice(-4)} upstream.key=${(upstream.key || '').slice(0, 6)}...${(upstream.key || '').slice(-4)}`);
    const hdrSummary = Object.entries(headers).map(([k, v]) => {
      if (k === 'x-api-key') return `${k}=${v.slice(0, 6)}...${v.slice(-4)}`;
      return `${k}=${typeof v === 'string' ? v.slice(0, 60) : v}`;
    }).join(' | ');
    console.log(`${ts()} [deepseek:debug] all headers: ${hdrSummary}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(upstream.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    const resHeaders = {};
    for (const [k, v] of upstreamRes.headers) {
      if (k === 'content-encoding' || k === 'transfer-encoding') continue;
      resHeaders[k] = v;
    }

    // Buffer body so we can log it for error status codes
    let resBody = null;
    if (upstreamRes.body) {
      const chunks = [];
      for await (const chunk of upstreamRes.body) chunks.push(chunk);
      resBody = Buffer.concat(chunks);
    }

    res.writeHead(upstreamRes.status, resHeaders);
    if (resBody) res.write(resBody);
    res.end();

    if (upstreamRes.status >= 400) {
      log(route, model, `status=${upstreamRes.status} body=${resBody ? resBody.toString().slice(0, 500) : '<empty>'}`);
    } else {
      log(route, model, `status=${upstreamRes.status}`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream timeout' }));
      log(route, model, 'TIMEOUT');
    } else {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream connection failed' }));
      }
      logErr(route, model, `ERROR: ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function proxyPassthrough(req, res) {
  const parts = req.url.split('/').filter(Boolean);
  const suffix = parts.slice(1).join('/');
  const targetUrl = `${ANTHROPIC_BASE}/v1/${suffix}`;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host') continue;
    if (k === 'x-api-key') {
      if (ANTHROPIC_AUTH_MODE === 'api-key') continue;
      headers[k] = v;
      continue;
    }
    headers[k] = v;
  }
  if (ANTHROPIC_AUTH_MODE === 'api-key') {
    headers['x-api-key'] = ANTHROPIC_API_KEY;
  }

  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await collectBody(req, MAX_BODY_SIZE);
    } catch (err) {
      if (err.status) {
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(err.body);
      }
      return;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    });

    const resHeaders = {};
    for (const [k, v] of upstreamRes.headers) {
      if (k === 'content-encoding' || k === 'transfer-encoding') continue;
      resHeaders[k] = v;
    }

    let resBody = null;
    if (upstreamRes.body) {
      const chunks = [];
      for await (const chunk of upstreamRes.body) chunks.push(chunk);
      resBody = Buffer.concat(chunks);
    }

    res.writeHead(upstreamRes.status, resHeaders);
    if (resBody) res.write(resBody);
    res.end();

    if (upstreamRes.status >= 400) {
      console.log(`${ts()} [passthrough] ${req.method} /v1/${suffix} status=${upstreamRes.status} body=${resBody ? resBody.toString().slice(0, 500) : '<empty>'}`);
    } else {
      console.log(`${ts()} [passthrough] ${req.method} /v1/${suffix} status=${upstreamRes.status}`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream timeout' }));
      console.log(`${ts()} [passthrough] ${req.method} /v1/${suffix} TIMEOUT`);
    } else {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream connection failed' }));
      }
      console.error(`[passthrough] ${req.method} /v1/${suffix} ERROR: ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function proxyModels(req, res) {
  // Build upstream request to Anthropic's /v1/models
  const targetUrl = new URL(req.url, ANTHROPIC_BASE).href;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host') continue;
    if (k === 'x-api-key') {
      if (ANTHROPIC_AUTH_MODE === 'api-key') continue;
      headers[k] = v;
      continue;
    }
    headers[k] = v;
  }
  if (ANTHROPIC_AUTH_MODE === 'api-key') {
    headers['x-api-key'] = ANTHROPIC_API_KEY;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (upstreamRes.status !== 200) {
      res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) res.write(chunk);
      }
      res.end();
      console.log(`[models] GET status=${upstreamRes.status}`);
      return;
    }

    const raw = await upstreamRes.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Forward as-is if not valid JSON
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(raw);
      console.log(`[models] forwarded (non-JSON response)`);
      return;
    }

    // Inject DeepSeek models
    const deepseekModels = [
      { id: 'deepseek-v4-pro', type: 'model', display_name: 'DeepSeek V4 Pro', created_at: '2026-01-01T00:00:00Z' },
      { id: 'deepseek-v4-flash', type: 'model', display_name: 'DeepSeek V4 Flash', created_at: '2026-01-01T00:00:00Z' },
    ];

    if (Array.isArray(data.data)) {
      data.data.push(...deepseekModels);
    } else if (Array.isArray(data)) {
      data.push(...deepseekModels);
    }

    const modified = JSON.stringify(data);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(modified).toString(),
    });
    res.end(modified);
    console.log(`[models] injected ${deepseekModels.length} DeepSeek models`);
  } catch (err) {
    if (err.name === 'AbortError') {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream timeout' }));
      console.log(`[models] TIMEOUT`);
    } else {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream connection failed' }));
      }
      console.error(`[models] ERROR: ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((req, res) => {
  if (!req.url.startsWith('/v1/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    proxyRequest(req, res);
  } else if (req.url.startsWith('/v1/models')) {
    proxyModels(req, res);
  } else {
    proxyPassthrough(req, res);
  }
});

async function healthCheck() {
  const mask = (s) => s && s.length > 8 ? s.slice(0, 6) + '...' + s.slice(-4) : (s ? '***' : '<not set>');

  // Test DeepSeek API key
  let dsStatus = '?';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(`${DEEPSEEK_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': DEEPSEEK_API_KEY },
      body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    dsStatus = r.status;
    if (r.status === 200) {
      dsStatus = 'OK';
    } else {
      const text = await r.text().catch(() => '');
      dsStatus = `${r.status} — ${text.slice(0, 200)}`;
    }
  } catch (e) {
    dsStatus = e.name === 'AbortError' ? 'timeout' : e.message;
  }

  console.log(`cc-proxy listening on 127.0.0.1:${PORT}`);
  console.log(`  Anthropic auth: ${ANTHROPIC_AUTH_MODE}`);
  console.log(`  Anthropic key:  ${mask(ANTHROPIC_API_KEY)}`);
  console.log(`  DeepSeek key:   ${mask(DEEPSEEK_API_KEY)} → health: ${dsStatus}`);
  console.log(`  Anthropic URL:  ${ANTHROPIC_URL}`);
  console.log(`  DeepSeek URL:   ${DEEPSEEK_URL}`);
}

server.listen(PORT, '127.0.0.1', healthCheck);
