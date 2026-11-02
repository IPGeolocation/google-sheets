const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  process.env.IPGEO_TEST_SOURCE || path.join(__dirname, '..', 'Code.gs'),
  'utf8'
);

function loadScript(settings = {}) {
  const key = settings.key === undefined ? 'test-key-123' : settings.key;
  const properties = new Map(key ? [['IPGEOLOCATION_API_KEY', key]] : []);
  const entries = new Map();
  const requests = [];
  const writes = [];
  const ui = {
    Button: { OK: 'OK' },
    ButtonSet: { OK_CANCEL: 'OK_CANCEL' },
    prompt: () => ({
      getSelectedButton: () => settings.button || 'OK',
      getResponseText: () => settings.prompt === undefined ? ' new-key ' : settings.prompt
    }),
    alert: () => {}
  };
  const cache = {
    get: key => {
      if (settings.readError) throw new Error('Cache unavailable');
      if (settings.cached !== undefined) return settings.cached;
      return entries.get(key) || null;
    },
    put: (key, value, ttl) => {
      if (settings.writeError) throw new Error('Cache unavailable');
      assert.ok(Buffer.byteLength(value, 'utf8') <= 100000);
      writes.push({ key, value, ttl });
      entries.set(key, value);
    }
  };
  const context = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.get(key) || null,
        setProperty: (key, value) => properties.set(key, value),
        deleteProperty: key => properties.delete(key)
      })
    },
    SpreadsheetApp: { getUi: () => ui },
    CacheService: {
      getScriptCache: () => {
        if (settings.cacheError) throw new Error('Cache unavailable');
        return cache;
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algorithm, value) => [...crypto.createHash(algorithm).update(value).digest()],
      newBlob: value => ({ getBytes: () => [...Buffer.from(value, 'utf8')] })
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        requests.push({ url, options: JSON.parse(JSON.stringify(options)) });
        if (settings.transportError) throw new Error(settings.transportError(url));
        const data = settings.data === undefined
          ? { location: { country_name: 'United States', city: 'Mountain View' },
              asn: { organization: 'Google' }, time_zone: { name: 'America/Los_Angeles' },
              security: { is_vpn: false, threat_score: 0 } }
          : settings.data;
        return {
          getResponseCode: () => settings.status || 200,
          getContentText: () => settings.body === undefined ? JSON.stringify(data) : settings.body
        };
      }
    }
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  return { context, properties, requests, writes };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('existing lookup formulas and shortcuts retain their values and v3 routes', () => {
  const { context: c, requests } = loadScript();
  assert.equal(c.IPGEO_COUNTRY('8.8.8.8'), 'United States');
  assert.equal(c.IPGEO_CITY('8.8.8.8'), 'Mountain View');
  assert.equal(c.IPGEO_TIMEZONE('8.8.8.8'), 'America/Los_Angeles');
  assert.equal(c.IPGEO_ASN_ORG('8.8.8.8'), 'Google');
  assert.equal(c.IPGEO_IS_VPN('8.8.8.8'), false);
  assert.equal(c.IPGEO_THREAT_SCORE('8.8.8.8'), 0);
  assert.equal(JSON.parse(c.IPGEO_JSON('8.8.8.8')).location.city, 'Mountain View');
  assert.equal(c.IPGEO('8.8.8.8', 'missing'), '');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), ['/v3/ipgeo', '/v3/ipgeo', '/v3/security']);
  assert.equal(new URL(requests[1].url).searchParams.get('include'), 'security');
  assert.equal(requests[0].options.method, 'get');
  assert.equal(requests[0].options.muteHttpExceptions, true);
});

test('single lookups keep blank-IP behavior and encode domains and include values', () => {
  const { context: c, requests } = loadScript();
  c.IPGEO('', 'location.city');
  c.IPGEO(' example.com ', 'location.city', 'security,abuse');
  assert.equal(new URL(requests[0].url).searchParams.has('ip'), false);
  assert.equal(new URL(requests[1].url).searchParams.get('ip'), 'example.com');
  assert.equal(new URL(requests[1].url).searchParams.get('include'), 'security,abuse');
});

