# Module 12 — Manufacturing & BOM

Migration `0043_module12_manufacturing.sql`. Library: `lib/manufacturing.ts`.
API: `app/api/manufacturing/**`. UI: `app/(app)/manufacturing/**`.

## Scope decisions

- **BOM levels:** native BOM is **single-level** — one header (finished product +
  version) with component lines (qty per finished unit + scrap %). There is no
  recursive recipe explosion. Multi-level production is achieved two ways, both
  pre-existing mechanisms:
  1. **Chained work orders:** a component that is itself manufactured gets its
     own WO first; the parent WO issues the component from stock like any
     purchased raw material.
  2. **Bundles:** sales-side kits keep using the existing bundles mechanism
     (nested, cycle-guarded); they are not manufacturing documents.
- **Labor payable:** dedicated account **2123 Manufacturing Labor Payable**
  (LIABILITY), NOT payroll's 2119 Salaries Payable. Reason: payroll reconciles
  2119 against salary runs (disbursement batches, EOBI/PF); factory labor
  includes daily-wage laborers outside payroll — mixing them would muddy the
  payroll audit trail.
- **Overhead:** new expense account **6050 Manufacturing Overhead**. The
  completion journal credits 6050 as "overhead absorbed". Actual overhead costs
  (electricity, factory rent, …) are booked through the normal expense flow;
  net P&L = actual − absorbed. Absorbed/actual variance reporting is deferred.
- **WIP:** **1250 Work-in-Progress Inventory** (ASSET).
- **Variances & by-products:** explicitly skipped (follow-ups).
- **No routings / shifts / machines.** Labor and overhead are per-WO manual
  cost inputs entered at completion.
- **Partial production:** a WO receives exactly its planned qty; partial /
  over-production completes are a follow-up.

## Lifecycle

```
DRAFT → RELEASED → IN_PROGRESS → COMPLETED
  │         │
  └─CANCELLED    COMPLETED → VOIDED
```

- **DRAFT:** editable (qty, branch, notes). Created via `createWorkOrder`
  (MWO-0001 sequence; idempotent on client key).
- **RELEASE:** snapshots the BOM into `work_order_components` (required qty
  incl. scrap, rounded UP). Immutable afterwards — later BOM edits create new
  versions and never touch released WOs.
- **ISSUE:** deducts components via `applyStock` (moving-average cost,
  half-up) and posts **one** balanced journal:
  `Dr 1250 WIP / Cr 1200 Inventory`. Idempotent via journal idempotency key
  `wo-issue:<id>`; fails `INSUFFICIENT_STOCK` when components are short.
- **COMPLETE:** takes labor + overhead inputs and posts **one** balanced journal:
  ```
  Dr 1250 WIP (labor)      Cr 2123 Mfg Labor Payable
  Dr 1250 WIP (overhead)   Cr 6050 Mfg Overhead (absorbed)
  Dr 1200 FG Inventory      Cr 1250 WIP            ← actual total cost
  ```
  Actual total cost = components + labor + overhead. Finished goods are added
  to stock at actual unit cost (half-up per-unit paisa; ±1p rounding vs the GL
  is the same accepted pattern as purchase posting). Idempotent via
  `wo-complete:<id>`.
- **VOID:** COMPLETED → VOIDED. Restores component stock (re-added at the
  issue-time average unit cost — an approximation, since the live moving
  average is recomputed not rewound), deducts the finished goods (blocked with
  `INSUFFICIENT_STOCK` when the goods were already sold), and posts
  mirror-image **reversing journals of both** the issue and completion events
  (source `MFG_VOID`, idempotent).

## Ledger rules

- Money = integer paisa / BigInt only. Qty = milli (thousandths).
- `company_id` on every table and every query; journal account ids resolved
  per-company via `accountMap` (SYS codes, never hardcoded ids).
- Every posting balances Dr == Cr (`assertBalanced` inside `createJournal`).
- Period lock respected on issue / completion / void dates.
- `requirePermission("manufacturing")` on every API route; the key is
  owner-granted (not in staff defaults) with its own team-editor group.

## Scrap math

Per-unit qty incl. scrap: `ceil(qtyPerUnitMilli × (100 + scrapPct) / 100)`.
WO total: `ceil(perUnit × woQtyMilli / 1000)` — rounded UP so a line never
runs short. `perUnitQtyWithScrap` / `requiredQtyMilli` / `rollupCost` are pure
functions in `lib/manufacturing.ts` (unit-tested directly).
