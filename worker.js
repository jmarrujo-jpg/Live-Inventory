/**
 * Inventory Count — Cloudflare Worker (BACKEND)
 * ------------------------------------------------------------------------------------------
 * Front end is on GitHub Pages; this Worker is the backend. The browser POSTs {fn, args} here
 * and this reads/writes the Google Sheet directly using a service account (no Apps Script).
 *
 * Self-contained: paste this whole file into a dashboard Worker (Create Worker > Edit code),
 * or deploy with wrangler. Set these variables (Settings > Variables and Secrets):
 *   GCP_SA_EMAIL        (secret)  service account email  (client_email in the key JSON)
 *   GCP_SA_PRIVATE_KEY  (secret)  the private_key from the key JSON (PEM; literal \n is fine)
 *   SHEET_ID            (var)     spreadsheet id (optional; defaults to the Inventory workbook)
 *   ALLOWED_ORIGIN      (var)     e.g. https://jmarrujo-jpg.github.io  (optional; default *)
 *   API_TOKEN           (secret)  optional shared token; if set, the client must send it
 *
 * Reads AND writes are live: getLookups() serves the three lookup tabs, appendEntry() writes a
 * counted row to the Metals / Plastics tabs — the same contract the Apps Script backend used.
 */

// Inventory workbook id — used when the SHEET_ID variable isn't set. Override it by setting a
// SHEET_ID variable on the Worker if the workbook ever changes.
const DEFAULT_SHEET_ID = '1GNw1gAnB1jI9L6PdUoUeQAlOKCHlPJ1f0-kxcQroI9U';

// ---- Tab names (change here if you rename tabs) ----
// Output tabs are split: Cans and Ends each get their own tab (auto-created if missing).
const TAB = {
  ends: 'Ends_Lookup',
  cans: 'Cans_Lookup',
  plastics: 'Plastics_Lookup',
  cansOut: 'Cans',
  endsOut: 'Ends',
  plasticsOut: 'Plastics',
};

