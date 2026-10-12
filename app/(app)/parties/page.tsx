"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Pencil, Users, Eye, ArrowLeftRight, KeyRound, ChevronDown } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote, SortableTh, useSort} from "@/components/ui";
import { Modal } from "@/components/modal";
import { PortalTokensModal } from "@/components/portal-tokens-modal";
import { api, fmtMoney } from "@/lib/format";
import { paisaToRupees } from "@/lib/pos";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";

type Party = {
  id: string; kind: string; name: string; phone: string | null; email: string | null; city: string | null;
  balance: string; creditLimit: string; filerStatus: string; category: string | null;
};


type PartyDetail = {
  id: string; name: string; phone: string | null; email: string | null;
  address: string | null; city: string | null; ntn: string | null;
  customerType: string; currency: string | null; strn: string | null;
  openingBalance: string; openingBalanceDate: string | null;
  paymentTerms: string | null; shippingAddress: string | null; shippingCity: string | null;
  filerStatus: string; creditLimit: string; notes: string | null; category: string | null;
  displayName: string | null; whtCategory: string; activeTaxPayer: boolean;
  bankIban: string | null; bankAccountNo: string | null;
  /** Module 22: party's default price list (sales). */
  priceListId: string | null;
};

const emptyForm = {
  name: "", phone: "", email: "", address: "", city: "", ntn: "", filerStatus: "NA", creditLimit: "", notes: "", category: "",
  customerType: "INDIVIDUAL", currency: "", strn: "", openingBalance: "", openingBalanceDate: "",
  paymentTerms: "", shippingAddress: "", shippingCity: "",
  // Module 2.1: supplier master completeness
  displayName: "", whtCategory: "NONE", activeTaxPayer: false, bankIban: "", bankAccountNo: "",
  // Module 22: party's default price list
  priceListId: "",
};

