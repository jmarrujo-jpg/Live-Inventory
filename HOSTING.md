# Hosting: GitHub Pages front end + Cloudflare Worker backend

```
Browser (github.io page)  ──fetch {fn,args}──▶  Cloudflare Worker  ──▶  Google Sheets
   docs/index.html                                worker.js          Movements (r/w) + lookups (read)
```

- **GitHub Pages** serves the UI (`docs/index.html`) — a plain `*.github.io` URL. `docs/.nojekyll`
  keeps Pages from touching the files.
- **Cloudflare Worker** (`worker.js`) is the backend. It **reads** the product master (the three
  `*_Lookup` tabs, read-only) and the `Buildings` map, and **writes** one row per movement to the
  Movements workbook, using a **Google service account** (no Apps Script). Self-contained — paste it
  into a dashboard Worker, no build step.

## Step 1 — Service account can reach the sheets
1. Share the **Movements** workbook (`1xaXUqrRbr3C6yM10Tw9a0ctL2zjbrrNAFzn3ZPNr704`) with the service
   account email (`…@…iam.gserviceaccount.com`) — **Editor** (the app writes movements here).
2. Share the **Product master** workbook (`1GNw1gAnB1jI9L6PdUoUeQAlOKCHlPJ1f0-kxcQroI9U`) with the
   same email — **Viewer** (read-only; the app never writes here).
3. Google Cloud Console → the service account's project → **APIs & Services → Library →
   Google Sheets API → Enable**.

## Step 2 — Create the Cloudflare Worker
1. Cloudflare → **Workers & Pages → Create → Create Worker** → name it e.g. `live-inventory` → Deploy.
2. **Edit code** → delete the template → paste all of **`worker.js`** → **Deploy**.
3. **Settings → Variables and Secrets → Add:**
   - `GCP_SA_EMAIL` (Secret) = service account email.
   - `GCP_SA_PRIVATE_KEY` (Secret) = the `private_key` from the key JSON (paste verbatim; `\n`s ok).
   - `ALLOWED_ORIGIN` (Variable) = `https://jmarrujo-jpg.github.io` (locks CORS to your page).
   - `API_TOKEN` (optional Secret) = a long random string, if you want a shared-token gate.
   - `MOVEMENTS_TAB` (optional Variable) = a sandbox tab name (e.g. `Movements_Sandbox`) while you're
     testing. The Worker auto-creates the tab + header. Leave unset (or set `Movements`) for the real
     tab. Delete this variable when you're ready to write live movements.
   - Deploy again after adding variables.
4. Copy the Worker URL, e.g. `https://live-inventory.<subdomain>.workers.dev`.
5. Test: open the URL → `{"ok":true,"service":"csc-live-inventory","build":"v1"}`.

## Step 3 — Point the front end at the Worker
In `docs/index.html`, near the top of the first `<script>`:
```js
var API_URL = 'https://live-inventory.<subdomain>.workers.dev';  // your Worker URL
var API_SECRET = '';   // set only if you added API_TOKEN in Step 2
```
Commit + push.

## Step 4 — Turn on GitHub Pages
1. GitHub repo → **Settings → Pages**.
2. **Source: Deploy from a branch** → Branch (your dev branch or `main` once merged), Folder **`/docs`**
   → Save.
3. Wait ~1 min → open the `https://jmarrujo-jpg.github.io/live-inventory/` URL.

## Step 5 — Verify
- The header subtitle shows **"N products · M buildings"** (bootstrap came through).
- Scan/type a code → pick a qty → From → To → **Save move** → a "Saved · N units" toast, and a new
  row appears in the movements tab. Moving *to* a Production building shows the **In Production** flag.

## Troubleshooting
- **"Service account not configured"** → Worker secrets didn't save, or you didn't redeploy.
- **"Sheets API 403"** → a sheet isn't shared with the service account, or the Sheets API isn't enabled.
- **"Sheets API 400 … Unable to parse range"** → a tab name doesn't match (`Ends_Lookup`, `Cans_Lookup`,
  `Plastics_Lookup`, `Buildings`).
- **Could not load / CORS error** → `API_URL` doesn't match the Worker URL, or `ALLOWED_ORIGIN` doesn't
  match your github.io origin (or leave it unset to allow all).

## Security note
With a plain github.io page, the optional `API_TOKEN` lives in the page source, so it only deters
casual access. Fine for an internal floor tool; for a real gate, move the page behind a
Cloudflare-proxied domain + Cloudflare Access (Google SSO).
