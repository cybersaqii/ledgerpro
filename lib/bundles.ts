import { eq, and, inArray } from "drizzle-orm";
import { bundleComponents, products } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";
import { parseQty } from "./qty";

type Dbx = Db | DbTx;

/**
 * Maximum bundle nesting depth when exploding. Cycles are rejected when
 * components are saved (assertNoBundleCycle), so this is a backstop against
 * pathological data, not the primary guard.
 */
export const MAX_BUNDLE_DEPTH = 8;

export type BundleComponent = {
  id: string;
  componentProductId: string;
  componentName: string;
  componentSku: string;
  componentUnit: string;
  /** Component units per one bundle unit, in thousandths (2500 = 2.5). */
  qtyThousandths: number;
};

/** All components of a bundle product. Empty array = not a bundle. */
export async function getBundleComponents(
  dbx: Dbx,
  companyId: string,
  bundleProductId: string
): Promise<BundleComponent[]> {
  const rows = await dbx
    .select({
      id: bundleComponents.id,
      componentProductId: bundleComponents.componentProductId,
      qtyThousandths: bundleComponents.qtyThousandths,
      name: products.name,
      sku: products.sku,
      unit: products.unit,
    })
    .from(bundleComponents)
    .innerJoin(products, eq(products.id, bundleComponents.componentProductId))
    .where(
      and(
        eq(bundleComponents.companyId, companyId),
        eq(bundleComponents.bundleProductId, bundleProductId)
      )
    );
  return rows.map((r) => ({
    id: r.id,
    componentProductId: r.componentProductId,
    componentName: r.name,
    componentSku: r.sku,
    componentUnit: r.unit,
    qtyThousandths: r.qtyThousandths,
  }));
}

/** Ids of every product in this company that is currently a bundle. */
export async function bundleProductIds(dbx: Dbx, companyId: string): Promise<Set<string>> {
  const rows = await dbx
    .select({ id: bundleComponents.bundleProductId })
    .from(bundleComponents)
    .where(eq(bundleComponents.companyId, companyId));
  return new Set(rows.map((r) => r.id));
}

export type BundleComponentInput = {
  productId: string;
  /** Component units per one bundle unit, up to 3 decimals ("2.5"). */
  qty: string;
};

/**
 * Replace a product's bundle components. An empty list turns it back into a
 * plain product. Nested bundles are allowed (a component may itself be a
 * bundle); cycles are rejected. A bundle may not contain itself.
 */
export async function setBundleComponents(
  dbx: Dbx,
  companyId: string,
  bundleProductId: string,
  inputs: BundleComponentInput[]
): Promise<void> {
  const [bundle] = await dbx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, bundleProductId), eq(products.companyId, companyId)))
    .limit(1);
  if (!bundle) throw new UserError("Product not found.");

  const seen = new Set<string>();
  const prepared: { componentProductId: string; qtyThousandths: number }[] = [];
  for (const inp of inputs) {
    const pid = inp.productId?.trim() ?? "";
    if (!pid) throw new UserError("Each bundle component needs a product.");
    if (pid === bundleProductId)
      throw new UserError("A bundle cannot contain itself as a component.");
    if (seen.has(pid)) throw new UserError("The same product is listed twice in this bundle.");
    seen.add(pid);
    let qtyT: number;
    try {
      const milli = parseQty(inp.qty); // milli-units per bundle unit == thousandths
      if (milli <= 0n || milli > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("bad qty");
      qtyT = Number(milli);
    } catch {
      throw new UserError("Component quantity must be a positive number with up to 3 decimals.");
    }
    prepared.push({ componentProductId: pid, qtyThousandths: qtyT });
  }

  if (prepared.length > 0) {
    const compRows = await dbx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          eq(products.isActive, true),
          inArray(products.id, [...seen])
        )
      );
    const found = new Set(compRows.map((r) => r.id));
    for (const p of prepared) {
      if (!found.has(p.componentProductId))
        throw new UserError("One of the bundle components is not an active product.");
    }
    await assertNoBundleCycle(dbx, companyId, bundleProductId, [...seen]);
  }

  await dbx
    .delete(bundleComponents)
    .where(
      and(
        eq(bundleComponents.companyId, companyId),
        eq(bundleComponents.bundleProductId, bundleProductId)
      )
    );
  if (prepared.length > 0) {
    await dbx.insert(bundleComponents).values(
      prepared.map((p) => ({
        id: crypto.randomUUID(),
        companyId,
        bundleProductId,
        componentProductId: p.componentProductId,
        qtyThousandths: p.qtyThousandths,
      }))
    );
  }
}

/**
 * Throw if saving these components under `bundleId` would create a bundle
 * cycle (the bundle reachable from one of its components, directly or
 * through nested bundles).
 */
export async function assertNoBundleCycle(
  dbx: Dbx,
  companyId: string,
  bundleId: string,
  componentIds: string[]
): Promise<void> {
  const rows = await dbx
    .select({
      bundle: bundleComponents.bundleProductId,
      comp: bundleComponents.componentProductId,
    })
    .from(bundleComponents)
    .where(eq(bundleComponents.companyId, companyId));
  const adj = new Map<string, string[]>();
  for (const r of rows) {
    const list = adj.get(r.bundle) ?? [];
    list.push(r.comp);
    adj.set(r.bundle, list);
  }
  // Simulate the new edges, then look for bundleId downstream of each component.
  const withNew = new Map(adj);
  withNew.set(bundleId, [...(withNew.get(bundleId) ?? []), ...componentIds]);
  const reaches = (from: string, target: string, visited: Set<string>): boolean => {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    for (const next of withNew.get(from) ?? []) {
      if (reaches(next, target, visited)) return true;
    }
    return false;
  };
  for (const c of componentIds) {
    if (reaches(c, bundleId, new Set())) {
      throw new UserError(
        "Bundle cycle detected: a bundle cannot contain itself, directly or through another bundle."
      );
    }
  }
}

