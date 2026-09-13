// api/gemini.js
// Vercel Edge Function — proxies chat requests to Google Gemini using
// server-side API keys via Gemini's OpenAI-compatible endpoint.
// Keys never reach the browser; only this function sees them.
//
// Set GEMINI_KEYS in Vercel → Project → Settings → Environment Variables
// as a comma-separated list of Gemini API keys, e.g.:
//   GEMINI_KEYS=AIzaSy...key1,AIzaSy...key2,AIzaSy...key3

export const config = { runtime: 'edge' };

// "gemini-3.8-flash" is the current model in Google's official OpenAI-compat
// docs (ai.google.dev/gemini-api/docs/openai). If Google renames/retires it,
// swap this for the new name — or point it at the rolling alias
// "gemini-flash-latest", which Google keeps pinned to their current
// recommended flash model.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const REQUEST_TIMEOUT_MS = 30000;

const KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

function shuffledKeys() {
  // Spread load across keys instead of always hammering the first one —
  // otherwise key[0] hits its rate limit first on every request and every
  // single call pays the latency cost of failing over.
  const arr = [...KEYS];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isKeyExhaustedStatus(status) {
  // 401/403 = bad or revoked key, 429 = rate-limited, 402 = billing/quota —
  // all mean "this key is no good right now, try the next one."
  return status === 401 || status === 403 || status === 429 || status === 402;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req) {
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

  const { prompt, temperature = 0.6, max_tokens = 2048 } = body || {};
  if (!prompt || typeof prompt !== 'string') {
    return json({ error: 'Missing prompt' }, 400);
  }
  const safeTemp = Math.min(Math.max(Number(temperature) || 0.6, 0), 2);
  const safeMaxTokens = Math.min(Math.max(parseInt(max_tokens, 10) || 2048, 1), 8192);

  let lastMessage = 'All AI keys are currently unavailable. Please try again later.';
  let lastStatus = 503;

  for (const key of shuffledKeys()) {
    try {
      const resp = await fetchWithTimeout(
        BASE_URL,
        {
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
        },
        REQUEST_TIMEOUT_MS
      );

      if (!resp.ok) {
        if (isKeyExhaustedStatus(resp.status)) {
          lastMessage = `Upstream key exhausted (HTTP ${resp.status})`;
          lastStatus = resp.status;
          continue; // try the next key
        }
        // Not a key-rotation-worthy error (e.g. bad request, model not
        // found, server error) — no point retrying with other keys.
        const errData = await resp.json().catch(() => ({}));
        return json(
          { error: errData.error?.message || `API error ${resp.status}` },
          resp.status
        );
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';
      if (!content) {
        // Upstream returned 200 but no usable content (e.g. hit a safety
        // filter or max_tokens cut it off with nothing generated) — treat
        // this as a soft failure and try the next key rather than sending
        // the app JSON.parse('').
        lastMessage = 'AI returned an empty response';
        lastStatus = 502;
        continue;
      }
      return json({ content });
    } catch (err) {
      lastMessage = err.name === 'AbortError'
        ? 'Request to Google timed out'
        : (err.message || 'Network error contacting Google API');
      lastStatus = 503;
    }
  }

  return json({ error: lastMessage }, lastStatus);
}
