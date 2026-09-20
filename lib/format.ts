// Client-side display helpers. Server stores paisa as BigInt; APIs return strings.
/** Lenient string|number|bigint -> bigint (for SQL SUM results that may come back as numbers). */
export function toBig(v: string | number | bigint | null | undefined): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    return BigInt(String(v ?? "0").trim().split(".")[0] || "0");
  } catch {
    return 0n;
  }
}
export function fmtMoney(paisa: string | number | bigint): string {
  const n = typeof paisa === "bigint" ? paisa : BigInt(paisa);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const rupees = abs / 100n;
  const p = (abs % 100n).toString().padStart(2, "0");
  const grouped = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}Rs ${grouped}.${p}`;
}

export function fmtQty(milli: string | number | bigint, unit = ""): string {
  const n = typeof milli === "bigint" ? milli : BigInt(milli);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? "." + frac : ""}${unit ? " " + unit : ""}`;
}

export function fmtDate(ms: number | string): string {
  // APIs serialize Date objects as ISO strings; also accept ms numbers / numeric strings.
  const d =
    typeof ms === "string" && !/^-?\d+$/.test(ms.trim())
      ? new Date(ms)
      : new Date(typeof ms === "string" ? parseInt(ms, 10) : ms);
  return d.toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateInput(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (data as { code?: string }).code;
    if (code === "UPGRADE_REQUIRED" && typeof window !== "undefined") {
      // A PRO-only API blocked us (trial ended, no paid plan) — send the user to Billing.
      window.dispatchEvent(new CustomEvent("ledgerpro:upgrade-required"));
    }
    if (res.status === 401 && typeof window !== "undefined") {
      // Session is gone (logged out, or idle timeout) — fail closed to /login.
      // Skip on the auth pages themselves so bad-credential errors still show.
      const p = window.location.pathname;
      if (!p.startsWith("/login") && !p.startsWith("/signup") && !p.startsWith("/forgot-password")) {
        // Intentional full reload: clears all client state on session expiry.
        // api() is a plain helper, not a component, so useRouter() isn't available here.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/login";
      }
    }
    throw new ApiError((data as { error?: string }).error || "Something went wrong.", code);
  }
  return data as T;
}
