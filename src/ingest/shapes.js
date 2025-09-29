import { normalizeTimestampMs } from '../utils/time.js';

function coerceNumber(value, fallback = 0) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function collectImages(item) {
  const out = [];
  try {
    const add = (val) => {
      if (!val) return;
      if (typeof val === 'string') {
        if (val.trim()) out.push(val.trim());
        return;
      }
      if (typeof val === 'object') {
        const { url, full_size_url, hd_url, thumb_url, high_resolution_url } = val;
        const chosen = url || full_size_url || hd_url || high_resolution_url || thumb_url;
        if (chosen && typeof chosen === 'string') out.push(chosen);
      }
    };

    if (Array.isArray(item?.images)) {
      for (const img of item.images) add(img);
    }
    if (Array.isArray(item?.photos)) {
      for (const img of item.photos) add(img);
    }
    if (item?.photo) add(item.photo);
    if (item?.image_url) add(item.image_url);
    if (Array.isArray(item?.image_urls)) {
      for (const img of item.image_urls) add(img);
    }
  } catch {}
  return out.slice(0, 6);
}

function normalizePrice(raw = {}) {
  const amount = coerceNumber(raw.amount ?? raw.value ?? raw.price ?? raw.price_numeric ?? raw);
  const converted = coerceNumber(raw.converted_amount);
  const currency = String(raw.currency_code || raw.currency || '').toUpperCase() || 'EUR';
  return {
    amount,
    converted_amount: Number.isFinite(converted) && converted > 0 ? converted : null,
    currency_code: currency,
  };
}

export function normalizeListing(raw = {}) {
  const item = raw?.item ?? raw ?? {};
  const priceInfo = normalizePrice(item.price || item);
  const priceAmount = priceInfo.amount;
  const createdTs = normalizeTimestampMs(item.created_at_ts) || normalizeTimestampMs(item.created_at) || Date.now();
  const location = item.city || item.location || item.country || '';
  const seller = item.user || item.seller || {};
  return {
    id: String(item.id ?? item.item_id ?? item.uuid ?? item.code ?? ''),
    title: item.title || item.name || '',
    url: item.url || item.permalink || '',
    description: item.description || item.subtitle || '',
    brand: item.brand?.title || item.brand_title || item.brand_name || '',
    brand_id: item.brand?.id || item.brand_id || '',
    size: item.size_title || item.size || item.size_name || '',
    status: item.status || item.condition || '',
    location,
    catalog_id: item.catalog_id || item.catalog?.id || '',
    price: priceAmount,
    price_info: priceInfo,
    price_eur: priceInfo.currency_code === 'EUR' ? priceAmount : priceInfo.converted_amount,
    currency: priceInfo.currency_code,
    seller: {
      id: seller.id || seller.user_id || '',
      name: seller.login || seller.name || seller.username || '',
      avatar: seller.avatar || seller.profile_picture || seller.photo || '',
      rating: coerceNumber(seller?.positive_feedback_count ?? seller?.rating ?? 0),
    },
    images: collectImages(item),
    createdAt: createdTs,
    created_at: createdTs,
    discoveredAt: Date.now(),
    raw: item,
  };
}

export function isValidListing(item) {
  if (!item) return false;
  if (!item.id || !item.url || !item.title) return false;
  const price = item.price ?? item.price_amount ?? item.price_info?.amount ?? item.price;
  if (!Number.isFinite(Number(price))) return false;
  return true;
}