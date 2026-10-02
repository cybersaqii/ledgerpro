import { en, type EnDict } from "./i18n/en";
// NOTE: the Urdu dictionary is deliberately NOT statically imported here.
// At ~235KB it would land in every page's initial JS bundle. It is loaded
// on demand (dynamic import, separate chunk) via loadUrDict() when the user
// switches to Urdu; tr() falls back to English until the chunk arrives.
import type { UrDict } from "./i18n/ur";

export type { UrDict };

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
 * When lang is "ur" but the Urdu chunk hasn't loaded yet (see loadUrDict),
 * English is shown in the meantime — same keys, no layout shift.
 */
export function tr(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const dict: DictNode = lang === "ur" && urDict ? urDict : (en as unknown as DictNode);
  const hit = getPath(dict, key) ?? getPath(en as unknown as DictNode, key) ?? key;
  return fill(hit, vars);
}

/** The on-demand Urdu dictionary (null until loaded). Injected by loadUrDict(). */
let urDict: DictNode | null = null;
let urLoad: Promise<void> | null = null;

/**
 * Inject a pre-loaded Urdu dictionary. Used by loadUrDict() and by tests,
 * which import the dictionary directly to stay synchronous.
 */
export function setUrDict(dict: UrDict): void {
  urDict = dict as unknown as DictNode;
}

/** The loaded Urdu dictionary, or null if the chunk hasn't arrived yet. */
export function getUrDict(): UrDict | null {
  return urDict as unknown as UrDict | null;
}

/** True once the Urdu chunk has been loaded (client or test). */
export function isUrLoaded(): boolean {
  return urDict !== null;
}

/**
 * Load the Urdu dictionary as a separate chunk (dynamic import). Safe to call
 * repeatedly; the import runs once. Never rejects — on failure callers keep
 * showing English.
 */
export function loadUrDict(): Promise<void> {
  if (urDict) return Promise.resolve();
  if (!urLoad) {
    urLoad = import("./i18n/ur")
      .then((m) => {
        setUrDict(m.ur);
      })
      .catch(() => {
        urLoad = null;
      });
  }
  return urLoad;
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
