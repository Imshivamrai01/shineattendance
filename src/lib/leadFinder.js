const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'about', 'developer', 'legal', 'direct', 'instagram', 'web']);

/** Profile link or @handle -> https://instagram.com/<handle> (lower case, so it also works as a dedupe key); '' if not a profile. */
export function cleanInstagram(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = /instagram\.com\/([A-Za-z0-9_.]{1,30})/i.exec(s) || /^@?([A-Za-z0-9_.]{1,30})$/.exec(s);
  return m && !IG_RESERVED.has(m[1].toLowerCase()) ? `https://instagram.com/${m[1].toLowerCase().replace(/\.$/, '')}` : '';
}

/*
 * Lead finder: businesses of a category in a place, from
 *  - Google Places (Text Search, New API) when a key is saved: best coverage, phone numbers, ratings, websites;
 *  - OpenStreetMap (Nominatim + Overpass) otherwise: free, no key, fewer phone numbers.
 * Then each business website is opened once to pick up its Instagram profile and email.
 * Every result has the same shape: { name, phone, altPhones, address, area, city, website, instagram, email,
 * mapsUrl, rating, reviews, lat, lng, source, sourceId }.
 * The URLs can be pointed elsewhere with env vars (used by the smoke test's mock).
 */
const UA = 'ShineSalesLeadFinder/1.0 (+https://attendance.shineinfosolutions.in)';
const PLACES_URL = () => process.env.PLACES_URL || 'https://places.googleapis.com';
const NOMINATIM_URL = () => process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
// Public Overpass servers are often busy: the first two are raced, the rest tried one by one.
const OVERPASS_URLS = () => (process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : ['https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']);

async function getJson(url, init = {}, ms = 25000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms), headers: { 'user-agent': UA, ...(init.headers || {}) } });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || text.slice(0, 200) || res.statusText;
    const e = new Error(`${new URL(url).host}: ${msg}`); e.status = res.status; throw e;
  }
  return data;
}

// ---- Google Places ----
const FIELDS = ['id', 'displayName', 'formattedAddress', 'nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri', 'rating',
  'userRatingCount', 'googleMapsUri', 'location', 'businessStatus', 'addressComponents'].map((f) => `places.${f}`).join(',') + ',nextPageToken';