export default {
  async fetch(request, env) {
    // Echo the caller's Origin so the CORS header always matches (avoids a misconfigured
    // ALLOWED_ORIGIN silently blocking the app). If ALLOWED_ORIGIN is set to a specific origin,
    // only that origin is allowed; otherwise any origin is echoed back.
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
    if (request.method === 'GET') return json({ ok: true, service: 'csc-live-inventory', build: 'v12-perbuilding' }, 200);
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
  args = args || [];
  if (fn === 'getLogs') return getLogs(env);          // reads a SEPARATE, read-only workbook
  if (fn === 'getBuildings') return getBuildings(env); // reads the Movements workbook's Buildings tab
  if (fn === 'getMovements') return getMovements(env); // reads back the Movements log (per-building deltas)
  if (fn === 'logMovement') return logMovement(env, args[0]); // writes to the Movements workbook
  const sheets = await makeSheets(env);
  switch (fn) {
    case 'getLookups': return getLookups(sheets);   // READ ONLY — the lookup workbook is never written
    default:
      throw new Error('Unknown function: ' + fn);
  }
}

// ---------------- read-only history logs ----------------
// A SEPARATE workbook holds "Metals Log" / "Plastics Log" — where each product was last counted and
// how many. The app reads these to show "last counted here" info; it NEVER writes to this workbook.
// The service account (GCP_SA_EMAIL) must be given Viewer access to this workbook for reads to work.
const LOG_SHEET_ID = '1NVCx-n9_Zha9u1HPyi3hGLBQ4EyWHx7AbA4zs36hbYc';
// Columns: Count Date | Logged At | Kind | Location | Product | Description | Quantity
async function getLogs(env) {
  const sheets = await makeSheets(env, LOG_SHEET_ID);
  const titles = await sheets.titles();
  const findTab = (kw) => titles.find((t) => String(t).toLowerCase().replace(/[_\s]+/g, ' ').indexOf(kw) !== -1);
  const parseLog = async (tab) => {
    if (!tab) return [];
    let values;
    try { values = await sheets.readAll(tab); }
    catch (e) { if (String((e && e.message) || '').indexOf('Unable to parse range') !== -1) return []; throw e; }
    if (!values.length) return [];
    const H = values[0].map((h) => String(h).trim().toLowerCase());
    const at = (n) => H.indexOf(n);
    const iDate = at('count date'), iKind = at('kind'), iLoc = at('location'),
          iProd = at('product'), iDesc = at('description'), iQty = at('quantity');
    const g = (r, i) => str_(i === -1 ? '' : r[i]);
    const out = [];
    for (let n = 1; n < values.length; n++) {
      const r = values[n] || [];
      if (str_(r[0]).indexOf('__META__') !== -1) continue;   // skip the meta marker row
      const loc = g(r, iLoc), prod = g(r, iProd);
      if (!loc && !prod) continue;
      out.push({
        countDate: g(r, iDate), kind: g(r, iKind), loc: loc, product: prod,
        desc: g(r, iDesc), qty: num_(iQty === -1 ? '' : r[iQty]),
      });
    }
    return out;
  };
  const [metals, plastics] = await Promise.all([
    parseLog(findTab('metals log')),
    parseLog(findTab('plastics log')),
  ]);
  return { metals: metals, plastics: plastics };
}

// ---------------- Live Inventory: movements (read + write) ----------------
// A SEPARATE workbook is the movement log. We READ its Buildings map and APPEND movement rows.
// The service account needs EDITOR here. The lookup workbook (DEFAULT_SHEET_ID) stays read-only.
const MOVEMENTS_SHEET_ID = '1xaXUqrRbr3C6yM10Tw9a0ctL2zjbrrNAFzn3ZPNr704';
const MOVEMENTS_TAB = 'Movements';
const BUILDINGS_TAB = 'Buildings';
// Movements tab — 21 columns, A:U, written BY POSITION (this order is the contract).
const MOVEMENTS_HEADER = [
  'Movement ID', 'Logged At', 'Event Date', 'User', 'Barcode', 'Product', 'Description',
  'Kind', 'Entry Method', 'Qty Entered', 'UOM', 'Units Per Pallet', 'Qty Each',
  'From Building', 'From Location', 'To Building', 'To Location', 'Reference', 'Note', 'Flags', 'Voids',
];

// A production environment (Metals/Plastics Production) is a creation + transformation point;
// moving stock INTO one is flagged "In Production".
function isProductionBuilding(name) { return /production/i.test(String(name || '')); }

// Buildings tab: Building | Staging Location | Location Prefix | Counts As Inventory | Sort Order
async function getBuildings(env) {
  const sheets = await makeSheets(env, MOVEMENTS_SHEET_ID);
  let values;
  try { values = await sheets.readAll(BUILDINGS_TAB); }
  catch (e) { if (String((e && e.message) || '').indexOf('Unable to parse range') !== -1) return []; throw e; }
  return (values || []).slice(1)
    .filter((r) => str_(r[0]))
    .map((r) => ({
      name: str_(r[0]), staging: str_(r[1]), prefix: str_(r[2]),
      countsAsInventory: (r[3] === true || String(r[3]).trim().toUpperCase() === 'TRUE'),
      sort: (Number(r[4]) || 0), production: isProductionBuilding(r[0]),
    }))
    .sort((a, b) => a.sort - b.sort);
}

// Append one movement row to the Movements sheet. Server stamps the ID + Logged At and flags
// "In Production" when the destination is a production environment.
async function logMovement(env, m) {
  m = m || {};
  if (!str_(m.product)) throw new Error('Missing product');
  if (!str_(m.fromBuilding)) throw new Error('Missing From building');
  if (!str_(m.toBuilding)) throw new Error('Missing To building');
  const sheets = await makeSheets(env, MOVEMENTS_SHEET_ID);
  const when = new Date();
  const loggedAt = when.toISOString();
  const entryMethod = String(m.entryMethod).toLowerCase() === 'each' ? 'Each' : 'Pallets';
  const qEntered = (m.qtyEntered === '' || m.qtyEntered == null) ? '' : Number(m.qtyEntered);
  const perPallet = (m.unitsPerPallet === '' || m.unitsPerPallet == null) ? '' : Number(m.unitsPerPallet);
  const qtyEach = (m.qtyEach !== '' && m.qtyEach != null && !isNaN(Number(m.qtyEach)))
    ? Math.round(Number(m.qtyEach))
    : (entryMethod === 'Pallets' ? Math.round((Number(qEntered) || 0) * (Number(perPallet) || 0)) : Math.round(Number(qEntered) || 0));
  const flags = isProductionBuilding(m.toBuilding) ? 'In Production' : str_(m.flags);
  const id = str_(m.movementId) || ('MV-' + when.getTime().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase());
  const row = [
    id, loggedAt, str_(m.eventDate) || loggedAt.slice(0, 10), str_(m.user), str_(m.barcode),
    str_(m.product), str_(m.desc), str_(m.kind), entryMethod, qEntered, entryMethod, perPallet, qtyEach,
    str_(m.fromBuilding), str_(m.fromLocation), str_(m.toBuilding), str_(m.toLocation),
    str_(m.reference), str_(m.note), flags, '',
  ];
  await sheets.appendEnsuring(MOVEMENTS_TAB, row, MOVEMENTS_HEADER);
  return { movementId: id, loggedAt: loggedAt, qtyEach: qtyEach, flags: flags };
}

// Read the Movements log back so the app can stack movements onto the counted baseline and show a
// live per-building on-hand. Read-only; matched to columns by header name (robust to reordering).
// A non-empty "Voids" cell marks a movement that should be ignored.
async function getMovements(env) {
  const sheets = await makeSheets(env, MOVEMENTS_SHEET_ID);
  let values;
  try { values = await sheets.readAll(MOVEMENTS_TAB); }
  catch (e) { if (String((e && e.message) || '').indexOf('Unable to parse range') !== -1) return []; throw e; }
  if (!values.length) return [];
  const H = values[0].map((h) => String(h).trim().toLowerCase());
  const at = (n) => H.indexOf(n);
  const iBarcode = at('barcode'), iProduct = at('product'), iDesc = at('description'), iKind = at('kind'),
        iQtyEach = at('qty each'), iFrom = at('from building'), iTo = at('to building'), iVoids = at('voids');
  const g = (r, i) => (i === -1 ? '' : str_(r[i]));
  const out = [];
  for (let n = 1; n < values.length; n++) {
    const r = values[n] || [];
    const prod = g(r, iProduct), bc = g(r, iBarcode);
    if (!prod && !bc) continue;                      // skip blank rows
    out.push({
      product: prod, barcode: bc, desc: g(r, iDesc), kind: g(r, iKind),
      qtyEach: num_(iQtyEach === -1 ? '' : r[iQtyEach]),
      fromBuilding: g(r, iFrom), toBuilding: g(r, iTo),
      voided: !!g(r, iVoids),
    });
  }
  return out;
}

// ---------------- value helpers (match the old Apps Script) ----------------
function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function num_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isNaN(n) ? str_(v) : n;
}

