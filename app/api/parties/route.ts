import { NextRequest } from "next/server";
import { eq, and, like, desc, sql } from "drizzle-orm";
import { parties } from "@/db/schema";
import { partySchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

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

  const rows = await db
    .select()
    .from(parties)
    .where(and(...conds))
    .orderBy(desc(parties.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(parties)
    .where(and(...conds));
  return json({ data: rows, total: total[0]?.n ?? 0, page, perPage });
}

// POST /api/parties
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = partySchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const p = parsed.data;

  const dup = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.companyId, companyId), eq(parties.kind, p.kind), eq(parties.name, p.name)))
    .limit(1);
  if (dup[0]) return err(`A ${p.kind === "CUSTOMER" ? "customer" : "supplier"} with this name already exists.`, 409);

  const id = crypto.randomUUID();
  await db.insert(parties).values({
    id,
    companyId,
    kind: p.kind,
    name: p.name,
    phone: p.phone || null,
    email: p.email || null,
    address: p.address || null,
    city: p.city || null,
    ntn: p.ntn || null,
    filerStatus: p.filerStatus,
    creditLimit: parseMoney(p.creditLimit),
    notes: p.notes || null,
  });
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "party.created", entity: "party", entityId: id,
    detail: `${p.kind === "CUSTOMER" ? "Customer" : "Supplier"} "${p.name}" created`,
  });
  const rows = await db.select().from(parties).where(eq(parties.id, id)).limit(1);
  return json({ data: rows[0] }, { status: 201 });
}
