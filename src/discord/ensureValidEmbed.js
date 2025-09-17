// Ensure Discord embeds are valid and within limits
// API reference: https://discord.com/developers/docs/resources/channel#embed-object-embed-limits

function clamp(str, n) {
  if (!str) return str;
  const s = String(str);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function cleanObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'object') {
      const c = cleanObject(v);
      if (c == null) continue;
      if (Array.isArray(c) && c.length === 0) continue;
      if (!Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    } else if (v !== '') {
      out[k] = v;
    } else {
      // keep empty string only for fields that allow it? safest: drop
    }
  }
  if (Array.isArray(out) && out.length === 0) return undefined;
  if (!Array.isArray(out) && Object.keys(out).length === 0) return undefined;
  return out;
}

export function sanitizeEmbed(embed) {
  const e = embed && typeof embed.toJSON === 'function' ? embed.toJSON() : (embed?.data || embed || {});
  const out = { ...e };

  if (out.title) out.title = clamp(out.title, 256);
  if (out.description) out.description = clamp(out.description, 4096);
  if (out.footer?.text) out.footer.text = clamp(out.footer.text, 2048);
  if (out.author?.name) out.author.name = clamp(out.author.name, 256);
  if (Array.isArray(out.fields) && out.fields.length) {
    out.fields = out.fields.slice(0, 25).map(f => ({
      name: clamp(f?.name ?? '', 256),
      value: clamp(f?.value ?? '', 1024),
      inline: !!f?.inline,
    })).filter(f => f.name && f.value);
  }
  // Discord allows up to 10 embeds per message; enforced by caller
  return cleanObject(out) || {};
}

export function sanitizeEmbeds(arr) {
  if (!Array.isArray(arr)) return [];
  const take = arr.slice(0, 10);
  return take.map(sanitizeEmbed);
}

