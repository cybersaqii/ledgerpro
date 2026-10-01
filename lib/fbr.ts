/**
 * Module 7.1 — FBR POS & Digital Invoicing configuration, payload builder,
 * sync queue and QR data generator.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HARD RULE — NO LIVE FBR INTEGRATION.
 * This module builds the configuration UI, the outbound sync-queue table and
 * the invoice payload builder ONLY. The actual sync engine is DISABLED:
 * every queued payload stays at status DISABLED, fbrSyncStatus() reports
 * "Not connected — requires FBR credentials", and attemptFbrSync() refuses
 * to run. NOTHING in this file performs a network call to FBR (or anywhere
 * else). Never claim live sync works; never send real credentials anywhere.
 * ═══════════════════════════════════════════════════════════════════════
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { fbrPosConfig, fbrSyncQueue } from "@/db/schema";
import type { Db, DbTx } from "./db";

// ─── Pure: payload builder ───────────────────────────────────────

export type FbrInvoiceType = "New" | "Return";

export type FbrInvoiceItem = {
  /** Pakistan Customs Tariff / HS code (may be null when not maintained). */
  pctCode: string | null;
  description: string;
  /** Quantity in whole units (milli-units are rounded for the payload). */
  quantity: number;
  /** Net sale value (excl. sales tax), paisa. */
  saleValuePaisa: bigint;
  /** Sales tax charged on the line, paisa. */
  taxChargedPaisa: bigint;
  /** Line tax rate in basis points. */
  rateBps: number;
};

export type FbrInvoicePayload = {
  InvoiceNumber: string;
  POSID: string | null;
  DateTime: string; // ISO-8601
  InvoiceType: FbrInvoiceType;
  TotalSaleValue: string; // Rs, 2 decimals
  TotalTaxCharged: string; // Rs, 2 decimals
  TotalQuantity: number;
  Items: {
    PCTCode: string | null;
    Description: string;
    Quantity: number;
    SaleValue: string;
    TaxCharged: string;
    RateBps: number;
  }[];
};

