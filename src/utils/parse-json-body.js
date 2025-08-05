import { gunzipSync, brotliDecompressSync } from 'zlib';

export async function parseJsonBody(res) {
  const chunks = [];
  for await (const chunk of res.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const enc = res.headers['content-encoding'] || '';
  let decoded = buffer;

  if (enc.includes('gzip')) {
    decoded = gunzipSync(buffer);
  } else if (enc.includes('br')) {
    decoded = brotliDecompressSync(buffer);
  }

  return JSON.parse(decoded.toString('utf8'));
}
