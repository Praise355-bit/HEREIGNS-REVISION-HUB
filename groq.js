// api/groq.js
// Vercel Edge Function — proxies chat requests to Groq using server-side keys.
// The keys never reach the browser; only this function sees them.

export const config = { runtime: 'edge' };

const MODEL = 'llama-3.3-70b-versatile';
const BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Read keys from a single env var: comma-separated list, no spaces needed
// (trimmed automatically). Set GROQ_KEYS in Vercel → Project → Settings → Environment Variables.
const KEYS = (process.env.GROQ_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

function isKeyExhaustedStatus(status) {
  return status === 401 || status === 403 || status === 429 || status === 402;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
  // Basic sanity caps so one request can't rack up runaway usage
  const safeTemp = Math.min(Math.max(Number(temperature) || 0.6, 0), 2);
  const safeMaxTokens = Math.min(Math.max(parseInt(max_tokens, 10) || 2048, 1), 8192);

  let lastMessage = 'All AI keys are currently unavailable. Please try again later.';

  for (const key of KEYS) {
    try {
      const resp = await fetch(BASE_URL, {
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
      });

      if (!resp.ok) {
        if (isKeyExhaustedStatus(resp.status)) {
          // This key is done (rate-limited / out of credits / invalid) — try the next one
          lastMessage = `Upstream key exhausted (HTTP ${resp.status})`;
          continue;
        }
        const errData = await resp.json().catch(() => ({}));
        return json(
          { error: errData.error?.message || `API error ${resp.status}` },
          resp.status
        );
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';
      return json({ content });
    } catch (err) {
      lastMessage = err.message || 'Network error contacting Groq';
    }
  }

  return json({ error: lastMessage }, 503);
}