export async function searchGoogle({ key, category, location, max }) {
  const out = [];
  let pageToken;
  do {
    const d = await getJson(`${PLACES_URL()}/v1/places:searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': FIELDS },
      body: JSON.stringify({ textQuery: `${category} in ${location}`, pageSize: 20, languageCode: 'en', ...(pageToken ? { pageToken } : {}) }),
    });
    for (const p of d?.places || []) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      const comp = (t) => p.addressComponents?.find((c) => c.types?.includes(t))?.longText;
      const site = p.websiteUri || '';
      out.push({
        name: p.displayName?.text || '', phone: p.nationalPhoneNumber || p.internationalPhoneNumber || '', altPhones: [],
        address: p.formattedAddress || '', area: comp('sublocality_level_1') || comp('sublocality') || comp('neighborhood') || '',
        city: comp('locality') || comp('administrative_area_level_3') || '',
        website: /instagram\.com/i.test(site) ? '' : site, instagram: cleanInstagram(/instagram\.com/i.test(site) ? site : ''),
        email: '', mapsUrl: p.googleMapsUri || '', rating: p.rating, reviews: p.userRatingCount,
        lat: p.location?.latitude, lng: p.location?.longitude, source: 'GOOGLE', sourceId: `g:${p.id}`,
      });
    }
    pageToken = d?.nextPageToken;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

/** Cheapest possible call (ids only) to check a key works and has the Places API (New) enabled. */
export async function checkGoogleKey(key) {
  await getJson(`${PLACES_URL()}/v1/places:searchText`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': 'places.id' },
    body: JSON.stringify({ textQuery: 'cafe in New Delhi', pageSize: 1 }),
  }, 15000);
}

// ---- OpenStreetMap ----
// Common categories -> OSM tags. Anything else is matched on the business name (and shop/amenity value).
const OSM_TAGS = {
  restaurant: ['amenity=restaurant', 'amenity=fast_food'], cafe: ['amenity=cafe'], hotel: ['tourism=hotel', 'tourism=guest_house', 'tourism=motel'],
  gym: ['leisure=fitness_centre', 'leisure=sports_centre'], salon: ['shop=hairdresser', 'shop=beauty'], spa: ['leisure=spa', 'shop=massage', 'shop=beauty'],
  clinic: ['amenity=clinic', 'amenity=doctors'], doctor: ['amenity=doctors', 'amenity=clinic'], hospital: ['amenity=hospital'], dentist: ['amenity=dentist'],
  pharmacy: ['amenity=pharmacy', 'shop=chemist'], school: ['amenity=school'], college: ['amenity=college', 'amenity=university'],
  coaching: ['amenity=school', 'office=educational_institution', 'amenity=training'], bakery: ['shop=bakery', 'shop=pastry'], jeweller: ['shop=jewelry'],
  jewellery: ['shop=jewelry'], clothes: ['shop=clothes', 'shop=boutique', 'shop=tailor'], boutique: ['shop=boutique', 'shop=clothes'],
  electronics: ['shop=electronics', 'shop=mobile_phone', 'shop=computer'], mobile: ['shop=mobile_phone'], furniture: ['shop=furniture'],
  hardware: ['shop=hardware', 'shop=doityourself'], 'real estate': ['office=estate_agent'], 'car dealer': ['shop=car'], car: ['shop=car', 'shop=car_repair'],
  bike: ['shop=motorcycle', 'shop=bicycle'], optician: ['shop=optician'], supermarket: ['shop=supermarket', 'shop=convenience'], grocery: ['shop=convenience', 'shop=supermarket', 'shop=greengrocer'],
  'sweet shop': ['shop=confectionery', 'shop=pastry'], bar: ['amenity=bar', 'amenity=pub'], bank: ['amenity=bank'], 'travel agent': ['shop=travel_agency'],
  lawyer: ['office=lawyer'], 'ca': ['office=accountant'], accountant: ['office=accountant'], 'it company': ['office=it', 'office=company'],
  'wedding': ['amenity=events_venue', 'shop=wedding'], banquet: ['amenity=events_venue'], photographer: ['shop=photo', 'craft=photographer'],
  'pet shop': ['shop=pet'], veterinary: ['amenity=veterinary'], petrol: ['amenity=fuel'], 'book shop': ['shop=books', 'shop=stationery'],
};

function osmFilters(category) {
  const c = category.toLowerCase().trim().replace(/s$/, '');
  const tags = OSM_TAGS[c] || OSM_TAGS[category.toLowerCase().trim()] || Object.entries(OSM_TAGS).find(([k]) => c.includes(k) || k.includes(c))?.[1] || [];
  const word = c.replace(/["\\]/g, '').slice(0, 40);
  return [...tags.map((t) => { const [k, v] = t.split('='); return `["${k}"="${v}"]`; }), `["name"~"${word}",i]`];
}

async function geocode(location) {
  const d = await getJson(`${NOMINATIM_URL()}/search?format=jsonv2&limit=1&q=${encodeURIComponent(location)}`, { headers: { 'accept-language': 'en' } }, 15000);
  const p = d?.[0];
  if (!p) throw new Error(`Couldn't find the place "${location}". Try "Area, City".`);
  let [s, n, w, e] = p.boundingbox.map(Number);
  const lat = Number(p.lat), lng = Number(p.lon);
  // A whole state / district would time out: keep ~35 km around the centre.
  if (n - s > 0.35) { s = lat - 0.16; n = lat + 0.16; }
  if (e - w > 0.35) { w = lng - 0.16; e = lng + 0.16; }
  // A single point (a street) gets ~2 km around it.
  if (n - s < 0.02) { s = lat - 0.01; n = lat + 0.01; }
  if (e - w < 0.02) { w = lng - 0.01; e = lng + 0.01; }
  return { bbox: [s, w, n, e].map((x) => x.toFixed(5)).join(','), name: p.display_name };
}

export async function searchOsm({ category, location, max }) {
  const { bbox } = await geocode(location);
  const q = `[out:json][timeout:25];(${osmFilters(category).map((f) => `nwr${f}(${bbox});`).join('')});out center tags ${Math.min(max * 3, 600)};`;
  const ask = (url, ms) => getJson(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(q)}` }, ms);
  const [first, ...rest] = [OVERPASS_URLS().slice(0, 2), ...OVERPASS_URLS().slice(2)];
  let d, lastErr;
  try { d = await Promise.any(first.map((u) => ask(u, 40000))); } catch (e) { lastErr = e.errors?.at(-1) || e; }
  for (const url of rest) {
    if (d) break;
    try { d = await ask(url, 20000); } catch (e) { lastErr = e; }
  }
  if (!d) {
    console.warn('overpass failed', lastErr?.message?.slice(0, 300));
    throw new Error('OpenStreetMap is busy right now. Try again in a minute, or add a Google Places key (Sales → Team) for reliable results.');
  }
  const out = [];
  for (const el of d.elements || []) {
    const t = el.tags || {};
    if (!t.name) continue;
    const phones = [t.phone, t['contact:phone'], t['contact:mobile'], t.mobile].filter(Boolean).join(';').split(/[;,/]/).map((x) => x.trim()).filter(Boolean);
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    const site = t.website || t['contact:website'] || t.url || '';
    const city = t['addr:city'] || t['addr:district'] || '';
    const address = [t['addr:housenumber'], t['addr:street'], t['addr:suburb'] || t['addr:neighbourhood'], city, t['addr:postcode']].filter(Boolean).join(', ') || t['addr:full'] || '';
    out.push({
      name: t.name, phone: phones[0] || '', altPhones: phones.slice(1, 4), address,
      area: t['addr:suburb'] || t['addr:neighbourhood'] || '', city,
      website: /instagram\.com/i.test(site) ? '' : site,
      instagram: cleanInstagram(t['contact:instagram'] || t.instagram || (/instagram\.com/i.test(site) ? site : '')),
      email: t.email || t['contact:email'] || '', mapsUrl: lat ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : '',
      lat, lng, source: 'OSM', sourceId: `osm:${el.type}/${el.id}`,
    });
  }
  // Ones with a phone number first: they are the useful ones.
  out.sort((a, b) => Number(!!b.phone) - Number(!!a.phone));
  return out.slice(0, max);
}

// ---- Website enrichment ----
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:com|in|co\.in|net|org|biz|info|co)\b/;

async function scanSite(url) {
  try {
    const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const res = await fetch(u, { signal: AbortSignal.timeout(6000), redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; ShineSalesLeadFinder/1.0)', accept: 'text/html' } });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || 'html')) return {};
    const html = (await res.text()).slice(0, 500000);
    let instagram = '';
    for (const m of html.matchAll(/instagram\.com\/([A-Za-z0-9_.]{2,30})/gi)) {
      if (!IG_RESERVED.has(m[1].toLowerCase())) { instagram = cleanInstagram(m[0]); break; }
    }
    const mail = /mailto:([^"'?>\s]+)/i.exec(html)?.[1] || EMAIL_RE.exec(html)?.[0] || '';
    return { instagram, email: /\.(png|jpe?g|gif|webp|svg)$/i.test(mail) ? '' : decodeURIComponent(mail) };
  } catch { return {}; }
}

/** Opens up to `limit` websites (6 at a time) to fill in missing Instagram / email. Mutates the leads. */
export async function enrich(leads, limit = 25) {
  const todo = leads.filter((l) => l.website && (!l.instagram || !l.email)).slice(0, limit);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const l = todo[i++];
      const r = await scanSite(l.website);
      if (!l.instagram && r.instagram) l.instagram = r.instagram;
      if (!l.email && r.email) l.email = r.email;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return todo.length;
}

export async function findLeads({ source, key, category, location, max }) {
  const list = source === 'GOOGLE' ? await searchGoogle({ key, category, location, max }) : await searchOsm({ category, location, max });
  return list.filter((l) => l.name);
}
