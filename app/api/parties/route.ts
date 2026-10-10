import { NextRequest } from "next/server";
import { eq, and, like, desc, sql } from "drizzle-orm";
import { parties, priceLists } from "@/db/schema";

import { partySchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, db, requirePermission, parseDateOnly } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { insertParty } from "@/lib/party-create";
import { periodLockError } from "@/lib/period";
import {
  extractIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

// GET /api/parties?kind=CUSTOMER&q=ahmad&page=1
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind");
  const q = sp.get("q")?.trim() ?? "";
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "30", 10)));

  const conds = [eq(parties.companyId, companyId), eq(parties.isActive, true)];
  if (kind === "CUSTOMER" || kind === "SUPPLIER") conds.push(eq(parties.kind, kind));
  if (q) conds.push(like(parties.name, `%${q}%`));
  const category = sp.get("category")?.trim();
  if (category) conds.push(eq(parties.category, category));

  const rows = await db
    .select()
    .from(parties)
    .where(and(...conds))
    // Walk-in / counter cash customers float to the top of dropdowns.
    .orderBy(sql`case when lower(${parties.name}) like '%walk%' then 0 else 1 end`, desc(parties.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(parties)
    .where(and(...conds));
  return json({ data: rows, total: total[0]?.n ?? 0, page, perPage });
}

// POST /api/parties — Module 1: idempotent create with optional opening
// balance (posted Dr AR / Cr Opening Equity for customers, mirrored for
// suppliers) on the opening date.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("parties");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = partySchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const p = parsed.data;

  // Module 22: a party's price list must belong to this company (or be empty).
  let priceListId: string | null = null;
  if (p.priceListId) {
    const [pl] = await db
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(and(eq(priceLists.id, p.priceListId), eq(priceLists.companyId, companyId)))
      .limit(1);
    if (!pl) return err("The selected price list is invalid.", 422, "VALIDATION_ERROR");
    priceListId = pl.id;
  }

  // Idempotency: a retry of the same submission (same key) returns the
  // already-created party with 200 instead of double-creating.
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/parties", companyId });
  }
  if (idemKey) {
    const hit = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.companyId, companyId), eq(parties.idempotencyKey, idemKey)))
      .limit(1);
    if (hit[0]) {
      const rows = await db.select().from(parties).where(eq(parties.id, hit[0].id)).limit(1);
      return json({ data: rows[0], idempotentReplay: true }, { status: 200 });
    }
  }

  const dup = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.companyId, companyId), eq(parties.kind, p.kind), eq(parties.name, p.name)))
    .limit(1);
  if (dup[0]) return err(`A ${p.kind === "CUSTOMER" ? "customer" : "supplier"} with this name already exists.`, 409, "DUPLICATE");

  const opening = parseMoney(p.openingBalance || "0");
  if (opening < 0n) return err("Opening balance cannot be negative.", 422, "VALIDATION_ERROR");
  let openingDate: Date | null = null;
  if (opening > 0n) {
    // Module 1: opening balance needs an explicit opening date, and it must
    // not fall in a locked period.
    if (!p.openingBalanceDate) return err("Opening balance needs an opening date.", 422, "VALIDATION_ERROR");
    try {
      openingDate = parseDateOnly(p.openingBalanceDate);
    } catch (e) {
      return toApiError(e, { route: "/api/parties", companyId });
    }
    const lockErr = await periodLockError(db, companyId, openingDate);
    if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");
  }

  const rl = await throttleMoneyCreate(db, "parties", session.uid, companyId);
  if (!rl.ok) return err("Too many requests. Please wait a moment and try again.", 429, "RATE_LIMITED");

  let id: string;
  try {
    // insertParty runs the whole create + opening journal in one transaction.
    ({ id } = await db.transaction((tx) =>
      insertParty(tx, {
        companyId,
        userId: session.uid,
        fields: {
          kind: p.kind,
          name: p.name,
          phone: p.phone || null,
          email: p.email || null,
          address: p.address || null,
          city: p.city || null,
          ntn: p.ntn || null,
          customerType: p.customerType,
          currency: p.currency || null,
          strn: p.strn || null,
          openingBalance: opening,
          openingBalanceDate: openingDate,
          paymentTerms: p.paymentTerms || null,
          shippingAddress: p.shippingAddress || null,
          shippingCity: p.shippingCity || null,
          filerStatus: p.filerStatus,
          // Module 2.1: supplier master completeness
          displayName: p.displayName || null,
          whtCategory: p.whtCategory,
          activeTaxPayer: p.activeTaxPayer,
          bankIban: p.bankIban || null,
          bankAccountNo: p.bankAccountNo || null,
          creditLimit: parseMoney(p.creditLimit || "0"),
          category: p.category || null,
          priceListId,
          notes: p.notes || null,
          ...(idemKey ? { idempotencyKey: idemKey } : {}),
        },
      })
    ));
  } catch (e) {
    // Lost the idempotency race: a concurrent request already created the
    // party for this key — return it with 200 instead of an error.
    if (idemKey && isIdempotencyConflict(e)) {
      const hit = await db
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.companyId, companyId), eq(parties.idempotencyKey, idemKey)))
        .limit(1);
      if (hit[0]) {
        const rows = await db.select().from(parties).where(eq(parties.id, hit[0].id)).limit(1);
        return json({ data: rows[0], idempotentReplay: true }, { status: 200 });
      }
    }
    throw e;
  }
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "party.created", entity: "party", entityId: id,
    detail: `${p.kind === "CUSTOMER" ? "Customer" : "Supplier"} "${p.name}" created`,
  });
  const rows = await db.select().from(parties).where(eq(parties.id, id)).limit(1);
  return json({ data: rows[0] }, { status: 201 });
}
