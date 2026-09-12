// api/groq.js
// Vercel Edge Function — proxies chat requests to Groq using server-side keys.
// The keys never reach the browser; only this function sees them.

export const config = { runtime: 'edge' };

const MODEL = 'llama-3.1-8b-instant';
const BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Limits, raised ────────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = 120_000;     // was 30s  — 2 min per attempt
const MAX_PROMPT_CHARS   = 500_000;     // was 32k  — ~125k tokens worth of chars
const MAX_TOKENS_CAP     = 8192;        // Groq's hard output ceiling for this model
const DEFAULT_MAX_TOKENS = 8192;        // was 2048 — start at the ceiling
const DEFAULT_TEMPERATURE = 0.7;        // was 0.6
const MAX_TEMPERATURE    = 2;           // Groq's hard ceiling

// Comma-separated list; whitespace is trimmed. Set GROQ_KEYS in Vercel env vars.
const KEYS = (process.env.GROQ_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Bad/limited key → rotate to the next one.
function isKeyExhaustedStatus(status) {
  return status === 401 || status === 403 || status === 402 || status === 429;
}

// Transient upstream failure → rotate (could be a Groq-side hiccup on this key).
function isRetryableStatus(status) {
  return status >= 500 && status <= 599;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (KEYS.length === 0) {
    return json({ error: 'No API keys configured on the server' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const {
    prompt,
    temperature = DEFAULT_TEMPERATURE,
    max_tokens  = DEFAULT_MAX_TOKENS,
  } = body || {};

  if (!prompt || typeof prompt !== 'string') {
    return json({ error: 'Missing prompt' }, 400);
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json({ error: `Prompt too long (max ${MAX_PROMPT_CHARS} chars)` }, 413);
  }

  const safeTemp = Math.min(
    Math.max(Number(temperature) || DEFAULT_TEMPERATURE, 0),
    MAX_TEMPERATURE
  );

  const parsedMax = parseInt(max_tokens, 10);
  const safeMaxTokens = Math.min(
    Math.max(Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_TOKENS, 1),
    MAX_TOKENS_CAP
  );

  let lastMessage = 'All AI keys are currently unavailable. Please try again later.';

  for (const key of KEYS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let resp;
    try {
      resp = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: safeTemp,
          max_tokens: safeMaxTokens,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastMessage =
        err.name === 'AbortError'
          ? `Upstream request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : err.message || 'Network error contacting Groq';
      continue;
    }
    clearTimeout(timer);

    if (!resp.ok) {
      if (isKeyExhaustedStatus(resp.status) || isRetryableStatus(resp.status)) {
        lastMessage = `Upstream error (HTTP ${resp.status})`;
        await resp.text().catch(() => {});
        continue;
      }
      const errData = await resp.json().catch(() => ({}));
      return json(
        { error: errData.error?.message || `API error ${resp.status}` },
        resp.status
      );
    }

    let data;
    try {
      data = await resp.json();
    } catch {
      lastMessage = 'Malformed response from upstream';
      continue;
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      lastMessage = 'Empty response from upstream';
      continue;
    }

    return json({ content });
  }

  return json({ error: lastMessage }, 503);
}
