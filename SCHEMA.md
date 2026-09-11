# CSC Live Inventory — data model

A perpetual-inventory **movement logger** for the shipping / warehouse floor. Every action in
the app is a single-product **movement**: _this product · this many · From building → To building_.

## Sheets

| # | Workbook | Access | What the app uses |
|---|----------|--------|-------------------|
| Movements | `1xaXUqrRbr3C6yM10Tw9a0ctL2zjbrrNAFzn3ZPNr704` | **read + write** | reads `Buildings`, appends to the movements tab |
| Product master | `1GNw1gAnB1jI9L6PdUoUeQAlOKCHlPJ1f0-kxcQroI9U` | **read only** | `Cans_Lookup`, `Ends_Lookup`, `Plastics_Lookup` |

The service account needs **Editor** on the Movements workbook and **Viewer** on the product master.
The product master is **never written** by this app.

## Movements tab — 21 columns (A:U, written by position)

`Movement ID · Logged At · Event Date · User · Barcode · Product · Description · Kind ·
Entry Method · Qty Entered · UOM · Units Per Pallet · Qty Each · From Building · From Location ·
To Building · To Location · Reference · Note · Flags · Voids`

- **Product** is the canonical SKU/code from the lookup (falls back to description if a can has no
  code). Keep this stable — reconciliation later matches on it.
- **Kind** is the coarse category: `Metals` or `Plastics`.
- **Qty Each** is the total unit count. Entering by *pallet* multiplies Qty Entered × Units Per Pallet;
  entering by *each* is 1:1.
- **Movement ID** and **Logged At** are stamped by the Worker (server time, ISO).
- The Worker writes with `valueInputOption=RAW`, so a value starting with `=` is never treated as a
  formula.

## Buildings tab

`Building | Staging Location | Location Prefix | Counts As Inventory | Sort Order`

Read live and used for the From / To pickers, sorted by Sort Order.

## Production & the "In Production" flag

- **Metals Production / Plastics Production** are creation + transformation points. They are always
  available as a **From** building (you can add stock that wasn't there before).
- Any move whose **To** building is a production environment (name contains "Production") is
  automatically stamped **`Flags = In Production`**. That's how a product going in to be transformed
  is tracked, without a two-product conversion screen — the finished product comes back out later as
  its own move (Production → building).

## Worker API (`POST {fn, args}`)

- `bootstrap()` → `{ lookups:{ends,cans,plastics}, buildings }`
- `logMovement(movement)` → `{ movementId, loggedAt, qtyEach, flags }`
- `recentMovements(limit)` → last N movements (newest first)

## Not built yet (Phase 2)

Reconciliation / live on-hand totals (baseline count + replayed movements) and the Finished Goods
screen. See the handoff spec. `Counts As Inventory` for Metals Production is currently `TRUE` in the
sheet; decide its treatment when building reconciliation.
