import { createServer } from 'node:http';

const PORT = parseInt(process.env.PROXY_PORT || '3456', 10);
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '300000', 10);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE_MB || '10', 10) * 1024 * 1024;

const ANTHROPIC_URL = process.env.ANTHROPIC_UPSTREAM_URL || 'https://api.anthropic.com/v1/messages';
const DEEPSEEK_URL = process.env.DEEPSEEK_UPSTREAM_URL || 'https://api.deepseek.com/anthropic/v1/messages';

// Sonnet/Haiku substitution targets. The proxy is only in the
// request path in mixed and DeepSeek-only mode, so any claude-sonnet-*/claude-haiku-*
// (including [1m] variants that bypass Claude Code's own model override)
// is rewritten to these DeepSeek models. Overridable via env.
const SONNET_TARGET = (process.env.PROXY_SONNET_MODEL || 'deepseek-v4-pro').trim();
const HAIKU_TARGET = (process.env.PROXY_HAIKU_MODEL || 'deepseek-v4-flash').trim();

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

// DeepSeek-only mode points Claude Code at the proxy with this marker as its
// token (not a secret). Such a client never reaches Anthropic: every model goes
// to DeepSeek, /v1/models is answered here, other /v1 calls get a 404.
const DEEPSEEK_ONLY_TOKEN = 'cc-proxy-deepseek-only';
const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-pro', type: 'model', display_name: 'DeepSeek V4 Pro', created_at: '2026-01-01T00:00:00Z' },
  { id: 'deepseek-v4-flash', type: 'model', display_name: 'DeepSeek V4 Flash', created_at: '2026-01-01T00:00:00Z' },
];

function isDeepSeekOnly(req) {
  return req.headers.authorization === `Bearer ${DEEPSEEK_ONLY_TOKEN}`
    || req.headers['x-api-key'] === DEEPSEEK_ONLY_TOKEN;
}

function resolveModel(model) {
  if (!model) return model;
  // Strip Claude Code's [1m] suffix — no upstream accepts it — then map every
  // Sonnet/Haiku variant to its DeepSeek target. Opus keeps its own name.
  const base = model.replace(/\[1m\]$/, '');
  if (base.startsWith('claude-sonnet')) return SONNET_TARGET;
  if (base.startsWith('claude-haiku')) return HAIKU_TARGET;
  return base;
}

function routeRequest(model) {
  // Strip Claude Code [1m] suffix before routing (safety net)
  const cleanModel = model?.replace(/\[1m\]$/, '');
  if (cleanModel && cleanModel.includes('deepseek')) return 'deepseek';
  if (cleanModel && cleanModel.includes('claude')) return 'anthropic';
  return null;
}

// Claude Code's inline-tools beta announces tools that connect mid-session as
// tool_addition blocks carrying the full tool_definition. DeepSeek only accepts
// tool_addition -> tool_reference, and only to a tool listed in `tools`
// (422 / 400 otherwise). Move each definition into `tools`, point the block at
// it by name, and drop references DeepSeek cannot resolve. Returns true if the
// body changed.
function normalizeToolAdditions(parsed) {
  if (!Array.isArray(parsed.messages)) return false;
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const names = new Set(tools.map((t) => t?.name));
  let changed = false;

  for (const msg of parsed.messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_addition' || block.tool?.type !== 'tool_definition') continue;
      const def = block.tool.definition;
      if (!names.has(def.name)) { tools.push(def); names.add(def.name); }
      block.tool = { type: 'tool_reference', name: def.name };
      changed = true;
    }
  }
  for (const msg of parsed.messages) {
    if (!Array.isArray(msg?.content)) continue;
    const kept = msg.content.filter((b) =>
      !(b?.type === 'tool_addition' && b.tool?.type === 'tool_reference' && !names.has(b.tool.name)));
    if (kept.length !== msg.content.length) { msg.content = kept; changed = true; }
  }
  if (changed) {
    parsed.messages = parsed.messages.filter((m) => !Array.isArray(m?.content) || m.content.length > 0);
    if (tools.length) parsed.tools = tools;
  }
  return changed;
}

// DeepSeek's schema validator rejects the regex escape \0 ('"^[^\\0]*$" is not
// a "regex"', 400) — Claude Code's Artifact tool uses it — but accepts the
// equivalent \x00. Rewrite real \0 escapes (not \\0, not octal \01) in every
// `pattern` and `patternProperties` key. Returns true if the body changed.
const NUL_ESCAPE = /(?<!\\)((?:\\\\)*)\\0(?!\d)/g;

function fixSchemaPatterns(parsed) {
  let changed = false;
  const fix = (p) => {
    const out = p.replace(NUL_ESCAPE, '$1\\x00');
    if (out !== p) changed = true;
    return out;
  };
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.pattern === 'string') node.pattern = fix(node.pattern);
    if (node.patternProperties && typeof node.patternProperties === 'object') {
      node.patternProperties = Object.fromEntries(
        Object.entries(node.patternProperties).map(([k, v]) => [fix(k), v]));
    }
    Object.values(node).forEach(walk);
  };
  if (Array.isArray(parsed.tools)) parsed.tools.forEach((t) => walk(t?.input_schema));
  return changed;
}

