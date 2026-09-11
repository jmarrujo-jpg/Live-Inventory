/**
 * CSC Live Inventory — Cloudflare Worker (BACKEND)
 * ------------------------------------------------------------------------------------------
 * Perpetual-inventory movement logger for the shipping / warehouse floor.
 *
 * The browser (GitHub Pages) POSTs {fn, args} here. This Worker:
 *   • READS the product master (three lookup tabs) — read-only, never written.
 *   • READS the Buildings map from the Movements workbook.
 *   • WRITES one row per stock movement to the Movements workbook.
 *
 * Deploy: paste this whole file into a dashboard Worker (Create Worker > Edit code > Deploy),
 * or `wrangler deploy`. Set these in Settings > Variables and Secrets:
 *   GCP_SA_EMAIL        (secret)  service account email (client_email in the key JSON)
 *   GCP_SA_PRIVATE_KEY  (secret)  the private_key from the key JSON (PEM; literal \n is fine)
 *   ALLOWED_ORIGIN      (var)     e.g. https://jmarrujo-jpg.github.io  (locks CORS; default *)
 *   API_TOKEN           (secret)  optional shared token; if set, the client must send it
 *   MOVEMENTS_TAB       (var)     optional; which tab to append movements to.
 *                                 Defaults to 'Movements'. Set to e.g. 'Movements_Sandbox'
 *                                 while testing — the Worker auto-creates the tab + header.
 *
 * The service account must have EDITOR on the Movements workbook and VIEWER on the lookup
 * workbook. Both sheet IDs are baked in below (override the Movements one with SHEET_ID).
 */

// ---- Spreadsheet IDs ----
// Movements workbook (read Buildings + write Movements). Override with a SHEET_ID variable.
const DEFAULT_MOVEMENTS_SHEET_ID = '1xaXUqrRbr3C6yM10Tw9a0ctL2zjbrrNAFzn3ZPNr704';
// Product master / lookups (READ ONLY — never write here).
const LOOKUP_SHEET_ID = '1GNw1gAnB1jI9L6PdUoUeQAlOKCHlPJ1f0-kxcQroI9U';

// ---- Tab names ----
const LOOKUP_TAB = { ends: 'Ends_Lookup', cans: 'Cans_Lookup', plastics: 'Plastics_Lookup' };
const BUILDINGS_TAB = 'Buildings';
const DEFAULT_MOVEMENTS_TAB = 'Movements';

// Movements tab layout — 21 columns, A:U, written BY POSITION (order is the contract).
export const MOVEMENTS_HEADER = [
  'Movement ID', 'Logged At', 'Event Date', 'User', 'Barcode', 'Product', 'Description',
  'Kind', 'Entry Method', 'Qty Entered', 'UOM', 'Units Per Pallet', 'Qty Each',
  'From Building', 'From Location', 'To Building', 'To Location', 'Reference', 'Note',
  'Flags', 'Voids',
];

