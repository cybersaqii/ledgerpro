// CSV export helper — builds a Blob and triggers a download in the browser.
// Amounts arrive as paisa strings; callers format them before passing rows.

export function toCsv(rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const blob = new Blob(["\uFEFF" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Rs display for a paisa bigint/string/number, without currency symbol (Excel-friendly). */
export function csvMoney(paisa: bigint | string | number): string {
  const v = typeof paisa === "bigint" ? paisa : BigInt(paisa || 0);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}

// ─── Server-side CSV builders (pure — safe in API routes) ────────────
// The export route used to carry its own copies of these; keep one.

/** Escape a single CSV cell (quotes when it contains , " or a newline). */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** headers + rows → CRLF-joined CSV text. */
export function rowsToCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");
}

/** Milli-quantity → "12.5" style string. */
export function csvQty(milli: bigint | number | string | null | undefined): string {
  if (milli === null || milli === undefined) return "";
  const n = typeof milli === "bigint" ? milli : BigInt(milli);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

/** Date | epoch | ISO string → "YYYY-MM-DD". */
export function csvDate(v: Date | number | string | null | undefined): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(typeof v === "string" && !/^\d+$/.test(v) ? v : Number(v));
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
