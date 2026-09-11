/**
 * Pure-logic tests for the movement backend. Run: `node test.mjs`
 * These cover the parts that don't need Google auth: qty math, the production flag,
 * and the 21-column row shape.
 */
import {
  MOVEMENTS_HEADER, isProductionBuilding, computeQtyEach, buildMovementRow,
} from './worker.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error(`FAIL: ${label}\n  expected ${e}\n  got      ${a}`); }
}
function ok(cond, label) { if (cond) pass++; else { fail++; console.error(`FAIL: ${label}`); } }

// --- isProductionBuilding ---
ok(isProductionBuilding('Metals Production'), 'Metals Production is production');
ok(isProductionBuilding('Plastics Production'), 'Plastics Production is production');
ok(!isProductionBuilding('Shipping'), 'Shipping is not production');
ok(!isProductionBuilding('Shipped Out'), 'Shipped Out is not production');
ok(!isProductionBuilding(''), 'empty is not production');

// --- computeQtyEach ---
eq(computeQtyEach('Pallets', 3, 100), 300, 'pallets x per-pallet');
eq(computeQtyEach('Each', 42, 100), 42, 'each ignores per-pallet');
eq(computeQtyEach('pallets', 2.5, 100), 250, 'lowercase entry method + fractional pallets');
eq(computeQtyEach('Each', '', 100), 0, 'blank qty -> 0');
eq(computeQtyEach('Pallets', 5, ''), 0, 'blank per-pallet -> 0');

// --- buildMovementRow: shape + positions ---
const fixedNow = new Date('2026-09-11T15:04:05.000Z');
const row = buildMovementRow({
  user: 'Jon', barcode: 'ABC123', product: 'ABC123', desc: '12oz Can',
  kind: 'Metals', entryMethod: 'Pallets', qtyEntered: 3, unitsPerPallet: 100,
  fromBuilding: 'Monarch', fromLocation: 'M-12', toBuilding: 'Shipping', toLocation: 'S-3',
  reference: 'PO-9', note: 'partial',
}, fixedNow);

eq(row.length, MOVEMENTS_HEADER.length, 'row has 21 columns');
eq(row[2], '2026-09-11', 'event date defaults to logged-at date');
eq(row[5], 'ABC123', 'product in col 6');
eq(row[8], 'Pallets', 'entry method in col 9');
eq(row[9], 3, 'qty entered in col 10');
eq(row[11], 100, 'units per pallet in col 12');
eq(row[12], 300, 'qty each in col 13');
eq(row[13], 'Monarch', 'from building in col 14');
eq(row[15], 'Shipping', 'to building in col 16');
eq(row[19], '', 'no production flag for Shipping');
ok(/^MV-/.test(row[0]), 'movement id generated');
eq(row[1], '2026-09-11T15:04:05.000Z', 'logged-at is server ISO');

// --- production flag is applied automatically on To=Production ---
const prodRow = buildMovementRow({
  product: 'PAIL5', desc: '5gal Pail', kind: 'Plastics',
  entryMethod: 'Each', qtyEntered: 40, unitsPerPallet: 48,
  fromBuilding: 'Wyle', toBuilding: 'Plastics Production',
}, fixedNow);
eq(prodRow[19], 'In Production', 'To=Plastics Production sets In Production flag');
eq(prodRow[12], 40, 'each entry -> qty each = qty entered');

// --- explicit movement id is preserved (offline dedup) ---
const kept = buildMovementRow({ movementId: 'MV-CLIENT-1', product: 'X', fromBuilding: 'A', toBuilding: 'B' }, fixedNow);
eq(kept[0], 'MV-CLIENT-1', 'client-supplied movement id preserved');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
