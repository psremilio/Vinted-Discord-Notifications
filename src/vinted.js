import { request } from 'undici';

export async function fetchVinted(params = {}) {
  const market = (process.env.MARKET || 'de').toLowerCase();
  const host = `https://www.vinted.${market}`;
  const url = new URL('/api/v2/catalog/items', host);
  if (params.q) url.searchParams.set('search_text', params.q);
  if (params.size) url.searchParams.set('size_id', params.size);
  if (params.cat) url.searchParams.set('catalog_ids', params.cat);
  url.searchParams.set('order', params.order || 'desc');
  url.searchParams.set('time', 'now');

  const res = await request(url, {
    method: 'GET',
    headers: {
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0'
    }
  });

  if (res.statusCode === 429 || res.statusCode === 403) {
    const err = new Error(`HTTP ${res.statusCode}`);
    err.status = res.statusCode;
    throw err;
  }
  if (res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);

  const data = await res.body.json();
  const items = (data?.items || []).map(i => ({
    id: i.id,
    title: i.title,
    url: `${host}/items/${i.id}`,
    images: i.photos?.length ? [i.photos[0]?.url] : [],
    brand: i.brand_title,
    size: i.size_title,
    condition: i.status,
    location: i.city,
    seller: { name: i.user?.login, rating: i.user?.positive_feedback_count },
    price: i.price?.amount,
    currency: i.price?.currency_code,
    createdAt: i.created_at_ts ? i.created_at_ts * 1000 : Date.now(),
    shipping: i.shipping?.default?.price || null,
  }));
  return items;
}
