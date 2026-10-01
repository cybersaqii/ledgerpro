"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Landmark, Plus, Lock, Pencil, Trash2, Power } from "lucide-react";
import { PageHeader, ErrorNote, Field } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";

type Node = {
  id: string; code: string; name: string; type: string; parentId: string | null;
  isSystem: boolean; isActive: boolean; openingBalance: string; children: Node[];
};

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
// Spec 5-digit ranges mapped onto the 4-digit scheme (see lib/chart-of-accounts.ts).
const RANGE_HINT: Record<string, string> = {
  ASSET: "1000–1999", LIABILITY: "2000–2999", EQUITY: "3000–3999", INCOME: "4000–4999", EXPENSE: "5000–6999",
};
const TYPE_BADGE: Record<string, string> = {
  ASSET: "bg-primary-soft text-primary",
  LIABILITY: "bg-warning-soft text-warning",
  EQUITY: "bg-success-soft text-success",
  INCOME: "bg-success-soft text-success",
  EXPENSE: "bg-danger-soft text-danger",
};

function flatten(nodes: Node[], depth = 0): { node: Node; depth: number }[] {
  const out: { node: Node; depth: number }[] = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    out.push(...flatten(n.children, depth + 1));
  }
  return out;
}

export default function ChartOfAccountsPage() {
  const { t } = useLang();
  const canManage = useCan("settings");
  const [tree, setTree] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { mode: "add"; parentId?: string } | { mode: "edit"; node: Node }>(null);

  const load = useCallback(() => {
    setLoading(true);
    api<{ data: Node[] }>("/api/accounts?tree=1")
      .then((d) => setTree(d.data))
      .catch((e) => setError(e instanceof Error ? e.message : t("coa.errLoad")))
      .finally(() => setLoading(false));
  }, [t]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
  useEffect(() => { load(); }, [load]);

  const flat = useMemo(() => flatten(tree), [tree]);

  async function toggleActive(node: Node) {
    setError(null);
    try {
      await api(`/api/accounts/${node.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !node.isActive }) });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : t("coa.errSave")); }
  }

  async function remove(node: Node) {
    if (!confirm(t("coa.deleteConfirm", { name: node.name }))) return;
    setError(null);
    try {
      await api(`/api/accounts/${node.id}`, { method: "DELETE" });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : t("coa.errDelete")); }
  }

  return (
    <div>
      <PageHeader
        title={t("coa.title")}
        subtitle={t("coa.subtitle")}
        icon={<Landmark size={20} />}
        actions={canManage ? (
          <button className="btn btn-primary" onClick={() => setDialog({ mode: "add" })}>
            <Plus size={15} /> {t("coa.addAccount")}
          </button>
        ) : undefined}
      />
      {error && <ErrorNote message={error} />}

      <div className="card rise rise-1 overflow-hidden">
        {loading ? <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr><th>{t("coa.colCode")}</th><th>{t("coa.colAccount")}</th><th>{t("coa.colType")}</th>
                <th className="num">{t("coa.colOpening")}</th><th className="!text-end">{t("common.actions")}</th></tr>
              </thead>
              <tbody>
                {flat.map(({ node: n, depth }) => (
                  <tr key={n.id} className={n.isActive ? "" : "opacity-50"}>
                    <td className="whitespace-nowrap font-mono text-muted-foreground">{n.code}</td>
                    <td>
                      <span style={{ paddingInlineStart: depth * 20 }} className="inline-flex items-center gap-1.5">
                        <span className="font-semibold">{n.name}</span>
                        {n.isSystem && <span title={t("coa.systemLocked")}><Lock size={12} className="text-muted-foreground" /></span>}
                        {!n.isActive && <span className="badge bg-muted text-muted-foreground !text-[10px]">{t("coa.inactive")}</span>}
                      </span>
                    </td>
                    <td><span className={`badge ${TYPE_BADGE[n.type] ?? "bg-muted text-muted-foreground"} !text-[10px]`}>{n.type}</span></td>
                    <td className="num">{BigInt(n.openingBalance) ? fmtMoney(n.openingBalance) : "—"}</td>
                    <td className="!text-end">
                      {canManage && (
                        <span className="inline-flex gap-1">
                          {!n.isSystem && (
                            <button className="btn btn-ghost !p-2" title={t("coa.edit")} onClick={() => setDialog({ mode: "edit", node: n })}>
                              <Pencil size={14} />
                            </button>
                          )}
                          <button
                            className="btn btn-ghost !p-2" title={n.isActive ? t("coa.deactivate") : t("coa.activate")}
                            onClick={() => toggleActive(n)}
                          >
                            <Power size={14} />
                          </button>
                          {!n.isSystem && (
                            <button className="btn btn-ghost !p-2 text-danger" title={t("common.delete")} onClick={() => remove(n)}>
                              <Trash2 size={14} />
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t("coa.rangeNote")}</p>

      {dialog && (
        <AccountDialog
          dialog={dialog}
          flat={flat}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); load(); }}
        />
      )}
    </div>
  );
}

function AccountDialog({ dialog, flat, onClose, onSaved }: {
  dialog: { mode: "add"; parentId?: string } | { mode: "edit"; node: Node };
  flat: { node: Node; depth: number }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLang();
  const editing = dialog.mode === "edit" ? dialog.node : null;
  const [code, setCode] = useState(editing?.code ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [type, setType] = useState<string>(editing?.type ?? "EXPENSE");
  const [parentId, setParentId] = useState<string>(dialog.mode === "add" ? (dialog.parentId ?? "") : (editing?.parentId ?? ""));
  const [opening, setOpening] = useState("");
  const [openingDate, setOpeningDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentOptions = flat.filter((f) => f.node.type === type && (!editing || f.node.id !== editing.id));

  async function save() {
    setSaving(true); setError(null);
    try {
      if (dialog.mode === "add") {
        await api("/api/accounts", {
          method: "POST",
          body: JSON.stringify({
            code, name, type,
            parentId: parentId || null,
            openingBalance: opening || undefined,
            openingDate: openingDate || undefined,
          }),
        });
      } else if (editing) {
        await api(`/api/accounts/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, parentId: parentId || null }),
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("coa.errSave"));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="card w-full max-w-lg p-6">
        <h3 className="text-base font-extrabold">{dialog.mode === "add" ? t("coa.addAccount") : t("coa.editAccount")}</h3>
        {error && <div className="mt-3"><ErrorNote message={error} /></div>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label={t("coa.code")} required hint={t("coa.codeHint", { range: RANGE_HINT[type] ?? "" })}>
            <input className="input font-mono" value={code} onChange={(e) => setCode(e.target.value)} disabled={!!editing} placeholder="6001" />
          </Field>
          <Field label={t("coa.type")} required>
            <select className="input" value={type} onChange={(e) => { setType(e.target.value); setParentId(""); }} disabled={!!editing}>
              {TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("coa.name")} required>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("coa.namePh")} />
            </Field>
          </div>
          {!editing && (
            <div className="sm:col-span-2">
              <Field label={t("coa.parent")} hint={t("coa.parentHint")}>
                <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">{t("coa.noParent")}</option>
                  {parentOptions.map((f) => (
                    <option key={f.node.id} value={f.node.id}>
                      {"—".repeat(f.depth)}{f.node.code} — {f.node.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {dialog.mode === "add" && (
            <>
              <Field label={t("coa.opening")} hint={t("coa.openingHint")}>
                <input className="input" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0.00" />
              </Field>
              <Field label={t("coa.openingDate")}>
                <input type="date" className="input" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        {editing?.isSystem && <p className="mt-3 text-xs text-muted-foreground">{t("coa.systemEditNote")}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim() || (!editing && !code.trim())}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