// ---------------- backend functions ----------------
// Ends_Lookup:     Label Code  | Description | Per Pallet     | Weight | Type
// Cans_Lookup:     Label Number | Description | Per Pallet
// Plastics_Lookup: Item #       | Description | Type           | Per Pallet/Box
async function getLookups(sheets) {
  const [ends, cans, plastics] = await Promise.all([
    sheets.rows(TAB.ends),
    sheets.rows(TAB.cans),
    sheets.rows(TAB.plastics),
  ]);
  return {
    ends: ends.filter((r) => str_(r[1])).map((r) => ({
      code: str_(r[0]), desc: str_(r[1]), perUnit: num_(r[2]), weight: str_(r[3]), type: str_(r[4]),
    })),
    cans: cans.filter((r) => str_(r[1])).map((r) => ({
      code: str_(r[0]), desc: str_(r[1]), perUnit: num_(r[2]),
    })),
    plastics: plastics.filter((r) => str_(r[1])).map((r) => ({
      code: str_(r[0]), desc: str_(r[1]), type: str_(r[2]), perUnit: num_(r[3]),
    })),
  };
}

/**
 * Append one counted entry. dept = 'metals' or 'plastics'; for metals, e.category is
 * 'Cans' or 'Ends' and picks the tab. Cans and Ends write to their own tabs, which are
 * created (with a header row) on first use if they don't exist yet.
 * The Sheets values:append (INSERT_ROWS) is atomic server-side, so concurrent counters
 * appending at once each get their own new row — no LockService needed.
 */
async function appendEntry(sheets, e, dept) {
  e = e || {};
  let tab, row, header;
  // NOTE: Location comes before Total (Total is the last column) to match the sheet layout.
  if (dept === 'plastics') {
    tab = TAB.plasticsOut;
    header = ['Timestamp', 'Counter', 'Item #', 'Description', 'Type', 'Per Unit', 'Full', 'Extra', 'Location', 'Total'];
    row = [e.ts, e.counter, e.code, e.desc, e.type, e.per, e.full, e.extra, e.loc, e.total];
  } else if (e.category === 'Cans') {
    tab = TAB.cansOut;
    header = ['Timestamp', 'Counter', 'Code', 'Description', 'Per Unit', 'Full', 'Extra', 'Location', 'Total'];
    row = [e.ts, e.counter, e.code, e.desc, e.per, e.full, e.extra, e.loc, e.total];
  } else {
    tab = TAB.endsOut;
    header = ['Timestamp', 'Counter', 'Label Code', 'Description', 'Weight', 'Type', 'Per Unit', 'Full', 'Extra', 'Location', 'Total'];
    row = [e.ts, e.counter, e.code, e.desc, e.weight, e.type, e.per, e.full, e.extra, e.loc, e.total];
  }
  await sheets.appendEnsuring(tab, row, header);
  return true;
}

