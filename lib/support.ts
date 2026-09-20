import { desc, eq } from "drizzle-orm";
import { supportRequests } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";

export const SUPPORT_SETTING_KEYS = [
  "support.email",
  "support.phone",
  "support.hours",
] as const;

export const SUPPORT_DEFAULTS: Record<string, string> = {
  "support.email": "support@ledgerpro.app",
  "support.phone": "",
  "support.hours": "Mon–Sat, 9am–6pm PKT",
};

export interface SupportInput {
  name: string;
  email: string;
  subject: string;
  message: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Validate the public support form. Throws UserError (safe message) on bad input. */
export function validateSupportInput(input: Partial<SupportInput>): SupportInput {
  const name = String(input.name ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  const subject = String(input.subject ?? "").trim();
  const message = String(input.message ?? "").trim();
  if (name.length < 2 || name.length > 80) throw new UserError("Please enter your name.", 422);
  if (!EMAIL_RE.test(email) || email.length > 120) throw new UserError("Please enter a valid email address.", 422);
  if (subject.length < 3 || subject.length > 120) throw new UserError("Please enter a short subject.", 422);
  if (message.length < 10 || message.length > 4000) throw new UserError("Please describe your issue (10–4000 characters).", 422);
  return { name, email, subject, message };
}

/** Persist a support request. Returns the new row id. */
export async function createSupportRequest(dbc: Db | DbTx, input: SupportInput): Promise<string> {
  const id = crypto.randomUUID();
  await dbc.insert(supportRequests).values({
    id,
    name: input.name,
    email: input.email,
    subject: input.subject,
    message: input.message,
    status: "OPEN",
    createdAt: new Date(),
  });
  return id;
}

export type SupportRequestRow = typeof supportRequests.$inferSelect;

/** Newest-first list for the platform-admin view. */
export async function listSupportRequests(
  dbc: Db | DbTx,
  status: "OPEN" | "RESOLVED" | "ALL" = "OPEN",
  limit = 100
): Promise<SupportRequestRow[]> {
  const q = dbc.select().from(supportRequests).orderBy(desc(supportRequests.createdAt)).limit(limit);
  if (status === "ALL") return q;
  return q.where(eq(supportRequests.status, status));
}

/** Mark a request OPEN or RESOLVED. Returns false when the id does not exist. */
export async function setSupportRequestStatus(
  dbc: Db | DbTx,
  id: string,
  status: "OPEN" | "RESOLVED"
): Promise<boolean> {
  const rows = await dbc
    .select({ id: supportRequests.id })
    .from(supportRequests)
    .where(eq(supportRequests.id, id))
    .limit(1);
  if (!rows[0]) return false;
  await dbc.update(supportRequests).set({ status }).where(eq(supportRequests.id, id));
  return true;
}
