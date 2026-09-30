"use client";

/**
 * FIX-3 string bridge: English defaults for the 88 fix3.* i18n keys.
 * These strings live in ~/workspace/qa-audit/i18n/fix3.{en,ur}.json; this
 * module is a stopgap so the new UI renders English until the coordinator
 * merges the fragments into lib/i18n/*. DO NOT add new strings here — add
 * them to the fragment files and regenerate this module.
 */
const EN: Record<string, string> = {
  "fix3.adjAccount": "Affected account",
  "fix3.adjAccountHint": "The expense account that absorbs the loss (or gain). Defaults to General Expenses.",
  "fix3.adjAddLine": "Add line",
  "fix3.adjColAccount": "Account",
  "fix3.adjColCost": "Cost",
  "fix3.adjColDate": "Date",
  "fix3.adjColDoc": "Doc no.",
  "fix3.adjColLineValue": "Value",
  "fix3.adjColProduct": "Product",
  "fix3.adjColQty": "Qty",
  "fix3.adjColReason": "Reason",
  "fix3.adjColValue": "Value",
  "fix3.adjDate": "Date",
  "fix3.adjDetail": "Stock adjustment",
  "fix3.adjEmpty": "No stock adjustments yet.",
  "fix3.adjEmptyHint": "Record breakage, expired goods, theft, found stock or a stock correction.",
  "fix3.adjIn": "In",
  "fix3.adjLines": "Lines",
  "fix3.adjNew": "New adjustment",
  "fix3.adjNotes": "Notes",
  "fix3.adjNotesPh": "What happened?",
  "fix3.adjOut": "Out",
  "fix3.adjProduct": "Product",
  "fix3.adjQty": "Qty (out − / in +)",
  "fix3.adjQtyHint": "Negative removes stock, positive adds it.",
  "fix3.adjReason": "Reason",
  "fix3.adjReasonBreakage": "Breakage",
  "fix3.adjReasonCorrection": "Correction",
  "fix3.adjReasonExpired": "Expired",
  "fix3.adjReasonFound": "Found stock",
  "fix3.adjReasonTheft": "Theft",
  "fix3.adjSave": "Save adjustment",
  "fix3.adjSubtitle": "Record breakage, expiry, theft, found stock and corrections.",
  "fix3.adjTitle": "Stock adjustments",
  "fix3.taxAmount": "Tax amount",
  "fix3.taxAmountHint": "Sales tax paid on this expense, if any (posts to Input Sales Tax).",
  "fix3.trAmount": "Amount",
  "fix3.trColAmount": "Amount",
  "fix3.trColDate": "Date",
  "fix3.trColDoc": "Doc no.",
  "fix3.trColFrom": "From",
  "fix3.trColTo": "To",
  "fix3.trDate": "Date",
  "fix3.trDayCloseCard": "Bank & cash transfers",
  "fix3.trEmpty": "No transfers yet.",
  "fix3.trEmptyHint": "Move money between cash in hand and your bank accounts.",
  "fix3.trFrom": "From account",
  "fix3.trNew": "New transfer",
  "fix3.trNotes": "Note",
  "fix3.trNotesPh": "Optional note",
  "fix3.trSave": "Save transfer",
  "fix3.trSubtitle": "Move money between your own cash and bank accounts.",
  "fix3.trTitle": "Bank / cash transfers",
  "fix3.trTo": "To account",
  "fix3.trView": "View transfers",
  "fix3.unallocate": "Unallocate",
  "fix3.unallocateConfirm": "Free this amount back to unallocated credit? The journal stays untouched.",
  "fix3.unallocating": "Unallocating…",
  "fix3.voidExpense": "Void expense",
  "fix3.voidExpenseConfirm": "Void this expense? A reversing journal will be posted — the original stays on record.",
  "fix3.voidPayment": "Void payment",
  "fix3.voidPaymentConfirm": "Void this payment? A reversing journal will be posted — the original stays on record.",
  "fix3.voidReason": "Reason (optional)",
  "fix3.voidReasonPh": "Why is this being voided?",
  "fix3.voided": "Voided",
  "fix3.voiding": "Voiding…",
  "fix3.woAccount": "Bad-debts account",
  "fix3.woAccountHint": "The expense account that absorbs the loss. Defaults to General Expenses.",
  "fix3.woAmount": "Write-off amount",
  "fix3.woButton": "Write off",
  "fix3.woColAmount": "Amount",
  "fix3.woColDate": "Date",
  "fix3.woColDoc": "Doc no.",
  "fix3.woColInvoice": "Invoice",
  "fix3.woColParty": "Party",
  "fix3.woColStatus": "Status",
  "fix3.woConfirm": "Write off {amount} on invoice {docNo}? This posts Dr Bad Debts / Cr Receivables.",
  "fix3.woDate": "Date",
  "fix3.woInvoice": "Invoice",
  "fix3.woList": "Write-offs",
  "fix3.woNotes": "Notes",
  "fix3.woNotesPh": "Why is this uncollectible?",
  "fix3.woOutstanding": "Outstanding",
  "fix3.woRecover": "Recover",
  "fix3.woRecoverConfirm": "Reverse this write-off? The collectible balance and party balance will be restored.",
  "fix3.woRecovered": "Recovered",
  "fix3.woSave": "Write off",
  "fix3.woTitle": "Bad-debt write-off",
};

/**
 * Returns the translated string for a fix3.* key.
 * The app tr() falls back to the key itself when the fragment is not yet
 * merged, so we substitute the English default in that case. Urdu arrives
 * automatically once the fragments land in lib/i18n/*.
 */
export function fx(t: (key: string, vars?: Record<string, string | number>) => string, key: string, vars?: Record<string, string | number>): string {
  const v = t(key, vars);
  if (v === key && EN[key] !== undefined) return EN[key];
  return v;
}
