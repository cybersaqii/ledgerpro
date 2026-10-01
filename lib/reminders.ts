/**
 * Module 15.1 — Automated payment reminders.
 *
 * Trigger rules per company (reminder_rules):
 *   BEFORE_DUE  offset -3 : friendly heads-up, 3 days before due
 *   DUE_DATE    offset  0 : reminder on the due date
 *   OVERDUE     offset +7 : urgent, 7 days overdue (with payment link)
 *   OVERDUE     offset +15: urgent, 15 days overdue (with payment link)
 *
 * Channels: EMAIL (via lib/email.ts, Resend — graceful skip when the key is
 * missing) and WHATSAPP (no API key: queued in whatsapp_queue as a trackable
 * wa.me deep link; a human clicks "Open in WhatsApp" in the UI).
 *
 * Every reminder also drops an in-app notification row.
 *
 * Idempotency: reminder_log has UNIQUE(company_id, invoice_id, rule_id,
 * trigger_date). The engine inserts first and treats a unique-violation as
 * "already dispatched" — running twice a day never double-sends.
 *
 * Money: integer paisa everywhere. Formatting only at the message boundary.
 */

import { and, eq, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import {
  companies,
  notifications,
  parties,
  reminderLog,
  reminderRules,
  salesDocs,
  whatsappQueue,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { sendEmail, brandEmailHeader } from "./email";
import { waPhone, waLink } from "./whatsapp";
import { formatMoney } from "./money";
import { fmtDate } from "./format";

export type ReminderKind = "BEFORE_DUE" | "DUE_DATE" | "OVERDUE";
export type ReminderChannel = "EMAIL" | "WHATSAPP" | "BOTH";

export interface ReminderRule {
  id: string;
  companyId: string;
  name: string;
  ruleKind: ReminderKind;
  daysOffset: number;
  channel: ReminderChannel;
  template: string | null;
  enabled: boolean;
}

export const DEFAULT_REMINDER_RULES: Array<{
  name: string;
  ruleKind: ReminderKind;
  daysOffset: number;
  channel: ReminderChannel;
}> = [
  { name: "3 days before due (friendly)", ruleKind: "BEFORE_DUE", daysOffset: -3, channel: "BOTH" },
  { name: "On due date (reminder)", ruleKind: "DUE_DATE", daysOffset: 0, channel: "BOTH" },
  { name: "7 days overdue (urgent)", ruleKind: "OVERDUE", daysOffset: 7, channel: "BOTH" },
  { name: "15 days overdue (urgent)", ruleKind: "OVERDUE", daysOffset: 15, channel: "BOTH" },
];

const VALID_KINDS: ReminderKind[] = ["BEFORE_DUE", "DUE_DATE", "OVERDUE"];
const VALID_CHANNELS: ReminderChannel[] = ["EMAIL", "WHATSAPP", "BOTH"];

export function isReminderKind(v: string): v is ReminderKind {
  return (VALID_KINDS as string[]).includes(v);
}
export function isReminderChannel(v: string): v is ReminderChannel {
  return (VALID_CHANNELS as string[]).includes(v);
}

/** Built-in templates. Placeholders: {{business_name}} {{party_name}}
 *  {{invoice_no}} {{amount_due}} {{due_date}} {{days_overdue}} {{payment_link}} */
export function defaultTemplate(kind: ReminderKind): string {
  switch (kind) {
    case "BEFORE_DUE":
      return (
        "Assalam-o-Alaikum {{party_name}},\n" +
        "Friendly reminder from *{{business_name}}*: invoice {{invoice_no}} of *{{amount_due}}* " +
        "is due on {{due_date}} (in 3 days). Please pay on time to avoid any inconvenience. Shukriya!"
      );
    case "DUE_DATE":
      return (
        "Assalam-o-Alaikum {{party_name}},\n" +
        "This is a reminder from *{{business_name}}*: invoice {{invoice_no}} of *{{amount_due}}* " +
        "is due *today* ({{due_date}}). Barah-e-karam jald adaigi farma dein. Shukriya!"
      );
    case "OVERDUE":
      return (
        "Assalam-o-Alaikum {{party_name}},\n" +
        "*{{business_name}}* se URGENT yaad-dihani: invoice {{invoice_no}} of *{{amount_due}}* " +
        "is {{days_overdue}} days overdue (due {{due_date}}). Kindly clear it today: {{payment_link}}. Shukriya!"
      );
  }
}

export interface TemplateVars {
  business_name: string;
  party_name: string;
  invoice_no: string;
  amount_due: string;
  due_date: string;
  days_overdue: number;
  payment_link: string;
}

/** Render a template string, replacing {{placeholders}}. Unknown placeholders
 *  are left as-is so a typo is visible instead of silently dropping text. */
export function renderReminderTemplate(template: string, vars: TemplateVars): string {
  const map: Record<string, string> = {
    business_name: vars.business_name,
    party_name: vars.party_name,
    invoice_no: vars.invoice_no,
    amount_due: vars.amount_due,
    due_date: vars.due_date,
    days_overdue: String(vars.days_overdue),
    payment_link: vars.payment_link,
  };
  return template.replace(/\{\{([a-z_]+)\}\}/g, (m, key: string) =>
    key in map ? map[key] : m
  );
}

/** UTC YYYY-MM-DD of a Date. */
export function toTriggerDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole days from due date to asOf: negative = before due, positive = overdue. */
export function daysPastDue(dueDate: Date, asOf: Date): number {
  const due = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const now = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.round((now - due) / 86400000);
}

/** Seed the 4 default rules when a company has none. Idempotent. */
export async function ensureDefaultReminderRules(
  dbx: Db | DbTx,
  companyId: string
): Promise<ReminderRule[]> {
  const existing = await dbx
    .select()
    .from(reminderRules)
    .where(eq(reminderRules.companyId, companyId));
  if (existing.length > 0) return existing.map(toRule);
  const rows = DEFAULT_REMINDER_RULES.map((r) => ({
    id: crypto.randomUUID(),
    companyId,
    name: r.name,
    ruleKind: r.ruleKind,
    daysOffset: r.daysOffset,
    channel: r.channel,
  }));
  await dbx.insert(reminderRules).values(rows);
  return (await dbx.select().from(reminderRules).where(eq(reminderRules.companyId, companyId))).map(toRule);
}

function toRule(r: typeof reminderRules.$inferSelect): ReminderRule {
  return {
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    ruleKind: isReminderKind(r.ruleKind) ? r.ruleKind : "DUE_DATE",
    daysOffset: r.daysOffset,
    channel: isReminderChannel(r.channel) ? r.channel : "BOTH",
    template: r.template,
    enabled: r.enabled,
  };
}

export interface OpenInvoice {
  id: string;
  docNo: string;
  dueDate: Date;
  balancePaisa: bigint;
  partyId: string;
  partyName: string;
  partyEmail: string | null;
  partyPhone: string | null;
}

/** Unpaid/partially-paid posted INVOICEs with a due date. Tenant-scoped. */
export async function findOpenInvoices(
  dbx: Db | DbTx,
  companyId: string
): Promise<OpenInvoice[]> {
  const rows = await dbx
    .select({
      id: salesDocs.id,
      docNo: salesDocs.docNo,
      dueDate: salesDocs.dueDate,
      grandTotal: salesDocs.grandTotal,
      amountPaid: salesDocs.amountPaid,
      returnedTotal: salesDocs.returnedTotal,
      writtenOff: salesDocs.writtenOffAmount,
      partyId: salesDocs.partyId,
      partyName: parties.name,
      partyEmail: parties.email,
      partyPhone: parties.phone,
    })
    .from(salesDocs)
    .innerJoin(parties, eq(parties.id, salesDocs.partyId))
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.docType, "INVOICE"),
        notInArray(salesDocs.status, ["DRAFT", "VOIDED", "PENDING_APPROVAL"]),
        isNotNull(salesDocs.dueDate),
        ne(salesDocs.status, "PAID"),
        // collectible balance > 0 (all integer paisa)
        sql`(COALESCE(${salesDocs.grandTotal}, 0) - COALESCE(${salesDocs.amountPaid}, 0) - COALESCE(${salesDocs.returnedTotal}, 0) - COALESCE(${salesDocs.writtenOffAmount}, 0)) > 0`
      )
    );
  return rows
    .map((r) => {
      const balance =
        BigInt(r.grandTotal ?? 0n) -
        BigInt(r.amountPaid ?? 0n) -
        BigInt(r.returnedTotal ?? 0n) -
        BigInt(r.writtenOff ?? 0n);
      return {
        id: r.id,
        docNo: r.docNo,
        dueDate: r.dueDate as Date,
        balancePaisa: balance,
        partyId: r.partyId,
        partyName: r.partyName,
        partyEmail: r.partyEmail,
        partyPhone: r.partyPhone,
      };
    })
    .filter((r) => r.balancePaisa > 0n && r.dueDate);
}

