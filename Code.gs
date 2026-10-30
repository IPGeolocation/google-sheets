/************************************************************
 * IPGeolocation.io for Google Sheets
 * Target API version: v3
 *
 * Share this Code.gs file with users.
 * Users only need to paste it into Extensions > Apps Script,
 * save it, set their API key, and then use the formulas in Sheets.
 ************************************************************/

const IPGEO_CONFIG = {
  BASE_URL: 'https://api.ipgeolocation.io/v3',
  API_KEY_PROPERTY: 'IPGEOLOCATION_API_KEY',
  CACHE_TTL_SECONDS: 21600,
  MAX_BULK_SIZE: 50000
};

/**
 * Adds a friendly menu inside Google Sheets.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('IPGeolocation.io')
    .addItem('Set API Key', 'setIpGeolocationApiKey')
    .addItem('Clear API Key', 'clearIpGeolocationApiKey')
    .addToUi();
}

/**
 * Saves the IPGeolocation.io API key used by this spreadsheet.
 */
function setIpGeolocationApiKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Set IPGeolocation.io API Key',
    'Paste your IPGeolocation.io API key here:',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    ui.alert('No API key was saved.');
    return;
  }

  const apiKey = response.getResponseText().trim();

  if (!apiKey) {
    ui.alert('API key cannot be empty.');
    return;
  }

  PropertiesService
    .getScriptProperties()
    .setProperty(IPGEO_CONFIG.API_KEY_PROPERTY, apiKey);

  ui.alert('Your IPGeolocation.io API key has been saved.');
}

/**
 * Removes the saved API key.
 */
function clearIpGeolocationApiKey() {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(IPGEO_CONFIG.API_KEY_PROPERTY);

  SpreadsheetApp.getUi().alert('Your IPGeolocation.io API key has been removed.');
}

/**
 * Looks up one IP address or domain using the v3 IP Geolocation API.
 *
 * Examples:
 * =IPGEO("8.8.8.8", "location.country_name")
 * =IPGEO(A2, "location.city")
 * =IPGEO(A2, "asn.organization")
 * =IPGEO(A2, "time_zone.name")
 * =IPGEO(A2, "security.is_vpn", "security")
 *
 * @param {string} ip IPv4, IPv6, domain, or blank for caller IP
 * @param {string} field Field path to return
 * @param {string=} include Optional modules, for example security or abuse
 * @return {string|number|boolean} The requested value
 * @customfunction
 */
function IPGEO(ip, field, include) {
  try {
    const data = fetchIpGeo_(ip, include);
    return getNestedValue_(data, field);
  } catch (error) {
    return formatError_(error);
  }
}

/**
 * Returns the full response as JSON text.
 *
 * Examples:
 * =IPGEO_JSON("8.8.8.8")
 * =IPGEO_JSON(A2, "security,abuse")
 *
 * @param {string} ip IPv4, IPv6, domain, or blank for caller IP
 * @param {string=} include Optional modules, for example security or abuse
 * @return {string} JSON response text
 * @customfunction
 */
function IPGEO_JSON(ip, include) {
  try {
    const data = fetchIpGeo_(ip, include);
    return JSON.stringify(data);
  } catch (error) {
    return formatError_(error);
  }
}

/**
 * Uses the dedicated v3 Security API.
 *
 * Examples:
 * =IPSECURITY("8.8.8.8", "security.threat_score")
 * =IPSECURITY(A2, "security.is_vpn")
 * =IPSECURITY(A2, "security.is_proxy")
 *
 * @param {string} ip IPv4 or IPv6 address
 * @param {string} field Field path to return
 * @return {string|number|boolean} The requested value
 * @customfunction
 */
function IPSECURITY(ip, field) {
  try {
    const data = fetchIpSecurity_(ip);
    return getNestedValue_(data, field);
  } catch (error) {
    return formatError_(error);
  }
}

/**
 * Looks up many IP addresses or domains at once using the v3 bulk endpoint.
 *
 * Examples:
 * =IPGEO_BULK(A2:A20, "location.country_name")
 * =IPGEO_BULK(A2:A20, "security.is_vpn", "security")
 *
 * @param {string[][]|string[]} ipRange A range of IP addresses or domains
 * @param {string} field Field path to return
 * @param {string=} include Optional modules, for example security or abuse
 * @return {Array[]} A column of values
 * @customfunction
 */
function IPGEO_BULK(ipRange, field, include) {
  try {
    const inputs = normalizeRangeToList_(ipRange);
    const ips = inputs.filter(function (ip) { return ip !== ''; });

    if (!ips.length) {
      return inputs.length ? inputs.map(function () { return ['']; }) : [['']];
    }

    if (ips.length > IPGEO_CONFIG.MAX_BULK_SIZE) {
      return [[`Error: Bulk lookup supports up to ${IPGEO_CONFIG.MAX_BULK_SIZE} IPs or domains per request.`]];
    }

    const results = fetchIpGeoBulk_(ips, include);

    if (!Array.isArray(results) || results.length !== ips.length) {
      throw new Error('Invalid bulk response: expected one result per IP address.');
    }

    let resultIndex = 0;
    return inputs.map(function (ip) {
      return [ip === '' ? '' : getNestedValue_(results[resultIndex++], field)];
    });
  } catch (error) {
    return [[formatError_(error)]];
  }
}

/**
 * Friendly shortcut formulas.
 */
function IPGEO_COUNTRY(ip) {
  return IPGEO(ip, 'location.country_name');
}

