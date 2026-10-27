# Hosting: GitHub Pages front end + Cloudflare Worker backend

```
Browser (github.io page)  ──fetch {fn,args}──▶  Cloudflare Worker  ──▶  Google Sheet
   docs/index.html                                worker.js              (service account)
```

- **GitHub Pages** serves the UI (`docs/index.html`) — a plain `*.github.io` URL, no custom
  domain needed.
- **Cloudflare Worker** (`worker.js`) is the backend: it reads/writes the Inventory spreadsheet
  directly with a **Google service account** (no Apps Script). Self-contained — paste it into a
  dashboard Worker, no build step.
- Both **reads and writes** run on the Worker: `getLookups()` loads the three lookup tabs and
  `appendEntry()` writes a counted row to the `Cans` / `Ends` / `Plastics` tabs (Cans and Ends
  are auto-created on first use if missing) — the same contract the
  Apps Script backend used. The Apps Script version can stay as a fallback if you like.

> Uses GitHub Pages, not Cloudflare Pages, for the front end.

---

## Step 1 — Service account can reach the sheet
1. Share the **Inventory** spreadsheet with the service account's email
   (`…@…iam.gserviceaccount.com`, the `client_email` in the key JSON) — give it **Editor**
   (Editor is required because the app writes counts back to the sheet).
2. Google Cloud Console → the service account's project → **APIs & Services → Library →
   Google Sheets API → Enable**.
3. Note the spreadsheet id — it's the long string in the sheet URL between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

## Step 2 — Create the Cloudflare Worker
1. Cloudflare → **Workers & Pages → Create → Create Worker** → name it e.g.
   `inventory-count-api` → Deploy.
2. **Edit code** → delete the template → paste all of **`worker.js`** → **Deploy**.
3. **Settings → Variables and Secrets → Add:**
   - `GCP_SA_EMAIL` (Secret) = the service account email.
   - `GCP_SA_PRIVATE_KEY` (Secret) = the `private_key` value from the key JSON (paste verbatim;
     the `\n`s are fine).
   - `SHEET_ID` (Variable, optional) — the Inventory workbook id is baked into `worker.js` as
     the default, so you only need this if the workbook ever changes.
   - `ALLOWED_ORIGIN` (optional) = `https://<youruser>.github.io` to lock CORS to your page.
   - `API_TOKEN` (optional Secret) = a long random string, if you want a shared-token gate.
   - Deploy again after adding variables.
4. Copy the Worker URL, e.g. `https://inventory-count-api.<subdomain>.workers.dev`.
5. Test: open that URL in a browser → `{"ok":true,"service":"inventory-count-api","build":"v1"}`.

## Step 3 — Point the front end at the Worker
In `docs/index.html`, set near the top:
```js
var API_URL = 'https://inventory-count-api.<subdomain>.workers.dev';  // your Worker URL
var API_SECRET = '';   // set only if you added API_TOKEN in Step 2
```
Commit. (Or paste me the Worker URL and I'll set it and push.)

## Step 4 — Turn on GitHub Pages
1. GitHub repo → **Settings → Pages**.
2. **Source: Deploy from a branch** → Branch `claude/litho-scanner-app-y1zwfn`, Folder **`/docs`**
   → Save. *(The repo root has `Index.HTML` with a capital I, which Pages won't serve as an
   index — `/docs` has the correct lowercase `index.html`.)*
3. Wait ~1 min → open the `https://<youruser>.github.io/inventory-scanner/` URL.

## Step 5 — Verify
- The landing screen shows **"N items loaded"** (the lookup tabs came through the Worker).
- Pick a department, scan/type a code, enter a count, **Save entry** → a "Saved · N units" toast,
  and a new row appears in the `Cans`, `Ends`, or `Plastics` tab of the sheet (Cans/Ends are
  created automatically the first time you save one).

## Troubleshooting
- App shows **"Service account not configured"** → the Worker secrets didn't save, or you didn't
  redeploy after adding them.
- **"Sheets API 403"** → the sheet isn't shared with the service account email, or the Sheets API
  isn't enabled on its project.
- **"Sheets API 400 … Unable to parse range"** → a *lookup* tab name doesn't match. The Worker
  expects `Ends_Lookup`, `Cans_Lookup`, `Plastics_Lookup` for reads; output tabs `Cans`, `Ends`,
  `Plastics` are created automatically (edit `TAB` in
  `worker.js` if yours differ).
- **Could not load item lists / CORS error in dev-tools** → `API_URL` in `docs/index.html`
  doesn't match the Worker URL, or `ALLOWED_ORIGIN` doesn't match your github.io origin (or
  leave it unset to allow all).
- Page 404 "provide an index.html" → Pages Source is the repo root; switch it to **`/docs`**.

## Security note
With a plain github.io page, the optional `API_TOKEN` lives in the page source, so it only
deters casual access. It's fine for an internal floor tool; if you later want a real login gate,
we can move the page onto a Cloudflare-proxied domain and add Cloudflare Access (Google SSO).