// Derived, stable account number — the schema has no account-code field,
// so this is computed client-side from the party id + kind only.
function accountNo(p: { id: string; kind: string }): string {
  let h = 0;
  for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${p.kind === "CUSTOMER" ? "C" : "S"}-${String(100000 + (h % 900000))}`;
}

type StatusFilter = "ACTIVE" | "ARCHIVED" | "ALL";

export default function PartiesPage({ defaultKind }: { defaultKind?: "CUSTOMER" | "SUPPLIER" }) {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const canSetoff = useCan("payments");
  const canPortal = useCan("portal");
  const [portalParty, setPortalParty] = useState<{ id: string; name: string } | null>(null);
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  // Kind is fixed per route (/sales/customers → CUSTOMER, /purchases/suppliers → SUPPLIER).
  const kind: "CUSTOMER" | "SUPPLIER" = defaultKind ?? (searchParams?.get("kind")?.toUpperCase() === "SUPPLIER" ? "SUPPLIER" : "CUSTOMER");
  // FA-style filters — all client-side; the API returns this kind's active parties only.
  const [acctNoFilter, setAcctNoFilter] = useState("");
  const [partyFilter, setPartyFilter] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ACTIVE");
  const [rows, setRows] = useState<Party[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [sort, onSort, sortedRows] = useSort(rows, (p, key) => {
    switch (key) {
      case "name": return p.name;
      case "phone": return p.phone ?? "";
      case "city": return p.city ?? "";
      case "balance": return BigInt(p.balance);
      default: return "";
    }
  });
  const [total, setTotal] = useState(0);
  // Module 22: price lists for the party form selector.
  const [priceLists, setPriceLists] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api<{ data: { id: string; name: string }[] }>("/api/price-lists")
      .then((d) => setPriceLists(d.data))
      .catch(() => {});
  }, []);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<null | { mode: "add" } | { mode: "edit"; party: Party }>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // perPage=100 so the party dropdown lists as many parties as possible.
      const d = await api<{ data: Party[]; total: number }>(
        `/api/parties?kind=${kind}&perPage=100`
      );
      setRows(d.data);
      setTotal(d.total);
      setSelected(new Set());
    } catch { setRows([]); } finally { setLoading(false); }
  }, [kind]);

  /* eslint-disable react-hooks/set-state-in-effect -- intentional: fetch list on mount/kind change */
  useEffect(() => { load(); }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Close the action dropdown on outside click / Escape.
  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-action-menu]")) setOpenMenu(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenMenu(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [openMenu]);

  const filtered = useMemo(() => {
    const a = acctNoFilter.trim().toLowerCase();
    return sortedRows.filter((p) => {
      if (status === "ARCHIVED") return false; // API returns active parties only
      if (partyFilter && p.id !== partyFilter) return false;
      if (a && !accountNo(p).toLowerCase().includes(a)) return false;
      return true;
    });
  }, [sortedRows, acctNoFilter, partyFilter, status]);

  // Row selection resets whenever the user changes any filter.
  function resetSelection() { setSelected(new Set()); }

  const visibleIds = filtered.map((p) => p.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const filtersSet = acctNoFilter !== "" || partyFilter !== "" || status !== "ACTIVE";
  function clearFilters() {
    setAcctNoFilter("");
    setPartyFilter("");
    setStatus("ACTIVE");
    resetSelection();
  }

  function openAdd() { setForm(emptyForm); setError(null); setModal({ mode: "add" }); }
  // Fetch the full row first: the list omits email/address/NTN/notes, and
  // sending those back blank would silently wipe them on save.
  async function openEdit(p: Party) {
    setError(null);
    try {
      const d = await api<{ data: PartyDetail }>(`/api/parties/${p.id}`);
      const full = d.data;
      setForm({
        name: full.name, phone: full.phone ?? "", email: full.email ?? "",
        address: full.address ?? "", city: full.city ?? "", ntn: full.ntn ?? "",
        filerStatus: full.filerStatus,
        creditLimit: paisaToRupees(full.creditLimit),
        notes: full.notes ?? "",
        category: full.category ?? "",
        customerType: full.customerType ?? "INDIVIDUAL",
        currency: full.currency ?? "", strn: full.strn ?? "",
        openingBalance: "", openingBalanceDate: "", // opening is immutable: add-mode only
        paymentTerms: full.paymentTerms ?? "",
        shippingAddress: full.shippingAddress ?? "", shippingCity: full.shippingCity ?? "",
        // Module 2.1: supplier master completeness
        displayName: full.displayName ?? "",
        whtCategory: full.whtCategory ?? "NONE",
        activeTaxPayer: !!full.activeTaxPayer,
        bankIban: full.bankIban ?? "",
        bankAccountNo: full.bankAccountNo ?? "",
        priceListId: full.priceListId ?? "",
      });
      setModal({ mode: "edit", party: p });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("parties.loadError"));
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      if (modal?.mode === "add") {
        await api("/api/parties", { method: "POST", body: JSON.stringify({ kind, ...form }) });
      } else if (modal?.mode === "edit") {
        await api(`/api/parties/${modal.party.id}`, { method: "PATCH", body: JSON.stringify(form) });
      }
      setModal(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("parties.saveError"));
    } finally { setSaving(false); }
  }

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const partyWord = kind === "CUSTOMER" ? bp.partyOne.toLowerCase() : t("docs.supplier").toLowerCase();
  const partyMany = kind === "CUSTOMER" ? bp.partyMany : t("parties.suppliersTitle");
  const nameCol = kind === "CUSTOMER" ? t("parties.customerName") : t("parties.supplierName");
  const ledgerLink = (p: Party) => `/reports/party-ledger?party=${p.id}`;

  return (
    <div>
      <PageHeader
        title={partyMany}
        subtitle={t("parties.subtitle", { total })}
        icon={<Users size={20} />}
        actions={<>
          {canSetoff && <Link href="/parties/setoff" className="btn btn-ghost text-sm"><ArrowLeftRight size={16} /> {t("setoff.title")}</Link>}
          <button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> {t("parties.addParty", { party: partyWord })}</button>
        </>}
      />

      {/* FA-style filters row */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-muted-foreground">{t("parties.accountNo")}</span>
          <input className="field min-w-44" dir="ltr" placeholder={t("parties.accountNo")}
            value={acctNoFilter} onChange={(e) => { setAcctNoFilter(e.target.value); resetSelection(); }} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-muted-foreground">{kind === "CUSTOMER" ? bp.partyMany : t("parties.suppliersTitle")}</span>
          <select className="field min-w-52" value={partyFilter}
            onChange={(e) => { setPartyFilter(e.target.value === "__all" ? "" : e.target.value); resetSelection(); }}>
            <option value="">{kind === "CUSTOMER" ? t("parties.selectCustomer") : t("parties.selectSupplier")}</option>
            <option value="__all">{t("parties.statusAll")}</option>
            {rows.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-bold text-muted-foreground">{t("parties.status")}</span>
          <select className="field" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); resetSelection(); }}>
            <option value="ACTIVE">{t("parties.statusActive")}</option>
            <option value="ARCHIVED">{t("parties.statusArchived")}</option>
            <option value="ALL">{t("parties.statusAll")}</option>
          </select>
        </label>
        {filtersSet && (
          <button className="btn btn-ghost !border !border-primary !bg-transparent text-sm !text-primary hover:!bg-primary/5"
            onClick={clearFilters}>{t("common.clear")}</button>
        )}
      </div>
      {!modal && <ErrorNote message={error} />}

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("parties.noParties", { parties: partyMany.toLowerCase() })}
            hint={t("parties.emptyHint")}
            action={<button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> {t("parties.addNow")}</button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th className="w-10">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={allSelected}
                    onChange={toggleAll} aria-label={t("parties.selectAll")} />
                </th>
                <SortableTh label={nameCol} sortKey="name" sort={sort} onSort={onSort} />
                <th>{t("parties.accountNo")}</th>
                <th>{t("parties.colContact")}</th>
                <th>{t("parties.email")}</th>
                <th>{t("parties.colMobile")}</th>
                <SortableTh label={t("common.balance")} sortKey="balance" sort={sort} onSort={onSort} className="num" />
                <th>{t("parties.colAction")}</th>
              </tr></thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-muted-foreground">
                      {t("parties.noMatch", { parties: partyMany.toLowerCase() })}
                      {filtersSet && (
                        <div className="mt-3">
                          <button className="btn btn-ghost !border !border-primary !bg-transparent text-sm !text-primary"
                            onClick={clearFilters}>{t("common.clear")}</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ) : filtered.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input type="checkbox" className="h-4 w-4 accent-primary" checked={selected.has(p.id)}
                        onChange={() => toggleOne(p.id)} aria-label={p.name} />
                    </td>
                    <td className="font-bold">
                      <Link href={ledgerLink(p)} className="text-primary hover:underline">{p.name}</Link>
                    </td>
                    <td className="font-mono text-muted-foreground" dir="ltr">{accountNo(p)}</td>
                    <td className="text-muted-foreground">—</td>
                    <td className="text-muted-foreground">{p.email || "—"}</td>
                    <td className="text-muted-foreground">{p.phone || "—"}</td>
                    <td className={`num font-extrabold ${BigInt(p.balance) > 0n ? "text-accent" : ""}`}>{fmtMoney(p.balance)}</td>
                    <td className="whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <div className="relative" data-action-menu>
                          <button
                            className="btn btn-ghost inline-flex items-center gap-1 !px-3 !py-2 text-sm font-bold"
                            onClick={() => setOpenMenu(openMenu === p.id ? null : p.id)}
                            aria-haspopup="menu" aria-expanded={openMenu === p.id}>
                            {t("common.view")} <ChevronDown size={15} className={`transition ${openMenu === p.id ? "rotate-180" : ""}`} />
                          </button>
                          {openMenu === p.id && (
                            <div role="menu" className="absolute end-0 top-full z-20 mt-1 min-w-36 rounded-xl border border-border bg-card p-1 shadow-lg">
                              <Link role="menuitem" href={ledgerLink(p)} onClick={() => setOpenMenu(null)}
                                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted">
                                <Eye size={14} /> {t("parties.view360")}
                              </Link>
                              <button role="menuitem" onClick={() => { setOpenMenu(null); openEdit(p); }}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted">
                                <Pencil size={14} /> {t("common.edit")}
                              </button>
                            </div>
                          )}
                        </div>
                        {canPortal && (
                          <button className="btn btn-ghost !p-2" onClick={() => setPortalParty({ id: p.id, name: p.name })} aria-label={t("portal.tokensTitle")} title={t("portal.tokensTitle")}><KeyRound size={15} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal title={modal.mode === "add" ? t("parties.addTitle", { party: partyWord }) : t("parties.editTitle", { party: bp.partyOne.toLowerCase() })} onClose={() => setModal(null)}>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <Field label={t("common.name")}><input className="field" required value={form.name} onChange={set("name")} placeholder={t("parties.namePlaceholder")} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("common.phone")}><input className="field" value={form.phone} onChange={set("phone")} placeholder={t("parties.phonePlaceholder")} /></Field>
              <Field label={t("common.city")}><input className="field" value={form.city} onChange={set("city")} placeholder={t("parties.cityPlaceholder")} /></Field>
            </div>
            <Field label={t("parties.creditLimit")} hint={t("parties.creditLimitHint")}>
              <input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.creditLimit} onChange={set("creditLimit")} />
            </Field>
            {/* Daily essentials only — the rest lives under Advanced below. */}
            <details className="rounded-xl border border-border">
              <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-muted-foreground hover:text-foreground">
                {t("parties.advanced")}
              </summary>
              <div className="space-y-4 border-t border-border px-4 py-4">
            <Field label={t("parties.email")}><input className="field" type="email" value={form.email} onChange={set("email")} /></Field>
            <Field label={t("parties.ntn")}><input className="field" value={form.ntn} onChange={set("ntn")} /></Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("parties.customerType")}>
                <select className="field" value={form.customerType} onChange={set("customerType")}>
                  <option value="INDIVIDUAL">{t("parties.typeIndividual")}</option>
                  <option value="REGISTERED_BUSINESS">{t("parties.typeRegistered")}</option>
                </select>
              </Field>
              <Field label={t("parties.currency")} hint={t("parties.currencyHint")}>
                <input className="field" value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) }))} placeholder="PKR" maxLength={3} />
              </Field>
              <Field label={t("parties.strn")}><input className="field" value={form.strn} onChange={set("strn")} /></Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("parties.paymentTerms")}>
                <select className="field" value={form.paymentTerms} onChange={set("paymentTerms")}>
                  <option value="">{t("parties.termNone")}</option>
                  <option value="DUE_ON_RECEIPT">{t("parties.termDueOnReceipt")}</option>
                  <option value="NET_15">{t("parties.termNet15")}</option>
                  <option value="NET_30">{t("parties.termNet30")}</option>
                  <option value="NET_45">{t("parties.termNet45")}</option>
                </select>
              </Field>
              <Field label={t("parties.shippingCity")}><input className="field" value={form.shippingCity} onChange={set("shippingCity")} /></Field>
            </div>
            <Field label={t("parties.shippingAddress")}><input className="field" value={form.shippingAddress} onChange={set("shippingAddress")} /></Field>
            {modal.mode === "add" && (
              <div className="rounded-xl border border-dashed border-border p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("parties.openingBalance")} hint={t("parties.openingBalanceHint")}>
                    <input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.openingBalance} onChange={set("openingBalance")} />
                  </Field>
                  <Field label={t("parties.openingDate")} hint={t("parties.openingDateHint")}>
                    <input className="field" type="date" value={form.openingBalanceDate} onChange={set("openingBalanceDate")} />
                  </Field>
                </div>
              </div>
            )}
            <Field label={t("common.address")}><input className="field" value={form.address} onChange={set("address")} placeholder={t("parties.addressPlaceholder")} /></Field>
            <Field label={t("parties.category")}><input className="field" value={form.category} onChange={set("category")} placeholder={t("parties.categoryFilter")} /></Field>
            <Field label={t("parties.notes")}><textarea className="field" rows={2} value={form.notes} onChange={set("notes")} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Module 22: the party's default price list — auto-applies on sales docs */}
              <Field label={t("pricing.priceList")} hint={t("parties.priceListHint")}>
                <select className="field" value={form.priceListId ?? ""} onChange={set("priceListId")}>
                  <option value="">{t("pricing.defaultPricing")}</option>
                  {priceLists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={t("parties.filerStatus")}>
                <select className="field" value={form.filerStatus} onChange={set("filerStatus")}>
                  <option value="NA">{t("parties.filerNA")}</option>
                  <option value="FILER">{t("parties.filerYes")}</option>
                  <option value="NON_FILER">{t("parties.filerNo")}</option>
                </select>
              </Field>
            </div>
            {/* Module 2.1: supplier master completeness — WHT category, ATL status, bank details */}
            {kind === "SUPPLIER" && (
              <div className="space-y-4 rounded-xl border border-border p-4">
                <div className="text-sm font-bold">{t("parties.supplierTaxSection")}</div>
                <Field label={t("parties.displayName")} hint={t("parties.displayNameHint")}>
                  <input className="field" value={form.displayName} onChange={set("displayName")} placeholder={t("parties.displayNamePlaceholder")} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("parties.whtCategory")} hint={t("parties.whtCategoryHint")}>
                    <select className="field" value={form.whtCategory} onChange={set("whtCategory")}>
                      <option value="NONE">{t("parties.whtNone")}</option>
                      <option value="GOODS">{t("parties.whtGoods")}</option>
                      <option value="SERVICES">{t("parties.whtServices")}</option>
                      <option value="CONTRACTS">{t("parties.whtContracts")}</option>
                    </select>
                  </Field>
                  <Field label={t("parties.activeTaxPayer")}>
                    <label className="flex cursor-pointer items-center gap-2.5 pt-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={form.activeTaxPayer}
                        onChange={(e) => setForm((f) => ({ ...f, activeTaxPayer: e.target.checked }))}
                      />
                      <span className="text-sm text-muted-foreground">{t("parties.activeTaxPayerHint")}</span>
                    </label>
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("parties.bankIban")}>
                    <input className="field" value={form.bankIban} onChange={set("bankIban")} placeholder="PK00XXXX0000000000000000" dir="ltr" />
                  </Field>
                  <Field label={t("parties.bankAccountNo")}>
                    <input className="field" value={form.bankAccountNo} onChange={set("bankAccountNo")} dir="ltr" />
                  </Field>
                </div>
              </div>
            )}
              </div>
            </details>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? t("common.saving") : t("common.save")}</button>
            </div>
          </form>
        </Modal>
      )}

      {portalParty && (
        <PortalTokensModal partyId={portalParty.id} partyName={portalParty.name} onClose={() => setPortalParty(null)} />
      )}
    </div>
  );
}