// Read back everything currently in the output tabs so the app can show the full count list
// (the Sheet is the source of truth — survives phone crashes / different devices).
async function getEntries(sheets) {
  const [cans, ends, plastics] = await Promise.all([
    readTabEntries(sheets, TAB.cansOut, 'Cans'),
    readTabEntries(sheets, TAB.endsOut, 'Ends'),
    readTabEntries(sheets, TAB.plasticsOut, 'Plastics'),
  ]);
  return { cans, ends, plastics };
}
function numOr0(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
async function readTabEntries(sheets, tab, category) {
  let values;
  try {
    values = await sheets.readAll(tab);
  } catch (e) {
    if (String((e && e.message) || '').indexOf('Unable to parse range') !== -1) return []; // tab not created yet
    throw e;
  }
  if (!values.length) return [];
  const headers = values[0].map((h) => String(h).trim());
  const at = (name) => headers.indexOf(name);
  // code column has a different header per tab
  const iCode = [ 'Code', 'Label Code', 'Label Number', 'Item #' ].map(at).find((i) => i !== -1);
  const cell = (r, name) => { const i = at(name); return (i === -1 || r[i] === undefined || r[i] === null) ? '' : r[i]; };
  const out = [];
  for (let n = 1; n < values.length; n++) {
    const r = values[n] || [];
    if (!r.some((c) => c !== '' && c !== null && c !== undefined)) continue; // skip blank rows
    out.push({
      __tab: tab,
      __row: n + 1, // 1-based sheet row (row 1 is the header)
      ts: String(cell(r, 'Timestamp') || ''),
      counter: String(cell(r, 'Counter') || ''),
      category,
      code: String((iCode !== undefined && r[iCode] != null) ? r[iCode] : ''),
      desc: String(cell(r, 'Description') || ''),
      weight: String(cell(r, 'Weight') || ''),
      type: String(cell(r, 'Type') || ''),
      per: numOr0(cell(r, 'Per Unit')),
      full: numOr0(cell(r, 'Full')),
      extra: numOr0(cell(r, 'Extra')),
      total: numOr0(cell(r, 'Total')),
      loc: String(cell(r, 'Location') || ''),
    });
  }
  return out;
}

// Build the row array for a tab (same column order as append).
function rowForTab(tab, e) {
  if (tab === TAB.plasticsOut) return [e.ts, e.counter, e.code, e.desc, e.type, e.per, e.full, e.extra, e.loc, e.total];
  if (tab === TAB.cansOut) return [e.ts, e.counter, e.code, e.desc, e.per, e.full, e.extra, e.loc, e.total];
  return [e.ts, e.counter, e.code, e.desc, e.weight, e.type, e.per, e.full, e.extra, e.loc, e.total]; // Ends
}
// Overwrite an existing row in place (identified by __tab + __row).
async function updateEntry(sheets, e) {
  e = e || {};
  if (!e.__tab || !e.__row) throw new Error('Missing row reference for update');
  await sheets.update(e.__tab + '!A' + e.__row, [rowForTab(e.__tab, e)]);
  return true;
}
// Delete a row entirely (identified by __tab + __row).
async function deleteEntry(sheets, ref) {
  ref = ref || {};
  if (!ref.__tab || !ref.__row) throw new Error('Missing row reference for delete');
  const sheetId = await sheets.sheetId(ref.__tab);
  if (sheetId == null) throw new Error('Tab not found: ' + ref.__tab);
  await sheets.deleteRow(sheetId, ref.__row);
  return true;
}

// Clear every counted row for ONE department, leaving the header intact. Metals clears both the
// Cans and Ends tabs; Plastics clears only the Plastics tab — so deleting one never touches the
// other. Tabs that don't exist yet are skipped.
async function clearDept(sheets, dept) {
  const tabs = (dept === 'plastics') ? [TAB.plasticsOut] : [TAB.cansOut, TAB.endsOut];
  for (let i = 0; i < tabs.length; i++) {
    await sheets.clearRows(tabs[i]);
  }
  return true;
}

// ---------------- Google auth + Sheets ----------------
let cachedToken = null;

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
async function makeSheets(env, overrideId) {
  const token = await getToken(env);
  const id = overrideId || env.SHEET_ID || DEFAULT_SHEET_ID;
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + id;
  const auth = { Authorization: 'Bearer ' + token };
  async function call(url, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    // Only reads (GET) are auto-retried — retrying a write could duplicate a row that actually
    // committed before its response failed. Google's 429 (rate limit) and 5xx (e.g. the 503
    // "service is currently unavailable") are transient, so a read backs off and tries again.
    const maxAttempts = method === 'GET' ? 4 : 1;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let r, t;
      try {
        r = await fetch(url, opts);
        t = await r.text();
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts) { await sleep(300 * attempt); continue; }
        throw new Error('Sheets API request failed: ' + (e && e.message ? e.message : String(e)));
      }
      let j; try { j = t ? JSON.parse(t) : {}; } catch (e) { throw new Error('Sheets API non-JSON: ' + t.slice(0, 200)); }
      if (!r.ok) {
        if (method === 'GET' && (r.status === 429 || r.status >= 500) && attempt < maxAttempts) {
          await sleep(300 * attempt); continue;
        }
        throw new Error('Sheets API ' + r.status + ': ' + (j.error && j.error.message ? j.error.message : t.slice(0, 200)));
      }
      return j;
    }
    throw lastErr || new Error('Sheets API failed');
  }
  return {
    id,
    // Read every data row (row 2 onward) of a tab as raw values.
    async rows(tab) {
      const j = await call(base + '/values/' + encodeURIComponent(tab)
        + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER', { headers: auth });
      const values = j.values || [];
      return values.slice(1); // drop the header row
    },
    async append(tab, row) {
      // Anchor the append at A1 so Sheets treats the header row (A1) as the table and always
      // writes the new row in column A. Without the "!A1" anchor it auto-detects a table from the
      // whole sheet and can latch onto a stray block off to the right (e.g. starting at column I).
      return call(base + '/values/' + encodeURIComponent(tab + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) });
    },
    // Overwrite values starting at a range (e.g. "Cans!A5").
    async update(rangeA1, values) {
      return call(base + '/values/' + encodeURIComponent(rangeA1) + '?valueInputOption=RAW',
        { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
    },
    // List every tab title in the workbook (used to locate the log tabs by name).
    async titles() {
      const meta = await call(base + '?fields=sheets.properties.title', { headers: auth });
      return (meta.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
    },
    // Resolve a tab's numeric sheetId (needed to delete a row).
    async sheetId(title) {
      const meta = await call(base + '?fields=sheets.properties(title,sheetId)', { headers: auth });
      const s = (meta.sheets || []).find((x) => x.properties && x.properties.title === title);
      return s ? s.properties.sheetId : null;
    },
    // Delete a single row (1-based) from a tab, shifting rows below it up.
    async deleteRow(sheetId, row1Based) {
      return call(base + ':batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ deleteDimension: { range: {
            sheetId, dimension: 'ROWS', startIndex: row1Based - 1, endIndex: row1Based } } }] }) });
    },
    // Read every value in a tab (including the header row).
    async readAll(tab) {
      const j = await call(base + '/values/' + encodeURIComponent(tab)
        + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING', { headers: auth });
      return j.values || [];
    },
    // Create a tab (with a header row) if it doesn't already exist.
    async ensureTab(title, header) {
      const meta = await call(base + '?fields=sheets.properties.title', { headers: auth });
      const exists = (meta.sheets || []).some((s) => s.properties && s.properties.title === title);
      if (exists) return false;
      await call(base + ':batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }) });
      if (header && header.length) {
        await call(base + '/values/' + encodeURIComponent(title) + '!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
          { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [header] }) });
      }
      return true;
    },
    // Clear all data rows (row 2 down), keeping the header row. No-op if the tab doesn't exist.
    async clearRows(tab) {
      try {
        return await call(base + '/values/' + encodeURIComponent(tab + '!A2:Z100000') + ':clear',
          { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
      } catch (err) {
        if (String((err && err.message) || '').indexOf('Unable to parse range') !== -1) return null;
        throw err;
      }
    },
    // Append; if the tab doesn't exist yet, create it (with header) and retry once.
    async appendEnsuring(tab, row, header) {
      try {
        return await this.append(tab, row);
      } catch (err) {
        if (String((err && err.message) || '').indexOf('Unable to parse range') !== -1) {
          await this.ensureTab(tab, header);
          return await this.append(tab, row);
        }
        throw err;
      }
    },
  };
}
