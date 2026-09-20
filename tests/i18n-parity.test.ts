import { describe, it, expect } from "vitest";
import { en } from "@/lib/i18n/en";
import { ur } from "@/lib/i18n/ur";

function leaves(obj: unknown, prefix = ""): string[] {
  if (typeof obj === "string") return [prefix];
  if (obj && typeof obj === "object") {
    return Object.entries(obj).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

describe("i18n full-dictionary parity (en/ur)", () => {
  it("every leaf key exists in both languages", () => {
    const enKeys = new Set(leaves(en));
    const urKeys = new Set(leaves(ur));
    const missing = [...enKeys].filter((k) => !urKeys.has(k));
    const extra = [...urKeys].filter((k) => !enKeys.has(k));
    expect({ missing, extra, count: enKeys.size }).toEqual({ missing: [], extra: [], count: enKeys.size });
  });
});
