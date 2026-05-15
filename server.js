import { createServer } from 'node:http';

const PORT = parseInt(process.env.PROXY_PORT || '3456', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE_MB || '10', 10) * 1024 * 1024;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEEPSEEK_URL = 'https://api.deepseek.com/anthropic/v1/messages';

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var is required');
  process.exit(1);
}
if (!DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY env var is required');
  process.exit(1);
}

function routeRequest(model) {
  if (model && model.includes('deepseek')) return 'deepseek';
  if (model && model.includes('claude')) return 'anthropic';
  return null;
}

function getUpstreamConfig(route) {
  if (route === 'deepseek') {
    return { url: DEEPSEEK_URL, key: DEEPSEEK_API_KEY };
  }
  return { url: ANTHROPIC_URL, key: ANTHROPIC_API_KEY };
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

  let model;
  try {
    model = JSON.parse(body.toString()).model;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON body' }));
    return;
  }

  const route = routeRequest(model);
  if (!route) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `unsupported model: ${model}` }));
    return;
  }

  const upstream = getUpstreamConfig(route);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host') continue;
    if (k === 'x-api-key') continue;
    if (k === 'content-length') { headers[k] = v; continue; }
    if (k.startsWith('anthropic-beta') && route === 'deepseek') continue;
    headers[k] = v;
  }
  headers['x-api-key'] = upstream.key;
  headers['content-type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(upstream.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));

    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) {
        res.write(chunk);
      }
    }
    res.end();
    console.log(`[${route}] model=${model} status=${upstreamRes.status}`);
  } catch (err) {
    if (err.name === 'AbortError') {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream timeout' }));
      console.log(`[${route}] model=${model} TIMEOUT`);
    } else {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream connection failed' }));
      }
      console.error(`[${route}] model=${model} ERROR: ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/messages') {
    proxyRequest(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cc-proxy listening on 127.0.0.1:${PORT}`);
  console.log(`  Anthropic: ${ANTHROPIC_URL}`);
  console.log(`  DeepSeek:  ${DEEPSEEK_URL}`);
});