/** Paisa bigint → "1234.56" Rs string. Pure. */
export function paisaToRs(paisa: bigint): string {
  const neg = paisa < 0n;
  const abs = neg ? -paisa : paisa;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** "1234.56" Rs string → paisa bigint. Exact for ≤2-decimal inputs. Pure. */
export function rsToPaisa(rs: string | null | undefined): bigint {
  const s = (rs ?? "").trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return 0n;
  const neg = s.startsWith("-");
  const [r, p = ""] = (neg ? s.slice(1) : s).split(".");
  return (BigInt(r || "0") * 100n + BigInt((p + "00").slice(0, 2))) * (neg ? -1n : 1n);
}

/** Build the FBR digital-invoice payload for a posted sales invoice/return.
 *  Pure — no DB, no network. */
export function buildFbrInvoicePayload(input: {
  invoiceNumber: string;
  posId: string | null;
  date: Date;
  invoiceType: FbrInvoiceType;
  items: FbrInvoiceItem[];
}): FbrInvoicePayload {
  const totalSale = input.items.reduce((a, i) => a + i.saleValuePaisa, 0n);
  const totalTax = input.items.reduce((a, i) => a + i.taxChargedPaisa, 0n);
  const totalQty = input.items.reduce((a, i) => a + i.quantity, 0);
  return {
    InvoiceNumber: input.invoiceNumber,
    POSID: input.posId,
    DateTime: input.date.toISOString(),
    InvoiceType: input.invoiceType,
    TotalSaleValue: paisaToRs(totalSale),
    TotalTaxCharged: paisaToRs(totalTax),
    TotalQuantity: totalQty,
    Items: input.items.map((i) => ({
      PCTCode: i.pctCode,
      Description: i.description,
      Quantity: i.quantity,
      SaleValue: paisaToRs(i.saleValuePaisa),
      TaxCharged: paisaToRs(i.taxChargedPaisa),
      RateBps: i.rateBps,
    })),
  };
}

/** QR code DATA for an FBR digital invoice (the string that gets encoded —
 *  rendering is done with the existing `qrcode` package by the caller).
 *  Format: FBR|<invoiceNumber>|NTN:<ntn>|DT:<yyyymmdd>|TOT:<rs>.
 *  Pure. */
export function buildFbrQrData(input: {
  fbrInvoiceNumber: string;
  ntn: string | null;
  date: Date;
  totalPaisa: bigint;
}): string {
  const d = input.date;
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const ntn = (input.ntn ?? "").trim() || "UNREGISTERED";
  return `FBR|${input.fbrInvoiceNumber}|NTN:${ntn}|DT:${ymd}|TOT:${paisaToRs(input.totalPaisa)}`;
}

// ─── Sync engine: DISABLED ───────────────────────────────────────

export const FBR_SYNC_DISABLED_REASON = "Not connected — requires FBR credentials";

export function fbrSyncStatus(): {
  connected: false;
  status: "NOT_CONNECTED";
  message: string;
} {
  return { connected: false, status: "NOT_CONNECTED", message: FBR_SYNC_DISABLED_REASON };
}

/**
 * The live sync engine does not exist. This stub refuses to run and performs
 * NO network I/O — it exists so the UI and any future wiring have one honest
 * choke point instead of scattered assumptions.
 */
export async function attemptFbrSync(): Promise<{
  ok: false;
  reason: "DISABLED";
  message: string;
}> {
  return { ok: false, reason: "DISABLED", message: FBR_SYNC_DISABLED_REASON };
}

// ─── Config storage ──────────────────────────────────────────────

export const fbrConfigSchema = z.object({
  posId: z.string().trim().max(40).optional().or(z.literal("")),
  environment: z.enum(["SANDBOX", "PRODUCTION"]),
  storeCode: z.string().trim().max(40).optional().or(z.literal("")),
  cashierId: z.string().trim().max(40).optional().or(z.literal("")),
  qrPlacement: z.enum(["TOP", "BOTTOM"]),
  /**
   * Bearer token / API secret. Write-only: stored as given, but the GET API
   * only ever returns { tokenSet, tokenLast4 }. Cleared by sending "".
   * TESTS MUST NEVER USE REAL CREDENTIALS.
   */
  tokenSecret: z.string().max(500).optional().or(z.literal("")),
});

export type FbrConfigInput = z.infer<typeof fbrConfigSchema>;

export type FbrConfigView = {
  posId: string;
  environment: "SANDBOX" | "PRODUCTION";
  storeCode: string;
  cashierId: string;
  qrPlacement: "TOP" | "BOTTOM";
  isEnabled: boolean;
  tokenSet: boolean;
  tokenLast4: string | null;
  sync: ReturnType<typeof fbrSyncStatus>;
};

const EMPTY_VIEW: FbrConfigView = {
  posId: "",
  environment: "SANDBOX",
  storeCode: "",
  cashierId: "",
  qrPlacement: "BOTTOM",
  isEnabled: false,
  tokenSet: false,
  tokenLast4: null,
  sync: fbrSyncStatus(),
};

/** Masked config view — the secret is never returned in full. */
export async function readFbrConfig(tx: Db | DbTx, companyId: string): Promise<FbrConfigView> {
  const rows = await tx
    .select()
    .from(fbrPosConfig)
    .where(eq(fbrPosConfig.companyId, companyId))
    .limit(1);
  const c = rows[0];
  if (!c) return { ...EMPTY_VIEW, sync: fbrSyncStatus() };
  const secret = c.tokenSecret ?? "";
  return {
    posId: c.posId ?? "",
    environment: c.environment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX",
    storeCode: c.storeCode ?? "",
    cashierId: c.cashierId ?? "",
    qrPlacement: c.qrPlacement === "TOP" ? "TOP" : "BOTTOM",
    isEnabled: c.isEnabled,
    tokenSet: secret.length > 0,
    tokenLast4: secret.length > 0 ? secret.slice(-4) : null,
    sync: fbrSyncStatus(),
  };
}

/** Raw config (incl. POSID) for the payload builder — server-side only. */
export async function readFbrPosId(tx: Db | DbTx, companyId: string): Promise<string | null> {
  const rows = await tx
    .select({ posId: fbrPosConfig.posId })
    .from(fbrPosConfig)
    .where(eq(fbrPosConfig.companyId, companyId))
    .limit(1);
  return rows[0]?.posId?.trim() ? rows[0].posId!.trim() : null;
}

export async function writeFbrConfig(
  tx: Db | DbTx,
  companyId: string,
  input: FbrConfigInput
): Promise<FbrConfigView> {
  const rows = await tx
    .select({ id: fbrPosConfig.id, tokenSecret: fbrPosConfig.tokenSecret })
    .from(fbrPosConfig)
    .where(eq(fbrPosConfig.companyId, companyId))
    .limit(1);
  const existing = rows[0];
  // Empty string = clear the secret; undefined = leave it untouched.
  const nextSecret =
    input.tokenSecret === undefined
      ? (existing?.tokenSecret ?? null)
      : input.tokenSecret.trim() === ""
        ? null
        : input.tokenSecret;
  const values = {
    posId: input.posId?.trim() || null,
    tokenSecret: nextSecret,
    environment: input.environment,
    storeCode: input.storeCode?.trim() || null,
    cashierId: input.cashierId?.trim() || null,
    qrPlacement: input.qrPlacement,
    updatedAt: new Date(),
  };
  if (existing) {
    await tx.update(fbrPosConfig).set(values).where(eq(fbrPosConfig.id, existing.id));
  } else {
    await tx.insert(fbrPosConfig).values({
      id: crypto.randomUUID(),
      companyId,
      ...values,
      createdAt: new Date(),
    });
  }
  return readFbrConfig(tx, companyId);
}

// ─── Queue ───────────────────────────────────────────────────────

/**
 * Enqueue a posted sales invoice/return for FBR digital-invoice sync.
 * The payload is built and stored, but status is ALWAYS "DISABLED" — there
 * is no live sync engine (see the HARD RULE above).
 */
export async function queueFbrInvoice(
  tx: DbTx,
  opts: {
    companyId: string;
    docType: "SALES_INVOICE" | "SALES_RETURN";
    docId: string;
    docNo: string;
    date: Date;
    posId: string | null;
    items: FbrInvoiceItem[];
  }
): Promise<string> {
  const payload = buildFbrInvoicePayload({
    invoiceNumber: opts.docNo,
    posId: opts.posId,
    date: opts.date,
    invoiceType: opts.docType === "SALES_RETURN" ? "Return" : "New",
    items: opts.items,
  });
  const id = crypto.randomUUID();
  await tx.insert(fbrSyncQueue).values({
    id,
    companyId: opts.companyId,
    docType: opts.docType,
    docId: opts.docId,
    invoiceNumber: opts.docNo,
    payloadJson: JSON.stringify(payload),
    status: "DISABLED",
    attempts: 0,
    error: FBR_SYNC_DISABLED_REASON,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}
