// api/groq.js
// Vercel Serverless Function — proxies requests to Groq so the API key
// never reaches the browser. Deploy this file as-is inside an /api folder
// at your project root (Vercel auto-detects it, no config needed).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GROQ_API_KEYS;
  if (!apiKey) {
    // This means the env var wasn't set in the Vercel dashboard — see setup steps.
    return res.status(500).json({ error: 'Server misconfigured: GROQ_API_KEYS missing' });
  }

  // Optional but recommended: only allow requests from your own site,
  // so people can't point random apps at your proxy and burn your quota.
  const allowedOrigin = process.env.ALLOWED_ORIGIN; // e.g. "https://your-site.vercel.app"
  const origin = req.headers.origin || '';
  if (allowedOrigin && origin !== allowedOrigin) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }

  try {
    const body = { ...req.body };

    // Optional but recommended: cap max_tokens server-side so a malicious
    // or buggy client can't run up a huge bill on your key.
    if (!body.max_tokens || body.max_tokens > 4096) {
      body.max_tokens = 4096;
    }

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await groqRes.json();
    return res.status(groqRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
