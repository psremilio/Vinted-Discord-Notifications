import { gunzipSync, brotliDecompressSync } from 'zlib';

export async function parseJsonBody(res) {
  try {
    return await res.body.json();
  } catch (err) {
    const buf = Buffer.from(await res.body.arrayBuffer());
    const enc = res.headers['content-encoding'];
    let decoded = buf;
    if (enc?.includes('gzip')) {
      decoded = gunzipSync(buf);
    } else if (enc?.includes('br')) {
      decoded = brotliDecompressSync(buf);
    }
    return JSON.parse(decoded.toString('utf8'));
  }
}
