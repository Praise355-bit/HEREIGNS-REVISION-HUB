// api/openrouter.js
// Vercel Edge Function — proxies chat requests to OpenRouter.

export const config = { runtime: 'edge' };

// You can change this to any model available on OpenRouter.
// See the full list here: https://openrouter.ai/models
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30000;

// Your OpenRouter API key, read from Vercel's environment variables.
const API_KEY = process.env.OPENROUTER_API_KEY;

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
  if (!API_KEY) {
    return json({ error: 'No API key configured on the server' }, 500);
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

  try {
    const resp = await fetchWithTimeout(
      BASE_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          // These headers are optional but recommended by OpenRouter.
          // They help identify your app on their rankings.
          'HTTP-Referer': process.env.YOUR_SITE_URL || '',
          'X-OpenRouter-Title': process.env.YOUR_SITE_NAME || 'MyApp',
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
      const errData = await resp.json().catch(() => ({}));
      return json(
        { error: errData.error?.message || `API error ${resp.status}` },
        resp.status
      );
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) {
      return json({ error: 'AI returned an empty response' }, 502);
    }
    return json({ content });
  } catch (err) {
    const message = err.name === 'AbortError'
      ? 'Request to OpenRouter timed out'
      : (err.message || 'Network error contacting OpenRouter');
    return json({ error: message }, 503);
  }
}
