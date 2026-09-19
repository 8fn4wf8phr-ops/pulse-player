// Shared helpers for the sync-relay endpoints. Files prefixed with `_` are
// excluded from Vercel's zero-config API routing, so this isn't its own
// endpoint — just a local module the other three import.

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// The ios-app build calls these endpoints cross-origin (from a Capacitor
// webview origin, not pulse-player's own domain), which triggers a
// preflight OPTIONS request browsers don't send for same-origin calls.
function handleOptions(req, res) {
  if (req.method !== 'OPTIONS') return false;
  setCors(res);
  res.status(204).end();
  return true;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const CODE_HASH_RE = /^[0-9a-f]{64}$/;

function syncPathnameFor(codeHash) {
  return `sync/${codeHash}.bin`;
}

module.exports = { setCors, handleOptions, readJsonBody, CODE_HASH_RE, syncPathnameFor };
