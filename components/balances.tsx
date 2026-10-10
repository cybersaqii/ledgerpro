"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { Phone, Plus, Hourglass, ChevronDown, MessageCircle, OctagonX, CircleCheck } from "lucide-react";
import { PageHeader, EmptyState, ExportCsv, SummaryChips, ErrorNote } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { api, fmtMoney, fmtMoneyShortRs, fmtDate } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";
import { waLink, waPhone, reminderText } from "@/lib/whatsapp";
import { creditUtilization } from "@/lib/credit-limit";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

type Row = {
  id: string; name: string; phone: string | null; city: string | null;
  balance: string; creditLimit: string;
  creditStatus: "OK" | "HOLD"; creditHoldReason: string | null; riskCategory: "LOW" | "MEDIUM" | "HIGH";
};

export function BalancesPage({ kind }: { kind: "CUSTOMER" | "SUPPLIER" }) {
  const { t } = useLang();
  const bp = useBusinessProfile();
  const { permissions, role } = usePermissions();
  const isCustomer = kind === "CUSTOMER";
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState("0");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"list" | "aging">("list");
  const [holdError, setHoldError] = useState<string | null>(null);
  const canHold = role === "OWNER" || permissions.includes("parties");

  const load = () => {
    setLoading(true);
    api<{ data: Row[]; total: string }>(`/api/reports/party-balances?kind=${kind}`)
      .then((d) => { setRows(d.data); setTotal(d.total); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  /* eslint-disable react-hooks/set-state-in-effect -- intentional: fetch balances on kind change */
  useEffect(load, [kind]);

  /** Module 23: manual hold / release with an audit-logged reason. */
  async function toggleHold(r: Row) {
    setHoldError(null);
    const releasing = r.creditStatus === "HOLD";
    const reason = window.prompt(
      t(releasing ? "balances.releaseHoldPrompt" : "balances.holdPrompt", { party: r.name })
    );
    if (reason === null) return; // cancelled
    if (reason.trim().length < 3) { setHoldError(t("balances.holdReasonShort")); return; }
    try {
      await api(`/api/parties/${r.id}/hold`, {
        method: releasing ? "DELETE" : "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      load();
    } catch (e) {
      setHoldError(e instanceof Error ? e.message : t("balances.holdFailed"));
    }
  }

  return (
    <div>
      <PageHeader
        title={isCustomer ? bp.receivables : t("balances.payables")}
        subtitle={<>{t("balances.outstanding")} <span className="font-extrabold text-primary">{fmtMoney(total)}</span></>}
        actions={<>
          <ExportCsv filename={isCustomer ? "receivables" : "payables"} disabled={loading || rows.length === 0} rows={() => [
            [t("balances.csvParty"), t("balances.csvPhone"), t("balances.csvCity"), t("balances.csvBalance"), t("balances.csvLimit"), t("balances.csvRisk"), t("balances.csvStatus")],
            ...rows.map((r) => [r.name, r.phone ?? "", r.city ?? "", csvMoney(r.balance), BigInt(r.creditLimit) > 0n ? csvMoney(r.creditLimit) : "", r.riskCategory, r.creditStatus]),
            [t("balances.csvTotal"), "", "", csvMoney(total), "", "", ""],
          ]} />
          <Link href={`/payments/new?kind=${isCustomer ? "RECEIPT" : "PAYMENT"}`} className="btn btn-primary text-sm">
            <Plus size={16} /> {isCustomer ? t("balances.receivePayment") : t("balances.paySupplier")}
          </Link>
        </>}
      />
      <div className="mb-4 flex gap-2">
        {(["list", "aging"] as const).map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`btn text-sm ${tab === tb ? "btn-primary" : "btn-ghost"}`}
          >
            {tb === "aging" && <Hourglass size={15} />}
            {tb === "list" ? t("balances.tabBalances") : t("balances.tabAging")}
          </button>
        ))}
      </div>
      {tab === "aging" ? (
        <AgingView kind={kind} />
      ) : (
      <>
      {holdError && <div className="mb-3"><ErrorNote message={holdError} /></div>}
      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={isCustomer ? t("balances.emptyCustTitle") : t("balances.emptySuppTitle")} hint={t("balances.emptyHint")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("balances.colParty")}</th><th>{t("balances.colPhone")}</th><th>{t("balances.colCity")}</th><th className="num">{t("balances.colBalance")}</th><th>{t("balances.colLimit")}</th>{isCustomer && <th>{t("balances.colRisk")}</th>}<th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.creditStatus === "HOLD" ? "!bg-danger/[0.05]" : ""}>
                    <td>
                      <span className="font-bold">{r.name}</span>
                      {r.creditStatus === "HOLD" && (
                        <span className="badge ms-2 !bg-danger-soft !text-danger !text-[10px]" title={r.creditHoldReason ?? ""}>
                          {t("balances.holdBadge")}
                        </span>
                      )}
                    </td>
                    <td className="text-muted-foreground">{r.phone ? <span className="inline-flex items-center gap-1.5"><Phone size={13} />{r.phone}</span> : "—"}</td>
                    <td className="text-muted-foreground">{r.city ?? "—"}</td>
                    <td className="num font-extrabold text-accent">{fmtMoney(r.balance)}</td>
                    <td><LimitCell balance={r.balance} limit={r.creditLimit} /></td>
                    {isCustomer && <td><RiskCell risk={r.riskCategory} /></td>}
                    <td className="text-end">
                      <div className="flex items-center justify-end gap-1">
                        {isCustomer && canHold && (
                          <button
                            className={`btn btn-ghost !px-2 !py-1 text-xs ${r.creditStatus === "HOLD" ? "!text-primary" : "!text-danger"}`}
                            title={r.creditStatus === "HOLD" ? t("balances.releaseHoldTitle") : t("balances.holdTitle")}
                            onClick={() => toggleHold(r)}
                          >
                            {r.creditStatus === "HOLD" ? <CircleCheck size={14} /> : <OctagonX size={14} />}
                            <span className="hidden sm:inline">{r.creditStatus === "HOLD" ? t("balances.release") : t("balances.hold")}</span>
                          </button>
                        )}
                        <Link href={`/reports/party-ledger?party=${r.id}`} className="text-sm font-bold text-primary hover:underline">{t("balances.ledger")}</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border">
                  <td colSpan={3} className="!py-3 font-extrabold">{t("balances.total")}</td>
                  <td className="num !py-3 font-extrabold">{fmtMoney(total)}</td>
                  <td colSpan={isCustomer ? 3 : 2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}

/** Module 23: risk-category badge for the balances list. */
function RiskCell({ risk }: { risk: "LOW" | "MEDIUM" | "HIGH" }) {
  const { t } = useLang();
  const tone =
    risk === "HIGH" ? "!bg-danger-soft !text-danger" :
    risk === "MEDIUM" ? "!bg-accent-soft !text-accent" :
    "!bg-muted !text-muted-foreground";
  return <span className={`badge !text-[10px] ${tone}`}>{t(`balances.risk${risk}`)}</span>;
}

/** Credit-limit utilization bar for the balances list (— when unlimited). */
function LimitCell({ balance, limit }: { balance: string; limit: string }) {
  let u: number | null = null;
  try { u = creditUtilization(BigInt(balance), BigInt(limit)); } catch { u = null; }
  if (u === null) return <span className="text-muted-foreground/50">—</span>;
  const pct = Math.min(100, Math.round(u * 100));
  const bar = pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-accent" : "bg-primary";
  return (
    <div className="min-w-[110px]">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
        {fmtMoney(balance)} / {fmtMoney(limit)}
      </div>
    </div>
  );
}

type AgingInvoice = { docNo: string; date: number; dueDate: number | null; total: string; outstanding: string; daysOverdue: number };type AgingRow = {
  id: string; name: string; phone: string | null; city: string | null;
  total: string; notDue: string; d30: string; d60: string; d90: string; d90plus: string;
  oldestDays: number; invoices: AgingInvoice[];
};

function AgingView({ kind }: { kind: "CUSTOMER" | "SUPPLIER" }) {
  const { t } = useLang();
  const [rows, setRows] = useState<AgingRow[]>([]);
  const [totals, setTotals] = useState({ total: "0", notDue: "0", d30: "0", d60: "0", d90: "0", d90plus: "0" });
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>(brand.name);

  useEffect(() => {
    api<{ data: AgingRow[]; totals: typeof totals }>(`/api/reports/aging?kind=${kind}`)
      .then((d) => { setRows(d.data); setTotals(d.totals); })
      .catch(() => {})
      .finally(() => setLoading(false));
    api<{ data: { name: string } }>("/api/company")
      .then((c) => { if (c?.data?.name) setBusinessName(c.data.name); })
      .catch(() => {});
  }, [kind]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const cell = (v: string, danger = false) =>
    BigInt(v) ? <span className={danger ? "font-extrabold text-danger" : "font-semibold"}>{fmtMoney(v)}</span> : <span className="text-muted-foreground/50">—</span>;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t("balances.agingHintPre")} <span className="font-bold text-danger">{t("balances.agingHot")}</span> {t("balances.agingHintPost")}
        </p>
        <ExportCsv filename={kind === "CUSTOMER" ? "receivables-aging" : "payables-aging"} disabled={loading || rows.length === 0} rows={() => [
          [t("balances.csvParty"), t("balances.csvPhone"), `${t("balances.chipNotDue")} (${t("common.currencyNote")})`, `${t("balances.chipD30")} (${t("common.currencyNote")})`, `${t("balances.chipD60")} (${t("common.currencyNote")})`, `${t("balances.chipD90")} (${t("common.currencyNote")})`, `${t("balances.chipD90plus")} (${t("common.currencyNote")})`, `${t("balances.total")} (${t("common.currencyNote")})`],
          ...rows.map((r) => [r.name, r.phone ?? "", csvMoney(r.notDue), csvMoney(r.d30), csvMoney(r.d60), csvMoney(r.d90), csvMoney(r.d90plus), csvMoney(r.total)]),
          [t("balances.csvTotal"), "", csvMoney(totals.notDue), csvMoney(totals.d30), csvMoney(totals.d60), csvMoney(totals.d90), csvMoney(totals.d90plus), csvMoney(totals.total)],
        ]} />
      </div>
      <div className="mb-4">
        <SummaryChips items={[
          { label: t("balances.chipNotDue"), value: fmtMoney(totals.notDue), tone: "neutral" },
          { label: t("balances.chipD30"), value: fmtMoney(totals.d30), tone: "accent" },
          { label: t("balances.chipD60"), value: fmtMoney(totals.d60), tone: "accent" },
          { label: t("balances.chipD90"), value: fmtMoney(totals.d90), tone: "danger" },
          { label: t("balances.chipD90plus"), value: fmtMoney(totals.d90plus), tone: "danger" },
        ]} />
      </div>
      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("balances.emptyAgingTitle")} hint={t("balances.emptyAgingHint")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("balances.colParty")}</th><th className="num">{t("balances.colNotDue")}</th><th className="num">{t("balances.colD30")}</th><th className="num">{t("balances.colD60")}</th><th className="num">{t("balances.colD90")}</th><th className="num">{t("balances.colD90plus")}</th><th className="num">{t("balances.total")}</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const hot = BigInt(r.d90plus) > 0n;
                  const warm = !hot && BigInt(r.d90) + BigInt(r.d60) > 0n;
                  return (
                    <Fragment key={r.id}>
                      <tr className={hot ? "!bg-danger/[0.07]" : warm ? "!bg-accent/[0.06]" : ""}>
                        <td>
                          <span className="font-bold">{r.name}</span>
                          {hot && <span className="badge ms-2 !bg-danger-soft !text-danger !text-[10px]">{t("balances.overdueBadge")}</span>}
                        </td>
                        <td className="num">{cell(r.notDue)}</td>
                        <td className="num">{cell(r.d30)}</td>
                        <td className="num">{cell(r.d60)}</td>
                        <td className="num">{cell(r.d90)}</td>
                        <td className="num">{cell(r.d90plus, true)}</td>
                        <td className="num font-extrabold">{fmtMoney(r.total)}</td>
                        <td className="text-end">
                          <div className="flex items-center justify-end gap-1">
                            {kind === "CUSTOMER" && waPhone(r.phone) && (
                              <a
                                className="btn btn-ghost !px-2 !py-1 text-xs !text-success"
                                target="_blank"
                                rel="noreferrer"
                                title={t("balances.remindTitle")}
                                href={waLink(r.phone, reminderText({
                                  businessName,
                                  partyName: r.name,
                                  totalOverdue: fmtMoneyShortRs(r.total),
                                  oldestDays: r.oldestDays,
                                  invoiceCount: r.invoices.length,
                                }))}
                              >
                                <MessageCircle size={13} /> {t("balances.remind")}
                              </a>
                            )}
                            <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setOpen(open === r.id ? null : r.id)}>
                              {t("balances.bills")} <ChevronDown size={13} className={`inline transition-transform ${open === r.id ? "rotate-180" : ""}`} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open === r.id && (
                        <tr key={`${r.id}-detail`}>
                          <td colSpan={8} className="!bg-muted/40 !py-2">
                            <div className="flex flex-wrap gap-2 px-2">
                              {r.invoices.map((inv) => (
                                <span key={inv.docNo} className={`badge !text-xs ${inv.daysOverdue > 90 ? "!bg-danger-soft !text-danger" : inv.daysOverdue > 30 ? "!bg-accent-soft !text-accent" : ""}`}>
                                  {inv.docNo} · {fmtDate(inv.date)} · {fmtMoney(inv.outstanding)}
                                  {inv.daysOverdue > 0 ? ` · ${t("balances.daysLate", { days: inv.daysOverdue })}` : ` · ${t("balances.notDueYet")}`}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border">
                  <td className="!py-3 font-extrabold">{t("balances.total")}</td>
                  <td className="num !py-3 font-bold">{fmtMoney(totals.notDue)}</td>
                  <td className="num !py-3 font-bold">{fmtMoney(totals.d30)}</td>
                  <td className="num !py-3 font-bold">{fmtMoney(totals.d60)}</td>
                  <td className="num !py-3 font-bold">{fmtMoney(totals.d90)}</td>
                  <td className="num !py-3 font-extrabold text-danger">{fmtMoney(totals.d90plus)}</td>
                  <td className="num !py-3 font-extrabold">{fmtMoney(totals.total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
