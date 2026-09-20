"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/format";

type MeResponse = {
  user: { id: string; name: string; email: string; role: string; permissions: string[] };
  company: { id: string; name: string; businessType: string };
};

let cache: MeResponse | null = null;
let inflight: Promise<MeResponse> | null = null;

function fetchMe(): Promise<MeResponse> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api<MeResponse>("/api/auth/me")
      .then((d) => {
        cache = d;
        return d;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Clear the cached /api/auth/me response (e.g. after logout). */
export function clearMeCache() {
  cache = null;
}

/**
 * Current user's permission set. Owners implicitly hold every permission;
 * staff hold their explicit grant set (see lib/permissions.ts).
 * UI-only: every API route enforces this server-side.
 */
export function usePermissions(): { permissions: string[]; role: string | null; loading: boolean } {
  const [state, setState] = useState<{ permissions: string[]; role: string | null }>(() =>
    cache
      ? { permissions: cache.user.permissions ?? [], role: cache.user.role }
      : { permissions: [], role: null }
  );
  const [loading, setLoading] = useState(!cache);
  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((d) => {
        if (alive) {
          setState({ permissions: d.user.permissions ?? [], role: d.user.role });
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { ...state, loading };
}

/** Shorthand: does the current user hold `permission`? */
export function useCan(permission: string): boolean {
  const { permissions } = usePermissions();
  return permissions.includes(permission);
}