test('bulk results retain leading, middle and trailing blank positions', () => {
  const { context: c, requests } = loadScript({ data: [
    { security: { is_vpn: false } }, { security: { is_vpn: true } }
  ] });
  const result = c.IPGEO_BULK([[''], ['8.8.8.8'], ['  '], ['1.1.1.1'], ['']], 'security.is_vpn', 'security');
  assert.deepEqual(plain(result), [[''], [false], [''], [true], ['']]);
  assert.deepEqual(JSON.parse(requests[0].options.payload), { ips: ['8.8.8.8', '1.1.1.1'] });
  assert.equal(requests[0].options.method, 'post');
  assert.equal(requests[0].options.contentType, 'application/json');
  assert.equal(new URL(requests[0].url).pathname, '/v3/ipgeo-bulk');
});

test('bulk blank ranges make no request and retain their output height', () => {
  const { context: c, requests } = loadScript();
  assert.deepEqual(plain(c.IPGEO_BULK([[''], [' '], ['']], 'location.city')), [[''], [''], ['']]);
  assert.deepEqual(plain(c.IPGEO_BULK([], 'location.city')), [['']]);
  assert.deepEqual(plain(c.IPGEO_BULK('', 'location.city')), [['']]);
  assert.equal(requests.length, 0);
});

test('bulk scalar, flat and rectangular ranges keep row-major order and duplicates', () => {
  const data = [{ location: { city: 'A' } }, { location: { city: 'B' } }];
  assert.deepEqual(plain(loadScript({ data: [data[0]] }).context.IPGEO_BULK('8.8.8.8', 'location.city')), [['A']]);
  assert.deepEqual(plain(loadScript({ data }).context.IPGEO_BULK(['8.8.8.8', '', '8.8.8.8'], 'location.city')), [['A'], [''], ['B']]);
  assert.deepEqual(plain(loadScript({ data }).context.IPGEO_BULK([['8.8.8.8', ''], ['', '1.1.1.1']], 'location.city')), [['A'], [''], [''], ['B']]);
});

test('bulk validates the nonblank request count and response length', () => {
  const { context: c, requests } = loadScript({ data: [] });
  assert.match(c.IPGEO_BULK(Array(50001).fill('8.8.8.8'), 'location.city')[0][0], /up to 50000/);
  assert.equal(requests.length, 0);
  assert.match(c.IPGEO_BULK(['8.8.8.8'], 'location.city')[0][0], /bulk response/i);
  assert.match(loadScript({ data: {} }).context.IPGEO_BULK(['8.8.8.8'], 'location.city')[0][0], /bulk response/i);
});

test('bulk accepts 50000 nonblank inputs while retaining extra blank positions', () => {
  const ips = Array(50000).fill('8.8.8.8');
  const { context: c, requests } = loadScript({ data: ips.map(() => ({ city: 'A' })) });
  const values = c.IPGEO_BULK(['', ...ips, ''], 'city');
  assert.equal(values.length, 50002);
  assert.equal(values[0][0], '');
  assert.equal(values[1][0], 'A');
  assert.equal(values[50000][0], 'A');
  assert.equal(values[50001][0], '');
  assert.equal(JSON.parse(requests[0].options.payload).ips.length, 50000);
});

test('per-entry API errors do not shift later bulk results', () => {
  const { context: c } = loadScript({ data: [
    { city: 'A' }, { message: 'Invalid IP address' }, { city: 'B' }
  ] });
  assert.deepEqual(plain(c.IPGEO_BULK(['8.8.8.8', 'invalid', '', '1.1.1.1'], 'city')), [['A'], [''], [''], ['B']]);
});

for (const setting of ['readError', 'writeError', 'cacheError']) {
  test(`${setting} does not discard successful GET or POST results`, () => {
    const single = loadScript({ [setting]: true });
    assert.equal(single.context.IPGEO_COUNTRY('8.8.8.8'), 'United States');
    const bulk = loadScript({ [setting]: true, data: [{ location: { city: 'A' } }] });
    assert.deepEqual(plain(bulk.context.IPGEO_BULK(['8.8.8.8'], 'location.city')), [['A']]);
  });
}

test('invalid cached JSON triggers a fresh GET or POST', () => {
  assert.equal(loadScript({ cached: '{broken' }).context.IPGEO_COUNTRY('8.8.8.8'), 'United States');
  const bulk = loadScript({ cached: '{broken', data: [{ location: { city: 'A' } }] });
  assert.deepEqual(plain(bulk.context.IPGEO_BULK(['8.8.8.8'], 'location.city')), [['A']]);
  assert.equal(bulk.requests.length, 1);
});

