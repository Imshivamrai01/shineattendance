// A stand-in for the Google Places API (Text Search) plus a business website, for tests (set PLACES_URL to its address).
import http from 'node:http';

export const PLACES_KEY = `AIza${'x'.repeat(35)}`;

/** Every "cafe" search returns the same four businesses, so a second search finds only repeats. */
export function startPlacesMock(port) {
  const base = `http://127.0.0.1:${port}`;
  const PLACES = [
    { id: 'p1', displayName: { text: 'Cafe One' }, formattedAddress: 'Golghar, Gorakhpur, UP 273001', nationalPhoneNumber: '098765 43210', websiteUri: `${base}/site`,
      rating: 4.5, userRatingCount: 320, googleMapsUri: 'https://maps.google.com/?cid=1', location: { latitude: 26.7606, longitude: 83.3732 }, businessStatus: 'OPERATIONAL',
      addressComponents: [{ longText: 'Golghar', types: ['sublocality_level_1'] }, { longText: 'Gorakhpur', types: ['locality'] }] },
    { id: 'p2', displayName: { text: 'Brew Brothers' }, formattedAddress: 'Civil Lines, Gorakhpur', nationalPhoneNumber: '0551 220 0000', websiteUri: 'https://www.instagram.com/BrewBros.gkp/',
      rating: 3.9, userRatingCount: 12, location: { latitude: 26.77, longitude: 83.37 }, businessStatus: 'OPERATIONAL' },
    { id: 'p3', displayName: { text: 'No Phone Cafe' }, formattedAddress: 'Somewhere', location: { latitude: 26.75, longitude: 83.36 }, businessStatus: 'OPERATIONAL' },
    { id: 'p4', displayName: { text: 'Old Closed Cafe' }, nationalPhoneNumber: '91234 56789', businessStatus: 'CLOSED_PERMANENTLY' },
  ];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (req.url === '/site') return send(200, '<html><a href="https://instagram.com/p/xyz">post</a><a href="https://www.instagram.com/cafe.one_gkp/">Follow us</a> <a href="mailto:hello@cafeone.in">mail</a></html>', 'text/html');
      if (req.method !== 'POST' || req.url !== '/v1/places:searchText') return send(404, { error: { message: 'Not found' } });
      if (req.headers['x-goog-api-key'] !== PLACES_KEY) return send(403, { error: { code: 403, message: 'API key not valid. Please pass a valid API key.' } });
      const body = JSON.parse(raw);
      send(200, { places: /cafe/i.test(body.textQuery) ? PLACES.slice(0, body.pageSize || 20) : [] });
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}
