// Issues a short-lived client upload token so the browser can PUT the
// encrypted library straight to Vercel Blob storage, bypassing this
// function entirely for the actual bytes. Serverless functions on Vercel
// cap request/response bodies well below what a real music library can
// reach (a handful of imported mp3s already clears a few MB), so routing
// the encrypted zip through here as a JSON payload would break in normal
// use, not just at the extreme.
const { handleUpload } = require('@vercel/blob/client');
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
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const codeHash = pathname.replace(/^sync\//, '').replace(/\.bin$/, '');
        if (!CODE_HASH_RE.test(codeHash) || pathname !== syncPathnameFor(codeHash)) {
          throw new Error('Invalid sync path');
        }
        return {
          allowedContentTypes: ['application/octet-stream'],
          addRandomSuffix: false,
          allowOverwrite: true,
          maximumSizeInBytes: 500 * 1024 * 1024,
          validUntil: Date.now() + 5 * 60 * 1000,
        };
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: (err && err.message) || 'Upload failed' });
  }
};