/** Names of bundles (this company) that use the given product as a component. */
export async function bundlesUsingProduct(
  dbx: Dbx,
  companyId: string,
  productId: string
): Promise<string[]> {
  const rows = await dbx
    .select({ name: products.name })
    .from(bundleComponents)
    .innerJoin(products, eq(products.id, bundleComponents.bundleProductId))
    .where(
      and(
        eq(bundleComponents.companyId, companyId),
        eq(bundleComponents.componentProductId, productId)
      )
    );
  return rows.map((r) => r.name);
}

// ─── Explosion for sales posting ───────────────────────────────

export type SalesLineForStock = {
  productId: string | null;
  qtyMilli: bigint;
  trackStock: boolean;
  /** Explicit batch choice for plain lines. Dropped when a bundle explodes —
   *  component moves always use FIFO (see lib/batches). */
  batchId?: string | null;
};

export type ExplodedStockMove = {
  /** Always a leaf component product — never a bundle product itself. */
  productId: string;
  /** Signed component quantity in milli-units (negative = stock out). */
  qtyMilli: bigint;
  /** Batch choice, only ever set for non-exploded (plain) lines. */
  batchId: string | null;
};

/**
 * Build component-level stock moves for sales lines. Bundle lines explode
 * recursively into their components; plain lines (and bundles with zero
 * components) pass through unchanged. The bundle product itself never gets
 * a stock movement. Component moves respect each component's own
 * trackStock flag, matching how plain lines behave.
 */
export async function explodeSalesStockMoves(
  dbx: Dbx,
  companyId: string,
  lines: SalesLineForStock[],
  docType: "INVOICE" | "RETURN"
): Promise<ExplodedStockMove[]> {
  const sign = docType === "INVOICE" ? -1n : 1n;

  // Prefetch the whole bundle graph for the company (bundles are few) plus
  // trackStock flags for every product involved, to avoid N+1 queries.
  const allRows = await dbx
    .select({
      bundle: bundleComponents.bundleProductId,
      comp: bundleComponents.componentProductId,
      qtyThousandths: bundleComponents.qtyThousandths,
    })
    .from(bundleComponents)
    .where(eq(bundleComponents.companyId, companyId));
  const graph = new Map<string, { componentProductId: string; qtyThousandths: number }[]>();
  const involved = new Set<string>();
  for (const r of allRows) {
    const list = graph.get(r.bundle) ?? [];
    list.push({ componentProductId: r.comp, qtyThousandths: r.qtyThousandths });
    graph.set(r.bundle, list);
    involved.add(r.comp);
  }
  for (const l of lines) if (l.productId) involved.add(l.productId);
  const tsMap = new Map<string, boolean>();
  if (involved.size > 0) {
    const tsRows = await dbx
      .select({ id: products.id, trackStock: products.trackStock })
      .from(products)
      .where(inArray(products.id, [...involved]));
    for (const r of tsRows) tsMap.set(r.id, r.trackStock);
  }

  const out: ExplodedStockMove[] = [];
  for (const line of lines) {
    if (!line.productId || line.qtyMilli === 0n) continue;
    const leafMoves = expand(graph, tsMap, line.productId, line.qtyMilli, 0, new Set(), line.trackStock, line.batchId ?? null);
    for (const m of leafMoves) out.push({ productId: m.productId, qtyMilli: m.qtyMilli * sign, batchId: m.batchId });
  }
  return out;
}

function expand(
  graph: Map<string, { componentProductId: string; qtyThousandths: number }[]>,
  tsMap: Map<string, boolean>,
  productId: string,
  qtyMilli: bigint,
  depth: number,
  path: Set<string>,
  trackStock: boolean,
  batchId: string | null
): { productId: string; qtyMilli: bigint; batchId: string | null }[] {
  if (path.has(productId)) {
    // Backstop: cycles are rejected at save time, but never trust stored data.
    throw new UserError("Bundle cycle detected while posting. Please fix the bundle definition.");
  }
  const comps = graph.get(productId);
  if (!comps || comps.length === 0) {
    // Plain product (or a bundle with zero components): one move if tracked.
    // An explicit batch choice only survives on non-exploded lines.
    return trackStock ? [{ productId, qtyMilli, batchId }] : [];
  }
  if (depth >= MAX_BUNDLE_DEPTH) {
    throw new UserError(`Bundle nesting is too deep (max ${MAX_BUNDLE_DEPTH} levels).`);
  }
  const nextPath = new Set(path);
  nextPath.add(productId);
  const out: { productId: string; qtyMilli: bigint; batchId: string | null }[] = [];
  for (const c of comps) {
    // Quantities here are positive (validators reject negative line qtys);
    // half-up rounding keeps tiny fractional component qtys exact.
    const compQty = (qtyMilli * BigInt(c.qtyThousandths) + 500n) / 1000n;
    if (compQty <= 0n) continue;
    out.push(
      ...expand(
        graph,
        tsMap,
        c.componentProductId,
        compQty,
        depth + 1,
        nextPath,
        tsMap.get(c.componentProductId) ?? false,
        null // bundle explosion drops the line-level batch choice; components use FIFO
      )
    );
  }
  return out;
}
