export async function parseJsonBody(res) {
  const ct = (res.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return null;

  let buffer;
  try {
    buffer = Buffer.from(await res.body.arrayBuffer());
  } catch {
    return null;
  }

  if (buffer.length === 0) return null;

  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (e) {
    console.warn('[parse] invalid JSON, length=', buffer.length);
    return null;
  }
}
