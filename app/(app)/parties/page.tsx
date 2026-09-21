"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Search, Pencil, Phone, Users, Eye } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";

type Party = {
  id: string; kind: string; name: string; phone: string | null; city: string | null;
  balance: string; creditLimit: string; filerStatus: string; priceListId: string | null;
};

type PList = { id: string; name: string; isDefault: boolean };

const emptyForm = { name: "", phone: "", email: "", address: "", city: "", ntn: "", filerStatus: "NA", creditLimit: "", notes: "", priceListId: "" };

export default function PartiesPage() {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const [kind, setKind] = useState<"CUSTOMER" | "SUPPLIER">("CUSTOMER");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Party[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<null | { mode: "add" } | { mode: "edit"; party: Party }>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plists, setPlists] = useState<PList[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Party[]; total: number }>(
        `/api/parties?kind=${kind}&q=${encodeURIComponent(q)}&perPage=50`
      );
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [kind, q]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  useEffect(() => {
    api<{ data: PList[] }>("/api/price-lists").then((d) => setPlists(d.data)).catch(() => setPlists([]));
  }, []);

  function openAdd() { setForm(emptyForm); setError(null); setModal({ mode: "add" }); }
  function openEdit(p: Party) {
    setForm({
      name: p.name, phone: p.phone ?? "", email: "", address: "", city: p.city ?? "",
      ntn: "", filerStatus: p.filerStatus, creditLimit: (Number(BigInt(p.creditLimit)) / 100).toString(), notes: "",
      priceListId: p.priceListId ?? "",
    });
    setError(null);
    setModal({ mode: "edit", party: p });
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
        actions={<button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> {t("parties.addParty", { party: partyWord })}</button>}
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
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder={t("parties.searchName")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

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
              <thead><tr><th>{t("common.name")}</th><th>{t("common.phone")}</th><th>{t("common.city")}</th><th className="num">{t("common.balance")}</th><th></th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="font-bold">{p.name}</td>
                    <td className="text-muted-foreground">{p.phone ? <span className="inline-flex items-center gap-1.5"><Phone size={13} />{p.phone}</span> : "—"}</td>
                    <td className="text-muted-foreground">{p.city ?? "—"}</td>
                    <td className={`num font-extrabold ${BigInt(p.balance) > 0n ? "text-accent" : ""}`}>{fmtMoney(p.balance)}</td>
                    <td className="text-right whitespace-nowrap">
                      <Link href={`/reports/party-ledger?party=${p.id}`} className="btn btn-ghost !p-2" aria-label={t("parties.view360")} title={t("parties.view360")}>
                        <Eye size={15} />
                      </Link>
                      <button className="btn btn-ghost !p-2" onClick={() => openEdit(p)} aria-label={t("common.edit")}><Pencil size={15} /></button>
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
            <Field label={t("common.address")}><input className="field" value={form.address} onChange={set("address")} placeholder={t("parties.addressPlaceholder")} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("parties.creditLimit")} hint={t("parties.creditLimitHint")}>
                <input className="field" type="number" min="0" step="0.01" placeholder="0.00" value={form.creditLimit} onChange={set("creditLimit")} />
              </Field>
              <Field label={t("parties.filerStatus")}>
                <select className="field" value={form.filerStatus} onChange={set("filerStatus")}>
                  <option value="NA">{t("parties.filerNA")}</option>
                  <option value="FILER">{t("parties.filerYes")}</option>
                  <option value="NON_FILER">{t("parties.filerNo")}</option>
                </select>
              </Field>
              {(modal?.mode === "add" ? kind === "CUSTOMER" : modal?.party.kind === "CUSTOMER") && (
                <Field label={t("parties.priceList")}>
                  <select className="field" value={form.priceListId} onChange={set("priceListId")}>
                    <option value="">{t("parties.standardPrices")}</option>
                    {plists.map((pl) => (
                      <option key={pl.id} value={pl.id}>{pl.name}{pl.isDefault ? t("parties.defaultSuffix") : ""}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? t("common.saving") : t("common.save")}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
