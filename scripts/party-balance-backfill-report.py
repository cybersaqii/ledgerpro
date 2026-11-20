#!/usr/bin/env python3
"""Party-balance backfill REPORT — READ-ONLY. NOT RUN. Review-before-run.
=========================================================================
Phase 1 (2026-11-20): the stored `parties.balance` drifted from the
journal-derived balance on production (receivables gap Rs 311,383 in the
2026-11-15 sweep). Root cause found in code: `postFxSettlement`
(lib/posting.ts) posted party-tagged AR/AP lines without bumping the
cached balance — fixed in commit e3804b6, with the void-side reversal in
lib/payment-void.ts. New postings are safe from here on; the HISTORICAL
gap still sits in the stored balances.

What this script does:
  * READ-ONLY SELECTs against production Turso (same credential path as
    turso_query.py; SELECT-only, LIMIT-guarded). It NEVER writes.
  * Recomputes every party's expected balance EXACTLY like
    lib/cached-totals.ts (CUSTOMER: SUM(debit-credit) on AR 1100;
    SUPPLIER: -(SUM(debit-credit)) on AP 2001; a party with lines on
    BOTH accounts is reported UNVERIFIABLE, never auto-fixed).
  * Prints the per-party diff table + totals, and prints the UPDATE
    statements that WOULD fix the fixable rows — it does NOT execute them.

How the fix is actually applied (only on the user's explicit word):
  1. Review this report.
  2. Take a production backup first (scripts/turso-dump-prod.py).
  3. Either POST /api/reconciliation {"applyFixes": true} while logged in
     as the company owner (the route applies the same reconciler inside
     one transaction), or run the printed UPDATEs by hand.
  4. Re-run this report: every row must show diff 0 afterwards.

Usage:
  party-balance-backfill-report.py --company-id <uuid> [--company-name X]
  party-balance-backfill-report.py --all-companies   (summary per company)
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response  # noqa: E402

HOST = "ledgerpro-saqibkhn.aws-ap-south-1.turso.io"
PIPELINE_URL = f"https://{HOST}/v2/pipeline"
TIMEOUT = 120

AR_CODE = "1100"
AP_CODE = "2001"


def pipeline(sql: str) -> list[dict]:
    body = json.dumps({"requests": [{"type": "execute", "stmt": {"sql": sql}}]}).encode()
    req = urllib.request.Request(
        PIPELINE_URL, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    add_surrogate_to_request(req, "custom.turso", allowed_hosts=[HOST])
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = read_json_response(resp)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Turso HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:500]}") from exc
    out = []
    for r in data.get("results", []):
        if r.get("type") == "error":
            err = r.get("error", {})
            raise RuntimeError(f"Turso SQL error: {err.get('message', err)}")
        res = r.get("response", {}).get("result", {})
        cols = [c["name"] for c in res.get("cols", [])]
        for row in res.get("rows", []):
            out.append({c: v.get("value") for c, v in zip(cols, row)})
    return out


def fmt_rs(paisa: int) -> str:
    sign = "-" if paisa < 0 else ""
    return f"{sign}Rs {abs(paisa) // 100:,}.{abs(paisa) % 100:02d}"


def report_company(company_id: str, company_name: str = "") -> dict:
    # Journal-derived nets per (party, AR/AP account) — same query shape as
    # lib/cached-totals.ts: join through journal_entries for tenant scope.
    sums = pipeline(
        "SELECT jl.party_id AS party_id, jl.account_id AS account_id, "
        "COALESCE(SUM(jl.debit - jl.credit), 0) AS net "
        "FROM journal_lines jl "
        "INNER JOIN journal_entries je ON jl.entry_id = je.id "
        "INNER JOIN accounts a ON jl.account_id = a.id "
        f"WHERE je.company_id = '{company_id}' AND jl.party_id IS NOT NULL "
        f"AND a.code IN ('{AR_CODE}', '{AP_CODE}') "
        "GROUP BY jl.party_id, jl.account_id LIMIT 5000"
    )
    accts = pipeline(
        "SELECT id, code FROM accounts "
        f"WHERE company_id = '{company_id}' AND code IN ('{AR_CODE}', '{AP_CODE}') LIMIT 5"
    )
    ar_id = next((a["id"] for a in accts if a["code"] == AR_CODE), None)
    ap_id = next((a["id"] for a in accts if a["code"] == AP_CODE), None)
    parties = pipeline(
        "SELECT id, name, kind, balance FROM parties "
        f"WHERE company_id = '{company_id}' ORDER BY name LIMIT 5000"
    )
    net: dict[str, dict[str, int]] = {}
    for row in sums:
        net.setdefault(row["party_id"], {})[row["account_id"]] = int(row["net"])
    rows = []
    unverifiable = []
    total_gap = 0
    for p in parties:
        m = net.get(p["id"], {})
        ar_net = m.get(ar_id, 0) if ar_id else 0
        ap_net = m.get(ap_id, 0) if ap_id else 0
        if ar_net != 0 and ap_net != 0:
            unverifiable.append((p, ar_net, ap_net))
            continue
        expected = ar_net if p["kind"] == "CUSTOMER" else -ap_net
        stored = int(p["balance"])
        diff = stored - expected
        total_gap += abs(diff)
        rows.append({
            "id": p["id"], "name": p["name"], "kind": p["kind"],
            "stored": stored, "expected": expected, "diff": diff,
        })
    mismatched = [r for r in rows if r["diff"] != 0]
    print(f"\n=== {company_name or company_id} ({company_id}) ===")
    print(f"parties checked: {len(rows)} | mismatched: {len(mismatched)} | "
          f"unverifiable (lines on BOTH AR+AP): {len(unverifiable)} | "
          f"total |gap|: {fmt_rs(total_gap)}")
    for r in sorted(mismatched, key=lambda x: -abs(x["diff"])):
        print(f"  {r['kind']:<8} {r['name'][:40]:<40} stored {fmt_rs(r['stored']):>18} "
              f"expected {fmt_rs(r['expected']):>18} diff {fmt_rs(r['diff']):>18}")
    for p, ar_net, ap_net in unverifiable:
        print(f"  UNVERIFIABLE {p['kind']} {p['name'][:40]} (AR net {ar_net}, AP net {ap_net}) — needs manual review, never auto-fixed")
    if mismatched:
        print("\n-- UPDATE statements that WOULD fix the fixable rows (NOT executed by this script) --")
        for r in mismatched:
            print(f"UPDATE parties SET balance = {r['expected']}, updated_at = <now> WHERE id = '{r['id']}'; -- {r['name']}")
        print("-- Apply only after a backup, via POST /api/reconciliation {\"applyFixes\": true} or by hand. --")
    else:
        print("No party-balance gaps in this company.")
    return {"company_id": company_id, "checked": len(rows), "mismatched": len(mismatched),
            "unverifiable": len(unverifiable), "total_gap_paisa": total_gap}


def main() -> None:
    ap = argparse.ArgumentParser(description="READ-ONLY party-balance backfill report (never writes).")
    ap.add_argument("--company-id", help="Company UUID to report on")
    ap.add_argument("--company-name", default="", help="Label for the report header")
    ap.add_argument("--all-companies", action="store_true", help="Summary across all companies")
    args = ap.parse_args()
    print("READ-ONLY REPORT — this script never writes. Backfill NOT applied.")
    if args.all_companies:
        companies = pipeline("SELECT id, name FROM companies ORDER BY name LIMIT 100")
        grand = 0
        for c in companies:
            r = report_company(c["id"], c["name"])
            grand += r["total_gap_paisa"]
        print(f"\nGRAND TOTAL |gap| across all companies: {fmt_rs(grand)}")
        return
    if not args.company_id:
        ap.error("--company-id or --all-companies is required")
    report_company(args.company_id, args.company_name)


if __name__ == "__main__":
    main()