export interface RunRemindersOptions {
  companyId: string;
  asOf?: Date;
  /** When true, match rules and log nothing / send nothing. */
  dryRun?: boolean;
  /** Public base URL for the payment link (defaults to relative). */
  baseUrl?: string;
}

export interface RunRemindersResult {
  scanned: number;
  matched: number;
  dispatched: number;
  duplicates: number;
  emailSent: number;
  emailSkipped: number;
  whatsappQueued: number;
  failures: Array<{ invoiceId: string; ruleId: string; error: string }>;
}

/**
 * The reminder run engine. Finds open invoices whose days-past-due matches an
 * enabled rule's offset, claims the (company, invoice, rule, trigger_date)
 * idempotency slot, then dispatches email + WhatsApp queue + in-app
 * notification for each newly claimed slot.
 */
export async function runPaymentReminders(
  dbx: Db | DbTx,
  opts: RunRemindersOptions
): Promise<RunRemindersResult> {
  const { companyId } = opts;
  const asOf = opts.asOf ?? new Date();
  const triggerDate = toTriggerDate(asOf);
  const dryRun = opts.dryRun === true;
  const result: RunRemindersResult = {
    scanned: 0, matched: 0, dispatched: 0, duplicates: 0,
    emailSent: 0, emailSkipped: 0, whatsappQueued: 0, failures: [],
  };

  const [company] = await dbx
    .select({ name: companies.name, tradeName: companies.tradeName, email: companies.email })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  // The companies row always exists in production; fall back gracefully so a
  // missing row can never silently disable reminders.
  const businessName = company?.tradeName || company?.name || "Your business";

  const rules = (await ensureDefaultReminderRules(dbx, companyId)).filter((r) => r.enabled);
  if (rules.length === 0) return result;

  const invoices = await findOpenInvoices(dbx, companyId);
  result.scanned = invoices.length;

  for (const inv of invoices) {
    const overdue = daysPastDue(inv.dueDate, asOf);
    for (const rule of rules) {
      if (rule.daysOffset !== overdue) continue;
      result.matched++;
      try {
        if (dryRun) continue;
        // Claim the idempotency slot. ON CONFLICT DO NOTHING — an existing
        // row means this invoice+rule already fired today.
        const claimed = await dbx
          .insert(reminderLog)
          .values({
            id: crypto.randomUUID(),
            companyId,
            invoiceId: inv.id,
            ruleId: rule.id,
            triggerDate,
            status: "SENT",
          })
          .onConflictDoNothing({ target: [reminderLog.companyId, reminderLog.invoiceId, reminderLog.ruleId, reminderLog.triggerDate] })
          .returning({ id: reminderLog.id });
        if (claimed.length === 0) {
          result.duplicates++;
          continue;
        }
        const logId = claimed[0].id;

        const vars: TemplateVars = {
          business_name: businessName,
          party_name: inv.partyName,
          invoice_no: inv.docNo,
          amount_due: formatMoney(inv.balancePaisa, "Rs "),
          due_date: fmtDate(inv.dueDate.getTime()),
          days_overdue: Math.max(0, overdue),
          payment_link: opts.baseUrl
            ? `${opts.baseUrl.replace(/\/$/, "")}/pay/${inv.id}`
            : `/payments/new?kind=RECEIPT&party=${inv.partyId}`,
        };
        const message = renderReminderTemplate(rule.template ?? defaultTemplate(rule.ruleKind), vars);

        const wantsEmail = rule.channel === "EMAIL" || rule.channel === "BOTH";
        const wantsWa = rule.channel === "WHATSAPP" || rule.channel === "BOTH";
        let emailSent = false;
        let emailSkipped = false;
        let waQueued = false;

        if (wantsEmail) {
          if (inv.partyEmail) {
            const subject = `${businessName}: payment reminder — invoice ${inv.docNo}`;
            const html =
              brandEmailHeader() +
              `<div style="font-family:sans-serif;padding:24px;">` +
              `<p>Assalam-o-Alaikum ${escapeHtml(inv.partyName)},</p>` +
              `<p>${escapeHtml(message)}</p>` +
              `<p style="color:#6b7280;font-size:12px;">— ${escapeHtml(businessName)}</p></div>`;
            const sent = await sendEmail({ to: inv.partyEmail, subject, html, text: message });
            if (sent.ok) emailSent = true;
            else emailSkipped = true; // graceful skip: key missing or provider error
          } else {
            emailSkipped = true;
          }
        }

        let waQueueId: string | null = null;
        if (wantsWa) {
          const intl = waPhone(inv.partyPhone);
          const link = waLink(inv.partyPhone, message);
          const [row] = await dbx
            .insert(whatsappQueue)
            .values({
              id: crypto.randomUUID(),
              companyId,
              phone: inv.partyPhone,
              intlPhone: intl || null,
              message,
              waLink: link,
              status: "QUEUED",
              invoiceId: inv.id,
              reminderLogId: logId,
            })
            .returning({ id: whatsappQueue.id });
          waQueueId = row.id;
          waQueued = true;
        }

        await dbx
          .update(reminderLog)
          .set({
            emailAttempted: wantsEmail,
            emailSent,
            emailSkipped,
            whatsappQueued: waQueued,
            status: emailSent || waQueued ? "SENT" : emailSkipped && !waQueued ? "SKIPPED" : "PARTIAL",
            detail:
              `email:${emailSent ? "sent" : emailSkipped ? "skipped" : "n/a"} ` +
              `whatsapp:${waQueueId ? "queued" : "n/a"}`,
          })
          .where(eq(reminderLog.id, logId));

        // In-app notification for every dispatched reminder.
        await dbx.insert(notifications).values({
          id: crypto.randomUUID(),
          companyId,
          userId: null,
          kind: "REMINDER",
          title: `Payment reminder — ${inv.docNo}`,
          body: message.slice(0, 280),
          link: `/sales/${inv.id}`,
          entityType: "invoice",
          entityId: inv.id,
        });

        result.dispatched++;
        if (emailSent) result.emailSent++;
        if (emailSkipped && wantsEmail) result.emailSkipped++;
        if (waQueued) result.whatsappQueued++;
      } catch (e) {
        result.failures.push({
          invoiceId: inv.id,
          ruleId: rule.id,
          error: e instanceof Error ? e.message.slice(0, 200) : "Unknown error",
        });
      }
    }
  }
  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