export default {
  async fetch(request, env) {
    const reqOrigin = request.headers.get('Origin') || '*';
    const allowOrigin = (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*')
      ? (env.ALLOWED_ORIGIN === reqOrigin ? reqOrigin : env.ALLOWED_ORIGIN)
      : reqOrigin;
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return json({ ok: true, service: 'csc-live-inventory', build: 'v1' }, 200);
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    let payload;
    try { payload = JSON.parse((await request.text()) || '{}'); }
    catch (e) { return json({ ok: false, error: 'Bad request body' }, 400); }

    if (env.API_TOKEN && String(payload.secret || '') !== String(env.API_TOKEN)) {
      return json({ ok: false, error: 'Unauthorized' }, 200);
    }
    try {
      const result = await handle(payload.fn, payload.args || [], env);
      return json({ ok: true, result }, 200);
    } catch (e) {
      return json({ ok: false, error: e && e.message ? e.message : String(e) }, 200);
    }
  },
};

// ---------------- dispatcher ----------------
async function handle(fn, args, env) {
  const api = await makeApi(env);
  const movementsId = env.SHEET_ID || DEFAULT_MOVEMENTS_SHEET_ID;
  const movementsTab = env.MOVEMENTS_TAB || DEFAULT_MOVEMENTS_TAB;
  args = args || [];
  switch (fn) {
    case 'bootstrap': return bootstrap(api, movementsId);
    case 'logMovement': return logMovement(api, movementsId, movementsTab, args[0]);
    case 'recentMovements': return recentMovements(api, movementsId, movementsTab, args[0]);
    // Back-compat: the old scanner page still calls getLookups().
    case 'getLookups': return (await bootstrap(api, movementsId)).lookups;
    default:
      throw new Error('Unknown function: ' + fn);
  }
}

// ---------------- value helpers ----------------
export function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
export function num_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isNaN(n) ? str_(v) : n;
}
function asNum(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function asBool(v) { return v === true || String(v).trim().toUpperCase() === 'TRUE'; }

// A production environment is a creation/transformation point (Metals Production, Plastics
// Production). Moving stock INTO one is flagged "In Production".
export function isProductionBuilding(name) { return /production/i.test(String(name || '')); }

// Total units for a movement. Entering by pallet multiplies by units-per-pallet; by each is 1:1.
export function computeQtyEach(entryMethod, qtyEntered, unitsPerPallet) {
  const q = asNum(qtyEntered);
  if (String(entryMethod).toLowerCase() === 'pallets') return Math.round(q * asNum(unitsPerPallet));
  return Math.round(q);
}

// Build the 21-column movement row (by position). Server stamps ID + Logged At.
export function buildMovementRow(m, now) {
  m = m || {};
  const when = now || new Date();
  const loggedAt = when.toISOString();
  const eventDate = str_(m.eventDate) || loggedAt.slice(0, 10);
  const entryMethod = String(m.entryMethod).toLowerCase() === 'pallets' ? 'Pallets' : 'Each';
  const qtyEntered = asNum(m.qtyEntered);
  const unitsPerPallet = m.unitsPerPallet === '' || m.unitsPerPallet == null ? '' : asNum(m.unitsPerPallet);
  const qtyEach = computeQtyEach(entryMethod, qtyEntered, unitsPerPallet);
  const flags = isProductionBuilding(m.toBuilding) ? 'In Production' : str_(m.flags);
  const movementId = str_(m.movementId) || genMovementId(when);
  return [
    movementId,                 // 1  Movement ID
    loggedAt,                   // 2  Logged At (server, ISO)
    eventDate,                  // 3  Event Date
    str_(m.user),               // 4  User
    str_(m.barcode),            // 5  Barcode (scanned)
    str_(m.product),            // 6  Product (canonical SKU/code)
    str_(m.desc),               // 7  Description
    str_(m.kind),               // 8  Kind (coarse: Metals / Plastics)
    entryMethod,                // 9  Entry Method
    qtyEntered,                 // 10 Qty Entered
    entryMethod,                // 11 UOM
    unitsPerPallet,             // 12 Units Per Pallet
    qtyEach,                    // 13 Qty Each (total units)
    str_(m.fromBuilding),       // 14 From Building
    str_(m.fromLocation),       // 15 From Location
    str_(m.toBuilding),         // 16 To Building
    str_(m.toLocation),         // 17 To Location
    str_(m.reference),          // 18 Reference
    str_(m.note),               // 19 Note
    flags,                      // 20 Flags
    '',                         // 21 Voids
  ];
}

function genMovementId(when) {
  const t = (when || new Date()).getTime().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'MV-' + t + '-' + r;
}

// ---------------- backend functions ----------------
// Load everything the movement flow needs in one round trip: product master + buildings.
async function bootstrap(api, movementsId) {
  const [ends, cans, plastics, buildings] = await Promise.all([
    api.values(LOOKUP_SHEET_ID, LOOKUP_TAB.ends),
    api.values(LOOKUP_SHEET_ID, LOOKUP_TAB.cans),
    api.values(LOOKUP_SHEET_ID, LOOKUP_TAB.plastics),
    api.values(movementsId, BUILDINGS_TAB),
  ]);
  return {
    lookups: {
      // Ends_Lookup: Label Code | Description | Per Pallet | Weight | Type
      ends: rowsToItems(ends, (r) => ({
        code: str_(r[0]), desc: str_(r[1]), perUnit: num_(r[2]), weight: str_(r[3]), type: str_(r[4]),
        kind: 'Ends', cat: 'Metals',
      })),
      // Cans_Lookup: Label Number | Description | Per Pallet
      cans: rowsToItems(cans, (r) => ({
        code: str_(r[0]), desc: str_(r[1]), perUnit: num_(r[2]),
        kind: 'Cans', cat: 'Metals',
      })),
      // Plastics_Lookup: Item # | Description | Type | Per Pallet/Box
      plastics: rowsToItems(plastics, (r) => ({
        code: str_(r[0]), desc: str_(r[1]), type: str_(r[2]), perUnit: num_(r[3]),
        kind: 'Plastics', cat: 'Plastics',
      })),
    },
    buildings: buildingsFromRows(buildings),
  };
}

function rowsToItems(values, mapFn) {
  return (values || []).slice(1).filter((r) => str_(r[1])).map(mapFn);
}

// Buildings: Building | Staging Location | Location Prefix | Counts As Inventory | Sort Order
function buildingsFromRows(values) {
  return (values || []).slice(1)
    .filter((r) => str_(r[0]))
    .map((r) => ({
      name: str_(r[0]),
      staging: str_(r[1]),
      prefix: str_(r[2]),
      countsAsInventory: asBool(r[3]),
      sort: asNum(r[4]),
      production: isProductionBuilding(r[0]),
    }))
    .sort((a, b) => a.sort - b.sort);
}

async function logMovement(api, movementsId, movementsTab, m) {
  m = m || {};
  if (!str_(m.product)) throw new Error('Missing product');
  if (!str_(m.fromBuilding)) throw new Error('Missing From building');
  if (!str_(m.toBuilding)) throw new Error('Missing To building');
  const row = buildMovementRow(m, new Date());
  await api.ensureTab(movementsId, movementsTab, MOVEMENTS_HEADER);
  await api.appendRow(movementsId, movementsTab, row);
  return { movementId: row[0], loggedAt: row[1], qtyEach: row[12], flags: row[19] };
}

async function recentMovements(api, movementsId, movementsTab, limit) {
  const n = Math.max(1, Math.min(200, asNum(limit) || 25));
  let values;
  try { values = await api.values(movementsId, movementsTab); }
  catch (e) { return []; } // tab may not exist yet
  const rows = (values || []).slice(1); // drop header
  return rows.slice(-n).reverse().map((r) => ({
    movementId: str_(r[0]), loggedAt: str_(r[1]), user: str_(r[3]),
    product: str_(r[5]), desc: str_(r[6]), kind: str_(r[7]),
    qtyEach: num_(r[12]), fromBuilding: str_(r[13]), toBuilding: str_(r[15]),
    flags: str_(r[19]),
  }));
}

// ---------------- Google auth + Sheets ----------------
let cachedToken = null;
const ensuredTabs = new Set();

function b64urlBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64urlBytes(new TextEncoder().encode(str)); }
function pemToPkcs8(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}
async function mintToken(env) {
  const email = env.GCP_SA_EMAIL;
  const key = (env.GCP_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Service account not configured (GCP_SA_EMAIL / GCP_SA_PRIVATE_KEY).');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64urlStr(JSON.stringify(header)) + '.' + b64urlStr(JSON.stringify(claim));
  const ck = await crypto.subtle.importKey('pkcs8', pemToPkcs8(key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', ck, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64urlBytes(new Uint8Array(sig));
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error('Token exchange failed: ' + (data.error_description || data.error || resp.status));
  return { token: data.access_token, exp: now + (data.expires_in || 3600) };
}
async function getToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  cachedToken = await mintToken(env);
  return cachedToken.token;
}
async function makeApi(env) {
  const token = await getToken(env);
  const auth = { Authorization: 'Bearer ' + token };
  const base = (id) => 'https://sheets.googleapis.com/v4/spreadsheets/' + id;
  async function call(url, opts) {
    const r = await fetch(url, opts);
    const t = await r.text();
    let j; try { j = t ? JSON.parse(t) : {}; } catch (e) { throw new Error('Sheets API non-JSON: ' + t.slice(0, 200)); }
    if (!r.ok) throw new Error('Sheets API ' + r.status + ': ' + (j.error && j.error.message ? j.error.message : t.slice(0, 200)));
    return j;
  }
  return {
    // Read all rows of a tab as raw values (header included).
    async values(sheetId, tab) {
      const j = await call(base(sheetId) + '/values/' + encodeURIComponent(tab)
        + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER', { headers: auth });
      return j.values || [];
    },
    // Append a row at the table origin (A1) so a stray cell can't offset the write.
    async appendRow(sheetId, tab, row) {
      return call(base(sheetId) + '/values/' + encodeURIComponent(tab + '!A1')
        + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) });
    },
    // Create the tab + header row if it doesn't exist yet (cached per isolate).
    async ensureTab(sheetId, tab, header) {
      const key = sheetId + '::' + tab;
      if (ensuredTabs.has(key)) return;
      const meta = await call(base(sheetId) + '?fields=sheets.properties.title', { headers: auth });
      const titles = (meta.sheets || []).map((s) => s.properties.title);
      if (!titles.includes(tab)) {
        await call(base(sheetId) + ':batchUpdate', {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
        });
        await call(base(sheetId) + '/values/' + encodeURIComponent(tab + '!A1') + '?valueInputOption=RAW', {
          method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [header] }),
        });
      }
      ensuredTabs.add(key);
    },
  };
}
