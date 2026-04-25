require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

  try {
    const apiRes = await fetch('https://ai-nutritional-facts.p.rapidapi.com/getNutritionalInfo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'ai-nutritional-facts.p.rapidapi.com',
        'x-rapidapi-key': apiKey
      },
      body: JSON.stringify({ input: input.trim() })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return res.status(apiRes.status).json({ error: `Upstream API error: ${errText}` });
    }

    const data = await apiRes.json();
    return res.json(data);
  } catch (err) {
    console.error('API fetch error:', err);
    return res.status(502).json({ error: 'Failed to reach the nutritional facts API.' });
  }
});

// Fallback — serve the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Nutritional Facts app running on port ${PORT}`);
});
