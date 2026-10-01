"use client";

// Module 13 — shared project tag picker. Loads taggable projects (ACTIVE +
// ON_HOLD) and renders a labeled select; hidden entirely when the company has
// no projects so untagged workflows stay untouched.
import { useEffect, useState } from "react";
import { useLang } from "@/components/lang-provider";
import { api } from "@/lib/format";

type ProjectOpt = { id: string; code: string; name: string; status: string };

export function ProjectSelect({
  value,
  onChange,
  label,
  statuses,
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  /** Which statuses to offer; defaults to the taggable ones. */
  statuses?: string[];
}) {
  const { t } = useLang();
  const [projects, setProjects] = useState<ProjectOpt[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wanted = statuses ?? ["ACTIVE", "ON_HOLD"];
        const lists = await Promise.all(
          wanted.map((s) => api<{ projects: ProjectOpt[] }>(`/api/projects?status=${s}`))
        );
        if (!cancelled) setProjects(lists.flatMap((l) => l.projects));
      } catch {
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!loaded || projects.length === 0) return null;

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-muted-foreground">
        {label ?? t("projects.tagProject")}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="">{t("projects.noProject")}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} — {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