function getUpstreamConfig(route, query, countTokens) {
  // /v1/messages/count_tokens goes to each upstream's own counter.
  const suffix = countTokens ? '/count_tokens' : '';
  if (route === 'deepseek') {
    // DeepSeek ignores beta features — strip query string to avoid confusing their parser
    return { url: DEEPSEEK_URL + suffix, key: DEEPSEEK_API_KEY };
  }
  return { url: ANTHROPIC_URL + suffix + (query || ''), key: ANTHROPIC_API_KEY };
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

  const deepseekOnly = isDeepSeekOnly(req);
  const countTokens = req.url.split('?')[0] === '/v1/messages/count_tokens';

  let resolvedModel = resolveModel(parsed.model);
  // A DeepSeek-only client's Opus (or any other Claude) request stays on DeepSeek.
  if (deepseekOnly && routeRequest(resolvedModel) === 'anthropic') resolvedModel = SONNET_TARGET;
  if (resolvedModel !== parsed.model) {
    console.log(`${ts()} [resolve] ${parsed.model} → ${resolvedModel}`);
    parsed.model = resolvedModel;
    body = Buffer.from(JSON.stringify(parsed));
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
  // Token counts take no max_tokens.
  if (route === 'anthropic' && !countTokens && typeof parsed.max_tokens !== 'number') {
    parsed.max_tokens = 4096;
    body = Buffer.from(JSON.stringify(parsed));
  }

  if (route === 'deepseek' && normalizeToolAdditions(parsed)) {
    console.log(`${ts()} [normalize] rewrote tool_addition blocks for DeepSeek`);
    body = Buffer.from(JSON.stringify(parsed));
  }
  // After normalizeToolAdditions, so definitions it moved into `tools` are covered.
  if (route === 'deepseek' && fixSchemaPatterns(parsed)) {
    console.log(`${ts()} [normalize] rewrote \\0 in tool schema patterns for DeepSeek`);
    body = Buffer.from(JSON.stringify(parsed));
  }

  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstream = getUpstreamConfig(route, query, countTokens);

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

  let upstreamRes;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    upstreamRes = await fetch(upstream.url, {
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

    // Stream chunks to client as they arrive — avoids buffering the full
    // response, which causes spurious timeouts on long-thinking requests.
    res.writeHead(upstreamRes.status, resHeaders);
    const errPreview = [];
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) {
        res.write(chunk);
        if (errPreview.length < 500) errPreview.push(chunk);
      }
    }
    res.end();

    if (upstreamRes.status >= 400) {
      log(route, model, `status=${upstreamRes.status} body=${Buffer.concat(errPreview).toString().slice(0, 500)}`);
    } else {
      log(route, model, `status=${upstreamRes.status}`);
    }
  } catch (err) {
    // Destroy upstream stream to release the TCP socket back to the pool.
    if (upstreamRes && upstreamRes.body) {
      try { upstreamRes.body.destroy(); } catch (_) {}
    }
    if (err.name === 'AbortError') {
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream timeout' }));
      }
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

  let upstreamRes;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    upstreamRes = await fetch(targetUrl, {
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

    res.writeHead(upstreamRes.status, resHeaders);
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) res.write(chunk);
    }
    res.end();

    if (upstreamRes.status >= 400) {
      // For passthrough, we can't buffer the full body for logging
      console.log(`${ts()} [passthrough] ${req.method} /v1/${suffix} status=${upstreamRes.status}`);
    } else {
      console.log(`${ts()} [passthrough] ${req.method} /v1/${suffix} status=${upstreamRes.status}`);
    }
  } catch (err) {
    if (upstreamRes && upstreamRes.body) {
      try { upstreamRes.body.destroy(); } catch (_) {}
    }
    if (err.name === 'AbortError') {
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream timeout' }));
      }
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

    // Inject DeepSeek models. Dedupe by id so a model the upstream already
    // lists is never duplicated.
    const injectedModels = DEEPSEEK_MODELS;

    const list = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : null);
    if (list) {
      const existing = new Set(list.map((m) => m && m.id));
      for (const m of injectedModels) {
        if (!existing.has(m.id)) list.push(m);
      }
    }

    const modified = JSON.stringify(data);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(modified).toString(),
    });
    res.end(modified);
    console.log(`[models] injected up to ${injectedModels.length} DeepSeek models`);
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
  } else if (isDeepSeekOnly(req)) {
    // Never reaches Anthropic. DeepSeek has no model list, so answer it here.
    req.resume();
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: DEEPSEEK_MODELS, has_more: false }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not available in DeepSeek-only mode' }));
    }
    console.log(`${ts()} [deepseek-only] ${req.method} ${req.url.split('?')[0]} answered locally`);
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
