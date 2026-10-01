"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Search, Pencil, Phone, Users, Eye, ArrowLeftRight, KeyRound } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote } from "@/components/ui";
import { Modal } from "@/components/modal";
import { PortalTokensModal } from "@/components/portal-tokens-modal";
import { api, fmtMoney } from "@/lib/format";
import { paisaToRupees } from "@/lib/pos";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";

type Party = {
  id: string; kind: string; name: string; phone: string | null; city: string | null;
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

export default function PartiesPage() {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const canSetoff = useCan("payments");
  const canPortal = useCan("portal");
  const [portalParty, setPortalParty] = useState<{ id: string; name: string } | null>(null);
  const [kind, setKind] = useState<"CUSTOMER" | "SUPPLIER">("CUSTOMER");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [rows, setRows] = useState<Party[]>([]);
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
      const d = await api<{ data: Party[]; total: number }>(
        `/api/parties?kind=${kind}&q=${encodeURIComponent(q)}${category ? `&category=${encodeURIComponent(category)}` : ""}&perPage=50`
      );
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [kind, q, category]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

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

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-xl border border-border bg-card p-1">
          {(["CUSTOMER", "SUPPLIER"] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)}
              className={`rounded-lg px-4 py-2 text-sm font-bold transition ${kind === k ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
              {k === "CUSTOMER" ? bp.partyMany : t("parties.suppliersTitle")}
            </button>
          ))}
        </div>
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !ps-9" placeholder={t("parties.searchName")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="relative min-w-40 sm:max-w-2xs">
          <input className="field" placeholder={t("parties.categoryFilter")} value={category} onChange={(e) => setCategory(e.target.value)} list="party-categories" />
          <datalist id="party-categories">
            {[...new Set(rows.map((r) => r.category).filter(Boolean))].map((c) => (
              <option key={c as string} value={c as string} />
            ))}
          </datalist>
        </div>
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
              <thead><tr><th>{t("common.name")}</th><th>{t("common.phone")}</th><th>{t("common.city")}</th><th>{t("parties.category")}</th><th className="num">{t("common.balance")}</th><th></th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="font-bold">{p.name}</td>
                    <td className="text-muted-foreground">{p.phone ? <span className="inline-flex items-center gap-1.5"><Phone size={13} />{p.phone}</span> : "—"}</td>
                    <td className="text-muted-foreground">{p.city ?? "—"}</td>
                    <td className="text-muted-foreground">{p.category ? <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold">{p.category}</span> : "—"}</td>
                    <td className={`num font-extrabold ${BigInt(p.balance) > 0n ? "text-accent" : ""}`}>{fmtMoney(p.balance)}</td>
                    <td className="whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                      <Link href={`/reports/party-ledger?party=${p.id}`} className="btn btn-ghost !p-2" aria-label={t("parties.view360")} title={t("parties.view360")}>
                        <Eye size={15} />
                      </Link>
                      <button className="btn btn-ghost !p-2" onClick={() => openEdit(p)} aria-label={t("common.edit")}><Pencil size={15} /></button>
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
              <Field label={t("parties.email")}><input className="field" type="email" value={form.email} onChange={set("email")} /></Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("common.city")}><input className="field" value={form.city} onChange={set("city")} placeholder={t("parties.cityPlaceholder")} /></Field>
              <Field label={t("parties.ntn")}><input className="field" value={form.ntn} onChange={set("ntn")} /></Field>
            </div>
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
              <Field label={t("parties.creditLimit")} hint={t("parties.creditLimitHint")}>
                <input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.creditLimit} onChange={set("creditLimit")} />
              </Field>
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
