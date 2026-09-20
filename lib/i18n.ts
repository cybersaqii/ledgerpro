import { en, type EnDict } from "./i18n/en";
import { ur } from "./i18n/ur";

export type Lang = "en" | "ur";
export const LANGS: Lang[] = ["en", "ur"];
export const LANG_STORAGE_KEY = "lp-lang";

type DictNode = { [k: string]: string | DictNode };

function getPath(dict: DictNode, key: string): string | undefined {
  const parts = key.split(".");
  let node: string | DictNode | undefined = dict;
  for (const p of parts) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as DictNode)[p];
  }
  return typeof node === "string" ? node : undefined;
}

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

/**
 * Translate a semantic key ("nav.sales") with optional {var} interpolation.
 * Falls back to English, then to the key itself — so untranslated pages stay readable.
 */
export function tr(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const dict = (lang === "ur" ? (ur as DictNode) : (en as unknown as DictNode));
  const hit = getPath(dict, key) ?? getPath(en as unknown as DictNode, key) ?? key;
  return fill(hit, vars);
}

/** All keys available in English (for tooling / audits). */
export function allKeys(prefix = "", node: DictNode = en as unknown as DictNode): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(full);
    else out.push(...allKeys(full, v));
  }
  return out;
}

export type { EnDict };
