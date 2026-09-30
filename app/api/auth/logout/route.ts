import { eq, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { db } from "@/lib/route-helpers";
import { getSession, destroySession } from "@/lib/auth";
import { json } from "@/lib/api";

export async function POST() {
  // H2 fix: bump tokenVersion so a stolen/copied JWT dies with the logout,
  // not 7 days later. Best effort — the cookie is always cleared.
  try {
    const session = await getSession();
    if (session?.uid) {
      await db
        .update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, session.uid));
    }
  } catch {
    /* logout must never fail because of this */
  }
  await destroySession();
  return json({ ok: true });
}
