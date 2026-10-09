# Partners Module — Full Implementation Plan (LedgerPro)

**Status:** PLAN (not implemented) · **Target migration:** `0055_partners`
**Pattern followed:** Fixed Assets (Module 9) — entity + runs + per-item snapshots

---

## 1. Concept (business logic)

Har partner ke **do hisaab-khatein** (GL accounts) hotay hain:

| Khata | Type | Matlab |
|---|---|---|
| **Capital Account** (`3011`, `3012`…) | EQUITY | Partner ne business mein kitna paisa lagaya (permanent investment) |
| **Current Account** (`3021`, `3022`…) | EQUITY (or LIABILITY) | Roz-marra: drawings nikalna, profit ka hissa jama hona |

**4 operations:**

1. **Capital Contribution** — Partner paisa/assets lagata hai
   `Dr Cash/Bank 100,000 → Cr Partner Capital 100,000`
2. **Drawing** — Partner zaati kharch ke liye paisa nikalta hai
   `Dr Partner Current 20,000 → Cr Cash 20,000`
3. **Profit Distribution** — Saal/end-of-period ka net profit, profit-share % ke mutabiq baantna
   `Dr Retained Earnings 500,000 → Cr Partner-A Current 300,000 → Cr Partner-B Current 200,000`
4. **Loss Distribution** — Same, ulta (partners ke current accounts debit)

**Golden rule:** Capital account sirf investment/withdrawal of investment se hilta hai.
Roz ke len-den (drawings, profit) Current account mein hotay hain. Is se har waqt
pata chalta hai: "partner ne kitna lagaya, kitna nikala, kitna profit kamaya."

---

## 2. Database Schema (migration `0055_partners.sql`)

```sql
-- Partners register
CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  phone TEXT,
  cnic TEXT,                                  -- optional identity
  profit_share_bps INTEGER NOT NULL DEFAULT 0, -- 2500 = 25.00% (basis points, no floats)
  capital_account_id TEXT NOT NULL REFERENCES accounts(id),
  current_account_id TEXT NOT NULL REFERENCES accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX partners_company_name ON partners (company_id, name);
CREATE INDEX partners_company ON partners (company_id);

-- Every capital movement (contribution / drawing / return of capital)
CREATE TABLE partner_transactions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  partner_id TEXT NOT NULL REFERENCES partners(id),
  kind TEXT NOT NULL,               -- CONTRIBUTION | DRAWING | CAPITAL_RETURN
  amount INTEGER NOT NULL,          -- paisa, always positive
  account_id TEXT NOT NULL REFERENCES accounts(id),  -- cash/bank side
  journal_entry_id TEXT REFERENCES journal_entries(id),
  date INTEGER NOT NULL,
  memo TEXT,
  created_by_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX pt_company_partner ON partner_transactions (company_id, partner_id, date);

-- Profit/loss distribution runs (DRAFT → POSTED → VOIDED, like depreciation_runs)
CREATE TABLE profit_distributions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,    -- paisa, +profit / -loss
  status TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | POSTED | VOIDED
  journal_entry_id TEXT REFERENCES journal_entries(id),
  memo TEXT,
  created_by_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- Per-partner snapshot (audit trail of each run)
CREATE TABLE distribution_entries (
  id TEXT PRIMARY KEY,
  distribution_id TEXT NOT NULL REFERENCES profit_distributions(id),
  partner_id TEXT NOT NULL REFERENCES partners(id),
  share_bps INTEGER NOT NULL,
  amount INTEGER NOT NULL,          -- paisa, signed (+profit / -loss)
  created_at INTEGER NOT NULL
);
```

**Account backfill** (existing companies): per-partner accounts `3011+` / `3021+` are created
**at partner registration time** (not via migration), because the count of partners is unknown.
Migration only ensures no code collisions via `WHERE NOT EXISTS` guards in the registration API.

**Auto-created accounts on "Add Partner":**
- `3011` — "Capital — {Name}" (EQUITY, system)
- `3021` — "Current — {Name}" (EQUITY, system)
- Next partner gets `3012`/`3022`, etc. (first free code in range)

---

## 3. Posting Logic (`lib/partners.ts`)

```ts
postCapitalContribution(tx, { companyId, partnerId, amount, cashAccountId, date, memo, createdById })
// Dr cashAccountId  →  Cr partner.capital_account_id

postDrawing(tx, { companyId, partnerId, amount, cashAccountId, date, memo, createdById })
// Dr partner.current_account_id  →  Cr cashAccountId

postProfitDistribution(tx, { companyId, distributionId, createdById })
// For each active partner: share = total * profit_share_bps / 10000 (remainder → largest partner)
// Profit (+): Dr 3003 Retained Earnings → Cr each partner.current_account_id
// Loss (−):   Dr each partner.current_account_id → Cr 3003 Retained Earnings
// Sets status POSTED, stores journal_entry_id

voidProfitDistribution(tx, { companyId, distributionId, createdById })
// Reversing journal, status VOIDED (never delete posted entries — immutable ledger rule)
```

