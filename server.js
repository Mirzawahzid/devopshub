require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const session = require('express-session');

// Demo credentials — not for production use
const DEMO_USER = 'admin';
const DEMO_PASS = 'password123';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'nutriai-demo-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 } // 1 hour
}));

// Auth middleware — protects everything except login page & assets
function requireAuth(req, res, next) {
  const publicPaths = ['/login', '/login.html'];
  if (req.session.loggedIn || publicPaths.includes(req.path) || req.path.startsWith('/movies')) return next();
  res.redirect('/login.html');
}

// ── Login / Logout ──
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === DEMO_USER && password === DEMO_PASS) {
    req.session.loggedIn = true;
    req.session.username = username;
    return res.redirect('/');
  }
  res.redirect('/login.html?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

// ── Movie App routes (public — no auth) ──────────────────────────────────────

// Serve movie app UI
app.get('/movies', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'movies', 'index.html'));
});

// Shared OMDb lookup helper
async function omdbLookup(params, omdbKey) {
  const qs = new URLSearchParams({ ...params, apikey: omdbKey }).toString();
  const apiRes = await fetch(`https://www.omdbapi.com/?${qs}`);
  const data = await apiRes.json();
  if (data.Response === 'False') throw { status: 404, message: data.Error || 'Movie not found.' };
  return data;
}

function formatOmdb(data) {
  return {
    imdbId:  data.imdbID,
    title:   data.Title,
    year:    data.Year,
    poster:  data.Poster,
    plot:    data.Plot,
    genre:   data.Genre,
    director: data.Director,
    imdbRating: data.imdbRating,
    imdbVotes:  data.imdbVotes,
    ratings: (data.Ratings || []).map(r => ({ source: r.Source, value: r.Value }))
  };
}

// Title → movie info + ratings via OMDb
app.get('/movies/api/search', async (req, res) => {
  const title = (req.query.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title query param is required.' });
  const omdbKey = process.env.OMDB_API_KEY;
  if (!omdbKey) return res.status(500).json({ error: 'Server missing OMDb API key.' });
  try {
    const data = await omdbLookup({ t: title }, omdbKey);
    return res.json(formatOmdb(data));
  } catch (err) {
    console.error('OMDb search error:', err);
    return res.status(err.status || 502).json({ error: err.message || 'Failed to reach OMDb API.' });
  }
});

// IMDb ID → movie info + ratings via OMDb
app.get('/movies/api/ratings', async (req, res) => {
  const id = (req.query.id || '').trim();
  if (!id || !/^tt\d+$/i.test(id)) return res.status(400).json({ error: 'Valid IMDb ID required (e.g. tt0111161).' });
  const omdbKey = process.env.OMDB_API_KEY;
  if (!omdbKey) return res.status(500).json({ error: 'Server missing OMDb API key.' });
  try {
    const data = await omdbLookup({ i: id }, omdbKey);
    return res.json(formatOmdb(data));
  } catch (err) {
    console.error('OMDb ratings error:', err);
    return res.status(err.status || 502).json({ error: err.message || 'Failed to reach OMDb API.' });
  }
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/nutritional-info — proxies the RapidAPI call server-side
app.post('/api/nutritional-info', async (req, res) => {
  const { input } = req.body;

  if (!input || typeof input !== 'string' || input.trim().length === 0) {
    return res.status(400).json({ error: 'input field is required and must be a non-empty string.' });
  }

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing API key configuration.' });
  }

  const callApi = () => fetch('https://ai-nutritional-facts.p.rapidapi.com/getNutritionalInfo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': 'ai-nutritional-facts.p.rapidapi.com',
      'x-rapidapi-key': apiKey
    },
    body: JSON.stringify({ input: input.trim() })
  });

  const delay = ms => new Promise(r => setTimeout(r, ms));

  try {
    let apiRes = await callApi();

    // Retry once on 5xx — the AI model occasionally has transient errors
    if (apiRes.status >= 500) {
      await delay(1500);
      apiRes = await callApi();
    }

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`RapidAPI error ${apiRes.status}:`, errText);
      return res.status(apiRes.status).json({
        error: apiRes.status >= 500
          ? 'The nutrition AI is temporarily unavailable. Please try again in a moment.'
          : `API error ${apiRes.status} — please check your input and try again.`
      });
    }

    const data = await apiRes.json();
    return res.json(data);
  } catch (err) {
    console.error('API fetch error:', err);
    return res.status(502).json({ error: 'Failed to reach the nutritional facts API. Please try again.' });
  }
});

// ── Kubernetes Health Probes ─────────────────────────────────────────────────

// Liveness probe — confirms the process is running and not deadlocked
// Kubernetes restarts the container if this returns non-2xx
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'alive', uptime: process.uptime() });
});

// Readiness probe — confirms the app is ready to receive traffic
// Kubernetes removes the pod from Service endpoints if this returns non-2xx
// Checks that required env vars are configured before accepting requests
app.get('/readyz', (req, res) => {
  const missing = [];
  if (!process.env.RAPIDAPI_KEY) missing.push('RAPIDAPI_KEY');
  if (!process.env.OMDB_API_KEY)  missing.push('OMDB_API_KEY');
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (missing.length > 0) {
    return res.status(503).json({ status: 'not ready', missing });
  }
  res.status(200).json({ status: 'ready', uptime: process.uptime() });
});

// Fallback — serve the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Nutritional Facts app running on port ${PORT}`);
});
