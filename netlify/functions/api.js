/* ═══════════════════════════════════════════════════════════════
   TCG GREEDO — Serverless API Function
   ═══════════════════════════════════════════════════════════════
   Runs on Netlify. Holds all API keys server-side.
   Admin page calls this function — never touches keys directly.

   Environment variables needed in Netlify dashboard:
     ANTHROPIC_API_KEY  — your Claude API key
     GITHUB_TOKEN       — GitHub fine-grained PAT
     GITHUB_REPO        — "nickmabini/tcggreedo"
     ADMIN_PASSWORD     — password for admin page
   ═══════════════════════════════════════════════════════════════ */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'nickmabini/tcggreedo';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PSA_API_TOKEN = process.env.PSA_API_TOKEN;

// ── CORS headers ────────────────────────────────────────────────
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ── Main handler ────────────────────────────────────────────────
exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { action, password, ...payload } = JSON.parse(event.body);

    // Auth check
    if (password !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    switch (action) {
      case 'parse-slab':      return await parseSlab(payload);
      case 'get-inventory':   return await getInventory();
      case 'save-inventory':  return await saveInventory(payload);
      case 'upload-image':    return await uploadImage(payload);
      case 'fetch-psa-scan':  return await fetchPsaScan(payload);
      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }
  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal error' })
    };
  }
};

// ═══════════════════════════════════════════════════════════════
// ACTION: parse-slab
// Sends slab photo to Claude API, returns parsed label fields
// ═══════════════════════════════════════════════════════════════
async function parseSlab({ imageBase64, mimeType }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType || 'image/jpeg',
              data: imageBase64
            }
          },
          {
            type: 'text',
            text: `Read the grading label on this PSA or CGC slab. Return ONLY a JSON object with these fields, nothing else, no markdown backticks:
{
  "name": "card name (e.g. Charizard, Rocket's Snorlax ex)",
  "set": "set name (e.g. Base Set, Team Rocket Returns)",
  "year": 2004,
  "cardNumber": "card number in set (e.g. 104/109, DP45)",
  "grader": "PSA or CGC or BGS",
  "grade": 9,
  "cert": "cert number from the label"
}
If you cannot read a field, use null for that field.`
          }
        ]
      }]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'Claude API error');
  }

  // Extract text from response
  const text = data.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');

  // Parse JSON from response (strip any accidental markdown fences)
  const clean = text.replace(/```json\s*|```\s*/g, '').trim();
  const parsed = JSON.parse(clean);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ parsed })
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION: get-inventory
// Reads inventory.json from GitHub repo
// ═══════════════════════════════════════════════════════════════
async function getInventory() {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/tcggreedo/inventory.json`,
    {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }
  );

  if (response.status === 404) {
    // File doesn't exist yet — return empty inventory
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ inventory: [], sha: null })
    };
  }

  if (!response.ok) {
    throw new Error('Failed to fetch inventory from GitHub');
  }

  const data = await response.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  const inventory = JSON.parse(content);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ inventory, sha: data.sha })
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION: save-inventory
// Writes inventory.json to GitHub repo (creates or updates)
// ═══════════════════════════════════════════════════════════════
async function saveInventory({ inventory, sha }) {
  const content = Buffer.from(
    JSON.stringify(inventory, null, 2)
  ).toString('base64');

  const body = {
    message: `Update inventory — ${new Date().toISOString().split('T')[0]}`,
    content,
    branch: 'main'
  };

  // If we have a sha, it's an update; otherwise it's a create
  if (sha) body.sha = sha;

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/tcggreedo/inventory.json`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.message || 'Failed to save inventory');
  }

  const data = await response.json();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ sha: data.content.sha })
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION: upload-image
// Uploads a slab image to GitHub repo /images/ folder
// ═══════════════════════════════════════════════════════════════
async function uploadImage({ imageBase64, filename }) {
  const path = `images/${filename}`;

  // Check if file already exists (get sha for update)
  let existingSha = null;
  try {
    const check = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
      {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    if (check.ok) {
      const existing = await check.json();
      existingSha = existing.sha;
    }
  } catch (e) { /* file doesn't exist, that's fine */ }

  const body = {
    message: `Add slab image ${filename}`,
    content: imageBase64,
    branch: 'main'
  };
  if (existingSha) body.sha = existingSha;

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.message || 'Failed to upload image');
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ path })
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION: fetch-psa-scan
// Fetches the official PSA slab scan image from psacard.com
// ═══════════════════════════════════════════════════════════════
async function fetchPsaScan({ name, set, cardNumber, grader, grade, cert }) {
  // Fetch clean card art from PokemonTCG API
  try {
    // Build search query — try name + set first, fall back to name only
    let query = '';
    if (name && set) {
      query = `name:"${name.replace(/—.*/,'').trim()}" set.name:"${set}"`;
    } else if (name) {
      query = `name:"${name.replace(/—.*/,'').trim()}"`;
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ imageBase64: null, message: 'No card name to search' }) };
    }

    const response = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&pageSize=5`,
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!response.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ imageBase64: null, message: 'Card API error — status ' + response.status }) };
    }

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
      // Retry with just the name (set name mismatch is common)
      const fallbackQuery = `name:"${name.replace(/—.*/,'').trim()}"`;
      const fallbackRes = await fetch(
        `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(fallbackQuery)}&pageSize=5`,
        { headers: { 'Content-Type': 'application/json' } }
      );
      const fallbackData = await fallbackRes.json();
      if (!fallbackData.data || fallbackData.data.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ imageBase64: null, message: 'Card not found in PokemonTCG database' }) };
      }
      data.data = fallbackData.data;
    }

    // Try to match by card number if multiple results
    let card = data.data[0];
    if (cardNumber && data.data.length > 1) {
      const numMatch = data.data.find(c => c.number === cardNumber.split('/')[0]);
      if (numMatch) card = numMatch;
    }

    const imageUrl = card.images?.large || card.images?.small;
    if (!imageUrl) {
      return { statusCode: 200, headers, body: JSON.stringify({ imageBase64: null, message: 'No image available for this card' }) };
    }

    // Download the card image
    const imgResponse = await fetch(imageUrl);
    if (!imgResponse.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ imageBase64: null, message: 'Image download failed' }) };
    }

    const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
    const imageBase64 = imgBuffer.toString('base64');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        imageBase64,
        mimeType: 'image/png',
        cardName: card.name,
        setName: card.set?.name,
        message: 'Card image found'
      })
    };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ imageBase64: null, message: 'Error: ' + err.message }) };
  }
}