**Rounding:** basis-points math with remainder assigned to the largest shareholder
(same pattern as payroll splits). All amounts integer paisa.

**Validation:**
- Sum of active partners' `profit_share_bps` should be 10000 (warn, don't hard-block — allows silent partners)
- Distribution total defaults to current Retained Earnings balance (one-click "distribute full profit")
- Drawings never blocked (partnership law allows negative current accounts), but UI warns

---

## 4. API Routes (`app/api/partners/`)

| Route | Method | Action | Permission |
|---|---|---|---|
| `/api/partners` | GET | List partners + balances | `partners` |
| `/api/partners` | POST | Register (creates 301x/302x accounts) | `partners` |
| `/api/partners/[id]` | GET/PATCH | Detail / edit share %, deactivate | `partners` |
| `/api/partners/[id]/contribute` | POST | Capital contribution (posts journal) | `partners` |
| `/api/partners/[id]/draw` | POST | Drawing (posts journal) | `partners` |
| `/api/partners/[id]/ledger` | GET | Partner ledger (capital + current) | `partners` |
| `/api/partners/distributions` | GET/POST | List / create DRAFT run | `partners` |
| `/api/partners/distributions/[id]/post` | POST | Post (DRAFT → POSTED) | `partners` |
| `/api/partners/distributions/[id]/void` | POST | Void (POSTED → VOIDED + reversal) | `partners` |

All routes: `requirePermission("partners")`, company-scoped, idempotency keys on posts.

---

## 5. UI (`app/(app)/partners/`)

**Page layout** (permission-gated, sidebar under ACCOUNTS group):
1. **Partner cards** — har partner ka card: photo initial, name, profit %, Capital balance, Current balance, Total equity
2. **"Add Partner" dialog** — beginner-friendly (jaisa assets dialog): Name, Profit share %, optional phone/CNIC/notes → auto-creates accounts
3. **Partner detail view** — two ledgers (Capital / Current), buttons: "Add Capital", "Record Drawing"
4. **Distribution wizard** — 3 steps:
   - Step 1: Period + amount (default = Retained Earnings balance, "full profit" one-click)
   - Step 2: Preview per-partner shares (editable before posting)
   - Step 3: Post → journal created, each partner's current account credited
5. **Reports tab** — Partner Capital Statement (opening + contributions − drawings ± profit share = closing)

**Sidebar:** `Partners` nav item, `perm: "partners"`, icon `Handshake`, group `accounts`.

---

## 6. Permissions & i18n

- New permission `"partners"` in `lib/permission-keys.ts` (owner-only default, like `assets`)
- i18n keys: `partners.*` (EN + UR, simple Urdu script), `perms.partners` label/description
- Sidebar + route guards via `requirePermission("partners")`

---

## 7. Reports

- **Partner Capital Statement** (new preset): per partner —
  Opening Capital + Contributions − Capital Returns ± Profit/(Loss) Share − Drawings = Closing Balance
- **Balance Sheet**: partner `301x`/`302x` EQUITY accounts auto-appear under equity (zero report changes needed)
- **Distribution history**: list of POSTED/VOIDED runs with per-partner breakdown

---

## 8. Tests (new file `tests/partners.test.ts`)

1. Partner registration creates `3011`/`3021` accounts (no collision on 2nd partner → `3012`/`3022`)
2. Contribution posts balanced journal (Dr Cash / Cr Capital)
3. Drawing posts balanced journal (Dr Current / Cr Cash)
4. Distribution splits by bps with remainder handling; debits == credits
5. Loss distribution reverses direction correctly
6. Void creates reversing journal; original immutable
7. Company isolation: partner of company A invisible to company B
8. Permission: staff without `partners` grant gets 403

---

## 9. Build Phases

| Phase | Work | Est. |
|---|---|---|
| 1 | Migration `0055` + `lib/partners.ts` posting logic + unit tests | core |
| 2 | API routes (9 endpoints) + permission wiring | core |
| 3 | UI: list + add dialog + detail + ledgers | core |
| 4 | Distribution wizard (DRAFT → POSTED → VOIDED) | core |
| 5 | Partner Capital Statement report + sidebar + i18n EN/UR | polish |
| 6 | Full suite (1089+ new tests), tsc, build, push + production migration | release |

**Accounting rules honored:** integer paisa (bps for %), `company_id` isolation everywhere,
immutable posted entries (void via reversal), reports use SYS codes, no dev.db shipped.