function IPGEO_CITY(ip) {
  return IPGEO(ip, 'location.city');
}

function IPGEO_TIMEZONE(ip) {
  return IPGEO(ip, 'time_zone.name');
}

function IPGEO_ASN_ORG(ip) {
  return IPGEO(ip, 'asn.organization');
}

function IPGEO_IS_VPN(ip) {
  return IPGEO(ip, 'security.is_vpn', 'security');
}

function IPGEO_THREAT_SCORE(ip) {
  return IPSECURITY(ip, 'security.threat_score');
}

function fetchIpGeo_(ip, include) {
  const params = {};

  if (ip && String(ip).trim()) {
    params.ip = String(ip).trim();
  }

  if (include && String(include).trim()) {
    params.include = String(include).trim();
  }

  const url = buildUrl_('/ipgeo', params);
  return fetchJsonWithCache_(url);
}

function fetchIpSecurity_(ip) {
  const params = {};

  if (ip && String(ip).trim()) {
    params.ip = String(ip).trim();
  }

  const url = buildUrl_('/security', params);
  return fetchJsonWithCache_(url);
}

function fetchIpGeoBulk_(ips, include) {
  const params = {};

  if (include && String(include).trim()) {
    params.include = String(include).trim();
  }

  return fetchJsonWithCache_(buildUrl_('/ipgeo-bulk', params), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ ips: ips }),
    muteHttpExceptions: true
  });
}

function fetchJsonWithCache_(url, options) {
  options = options || { method: 'get', muteHttpExceptions: true };
  const cacheKey = makeCacheKey_(options.method.toUpperCase() + ':' + url + ':' + (options.payload || ''));
  const cached = getCachedJson_(cacheKey);

  if (cached !== null) {
    return cached;
  }

  const requestKey = decodeURIComponent((url.match(/[?&]apiKey=([^&]*)/i) || [])[1] || '');
  let data;
  try {
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();
    const body = response.getContentText();

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`IPGeolocation.io API error ${statusCode}: ${body}`);
    }

    data = JSON.parse(body);
  } catch (error) {
    throw new Error(redactErrorMessage_(error, requestKey));
  }

  cacheJson_(cacheKey, data);
  return data;
}

function getCachedJson_(cacheKey) {
  try {
    const cached = CacheService.getScriptCache().get(cacheKey);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    return null;
  }
}

function cacheJson_(cacheKey, data) {
  try {
    const json = JSON.stringify(data);
    if (json.length > 100000 || Utilities.newBlob(json).getBytes().length > 100000) {
      return;
    }
    CacheService.getScriptCache().put(cacheKey, json, IPGEO_CONFIG.CACHE_TTL_SECONDS);
  } catch (error) {
    return;
  }
}

function buildUrl_(path, params) {
  const query = buildQueryString_(
    Object.assign(
      {
        apiKey: getApiKey_(),
        output: 'json'
      },
      params || {}
    )
  );

  return `${IPGEO_CONFIG.BASE_URL}${path}?${query}`;
}

function getApiKey_() {
  const apiKey = PropertiesService
    .getScriptProperties()
    .getProperty(IPGEO_CONFIG.API_KEY_PROPERTY);

  if (!apiKey) {
    throw new Error('Missing API key. Open the IPGeolocation.io menu in this Sheet and choose Set API Key.');
  }

  return apiKey;
}

function buildQueryString_(params) {
  return Object.keys(params)
    .filter(function (key) {
      return params[key] !== undefined && params[key] !== null && params[key] !== '';
    })
    .map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    })
    .join('&');
}

function getNestedValue_(object, path) {
  if (!path || String(path).trim() === '') {
    return JSON.stringify(object);
  }

  const parts = String(path).split('.');
  let current = object;

  for (let i = 0; i < parts.length; i++) {
    if (current === undefined || current === null) {
      return '';
    }

    current = current[parts[i]];
  }

  if (current === undefined || current === null) {
    return '';
  }

  if (Array.isArray(current)) {
    return current.join(', ');
  }

  if (typeof current === 'object') {
    return JSON.stringify(current);
  }

  return current;
}

function normalizeRangeToList_(range) {
  const list = [];
  const rows = Array.isArray(range) ? range : [range];
  rows.forEach(function (row) {
    const cells = Array.isArray(row) ? row : [row];
    cells.forEach(function (cell) {
      list.push(String(cell || '').trim());
    });
  });

  return list;
}

function makeCacheKey_(value) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value
  );

  return digest
    .map(function (byte) {
      const v = byte < 0 ? byte + 256 : byte;
      return ('0' + v.toString(16)).slice(-2);
    })
    .join('');
}

function formatError_(error) {
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty(IPGEO_CONFIG.API_KEY_PROPERTY);
    return 'Error: ' + redactErrorMessage_(error, apiKey);
  } catch (storageError) {
    return 'Error: IPGeolocation.io request failed.';
  }
}

function redactErrorMessage_(error, apiKey) {
  let message = error && error.message !== undefined ? String(error.message) : String(error || 'Request failed.');
  if (apiKey) {
    const variants = [apiKey, encodeURIComponent(apiKey), JSON.stringify(apiKey).slice(1, -1)];
    variants.sort(function (a, b) { return b.length - a.length; }).forEach(function (value) {
      const pattern = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      message = message.replace(new RegExp(pattern, 'gi'), '[REDACTED]');
    });
  }
  return message.replace(/([?&]apiKey=)[^&#\s"'<>]*/gi, '$1[REDACTED]');
}
