"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Search, Pencil, Phone, Users, Eye } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney } from "@/lib/format";
import { useBusinessProfile } from "@/components/business-type";

type Party = {
  id: string; kind: string; name: string; phone: string | null; city: string | null;
  balance: string; creditLimit: string; filerStatus: string;
};

const emptyForm = { name: "", phone: "", email: "", address: "", city: "", ntn: "", filerStatus: "NA", creditLimit: "0", notes: "" };

export default function PartiesPage() {
  const bp = useBusinessProfile();
  const [kind, setKind] = useState<"CUSTOMER" | "SUPPLIER">("CUSTOMER");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Party[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<null | { mode: "add" } | { mode: "edit"; party: Party }>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  function openAdd() { setForm(emptyForm); setError(null); setModal({ mode: "add" }); }
  function openEdit(p: Party) {
    setForm({
      name: p.name, phone: p.phone ?? "", email: "", address: "", city: p.city ?? "",
      ntn: "", filerStatus: p.filerStatus, creditLimit: (Number(BigInt(p.creditLimit)) / 100).toString(), notes: "",
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
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally { setSaving(false); }
  }

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <PageHeader
        title={kind === "CUSTOMER" ? bp.partyMany : "Suppliers"}
        subtitle={`${total} total · balances update automatically with every bill and payment`}
        icon={<Users size={20} />}
        actions={<button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> Add {kind === "CUSTOMER" ? bp.partyOne.toLowerCase() : "supplier"}</button>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-xl border border-border bg-card p-1">
          {(["CUSTOMER", "SUPPLIER"] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)}
              className={`rounded-lg px-4 py-2 text-sm font-bold transition ${kind === k ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
              {k === "CUSTOMER" ? bp.partyMany : "Suppliers"}
            </button>
          ))}
        </div>
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="field !pl-9" placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={`No ${kind === "CUSTOMER" ? bp.partyMany.toLowerCase() : "suppliers"} yet`}
            hint="Add your first one to start billing."
            action={<button className="btn btn-primary text-sm" onClick={openAdd}><Plus size={16} /> Add now</button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Name</th><th>Phone</th><th>City</th><th className="num">Balance</th><th></th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="font-bold">{p.name}</td>
                    <td className="text-muted-foreground">{p.phone ? <span className="inline-flex items-center gap-1.5"><Phone size={13} />{p.phone}</span> : "—"}</td>
                    <td className="text-muted-foreground">{p.city ?? "—"}</td>
                    <td className={`num font-extrabold ${BigInt(p.balance) > 0n ? "text-accent" : ""}`}>{fmtMoney(p.balance)}</td>
                    <td className="text-right whitespace-nowrap">
                      <Link href={`/reports/party-ledger?party=${p.id}`} className="btn btn-ghost !p-2" aria-label="360 view" title="360 view">
                        <Eye size={15} />
                      </Link>
                      <button className="btn btn-ghost !p-2" onClick={() => openEdit(p)} aria-label="Edit"><Pencil size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal title={modal.mode === "add" ? `Add ${kind === "CUSTOMER" ? bp.partyOne.toLowerCase() : "supplier"}` : `Edit ${bp.partyOne.toLowerCase()}`} onClose={() => setModal(null)}>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <Field label="Name"><input className="field" required value={form.name} onChange={set("name")} placeholder="e.g. Bilal Store" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone"><input className="field" value={form.phone} onChange={set("phone")} placeholder="03xx xxxxxxx" /></Field>
              <Field label="City"><input className="field" value={form.city} onChange={set("city")} placeholder="e.g. Lahore" /></Field>
            </div>
            <Field label="Address"><input className="field" value={form.address} onChange={set("address")} placeholder="Shop address" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Credit limit (Rs)">
                <input className="field" type="number" min="0" step="0.01" value={form.creditLimit} onChange={set("creditLimit")} />
              </Field>
              <Field label="Filer status">
                <select className="field" value={form.filerStatus} onChange={set("filerStatus")}>
                  <option value="NA">Not applicable</option>
                  <option value="FILER">Filer</option>
                  <option value="NON_FILER">Non-filer</option>
                </select>
              </Field>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
