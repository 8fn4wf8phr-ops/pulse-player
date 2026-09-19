// Looks up a sync code's blob and hands back its URL rather than proxying
// the encrypted bytes through this function (same request/response size
// concern as sync-upload.js — see that file's comment). The browser fetches
// the actual data straight from Blob storage; this endpoint only does the
// small control-plane work of checking existence and expiry.
const { head, del } = require('@vercel/blob');
const { setCors, handleOptions, CODE_HASH_RE, syncPathnameFor } = require('./_lib');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const codeHash = typeof req.query.codeHash === 'string' ? req.query.codeHash : '';
  if (!CODE_HASH_RE.test(codeHash)) {
    res.status(400).json({ error: 'Invalid code' });
    return;
  }

  const pathname = syncPathnameFor(codeHash);
  try {
    const meta = await head(pathname);
    const ageMs = Date.now() - new Date(meta.uploadedAt).getTime();
    if (ageMs > MAX_AGE_MS) {
      await del(pathname).catch(() => {});
      res.status(404).json({ error: 'Code not found or expired' });
      return;
    }
    res.status(200).json({ url: meta.url });
  } catch (err) {
    res.status(404).json({ error: 'Code not found or expired' });
  }
};
