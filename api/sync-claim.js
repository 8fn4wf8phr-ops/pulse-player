// A small addition beyond the original two-endpoint design: deleting the
// blob only gets called here, after the client has already fetched and
// decrypted it successfully — not immediately when sync-download.js hands
// back the URL. Deleting at hand-back time races the client's own fetch of
// that same URL (which happens moments later, over the network); on a slow
// connection or a large library that race is lost often enough to matter,
// not just in theory.
const { del } = require('@vercel/blob');
const { setCors, handleOptions, readJsonBody, CODE_HASH_RE, syncPathnameFor } = require('./_lib');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const codeHash = typeof body.codeHash === 'string' ? body.codeHash : '';
    if (!CODE_HASH_RE.test(codeHash)) {
      res.status(400).json({ error: 'Invalid code' });
      return;
    }
    await del(syncPathnameFor(codeHash)).catch(() => {});
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Claim failed' });
  }
};