test('large ASCII and multibyte responses return without exceeding the cache limit', () => {
  for (const text of ['x'.repeat(100001), '界'.repeat(40000)]) {
    const single = loadScript({ data: { location: { city: text } } });
    assert.equal(single.context.IPGEO_CITY('8.8.8.8'), text);
    assert.equal(single.writes.length, 0);
    const bulk = loadScript({ data: [{ location: { city: text } }] });
    assert.deepEqual(plain(bulk.context.IPGEO_BULK(['8.8.8.8'], 'location.city')), [[text]]);
    assert.equal(bulk.writes.length, 0);
  }
});

test('cache hits retain TTL and are separated by method, payload and API key', () => {
  const { context: c, properties, requests, writes } = loadScript({ data: [{ city: 'A' }] });
  c.IPGEO_BULK(['8.8.8.8'], 'city');
  c.IPGEO_BULK(['8.8.8.8'], 'city');
  c.IPGEO_BULK(['1.1.1.1'], 'city');
  properties.set('IPGEOLOCATION_API_KEY', 'other-test-key');
  c.IPGEO_BULK(['8.8.8.8'], 'city');
  c.IPGEO('8.8.8.8', 'city');
  assert.equal(requests.length, 4);
  assert.equal(new Set(writes.map(w => w.key)).size, 4);
  assert.ok(writes.every(w => w.ttl === 21600 && !w.key.includes('test-key')));
});

for (const method of ['IPGEO', 'IPGEO_JSON', 'IPSECURITY', 'IPGEO_BULK']) {
  test(`${method} redacts credentials from response and transport errors`, () => {
    const key = 'test-key+a/b?c=%';
    for (const transport of [false, true]) {
      const echoed = `apiKey=${encodeURIComponent(key)} raw=${key} lower=${encodeURIComponent(key).toLowerCase()}`;
      const { context: c } = loadScript({ key, status: 429, body: echoed,
        transportError: transport ? url => `Request failed for ${url}; ${echoed}` : null });
      const result = String(c[method](method === 'IPGEO_BULK' ? ['8.8.8.8'] : '8.8.8.8', 'location.city'));
      assert.ok(!result.includes(key), result);
      assert.ok(!result.toLowerCase().includes(encodeURIComponent(key).toLowerCase()), result);
      assert.match(result, /redacted/i);
      if (!transport) assert.match(result, /429/);
    }
  });
}

test('a changed saved key does not expose the key used by an in-flight request', () => {
  let app;
  app = loadScript({ transportError: () => {
    app.properties.set('IPGEOLOCATION_API_KEY', 'replacement-key');
    return 'Failed request using test-key-123';
  } });
  assert.ok(!app.context.IPGEO_COUNTRY('8.8.8.8').includes('test-key-123'));
});

test('HTTP status, malformed JSON and missing-key errors remain useful', () => {
  assert.match(loadScript({ status: 403, body: '{"message":"Access denied"}' }).context.IPGEO_COUNTRY('8.8.8.8'), /403.*Access denied/);
  assert.match(loadScript({ body: '<html>unavailable</html>' }).context.IPGEO_COUNTRY('8.8.8.8'), /^Error:/);
  const missing = loadScript({ key: '' });
  assert.match(missing.context.IPGEO_COUNTRY('8.8.8.8'), /Missing API key/);
  assert.equal(missing.requests.length, 0);
});

test('menu setters and clearing retain one shared script key', () => {
  const { context: c, properties } = loadScript();
  c.setIpGeolocationApiKey();
  assert.equal(properties.get('IPGEOLOCATION_API_KEY'), 'new-key');
  c.clearIpGeolocationApiKey();
  assert.equal(properties.has('IPGEOLOCATION_API_KEY'), false);
  for (const settings of [{ button: 'CANCEL' }, { prompt: '  ' }]) {
    const app = loadScript(settings);
    app.context.setIpGeolocationApiKey();
    assert.equal(app.properties.get('IPGEOLOCATION_API_KEY'), 'test-key-123');
  }
});
