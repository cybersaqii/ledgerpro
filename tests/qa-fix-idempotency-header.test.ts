/**
 * QA-sweep 2026-10-25 regression tests: standard Idempotency-Key header
 * (backend-report L2 — the standard header was silently ignored, so an
 * external client sending it got duplicates with no warning).
 *
 * Pure unit tests on extractIdempotencyKey — no DB, no route handlers.
 */
import { describe, it, expect } from "vitest";
import { extractIdempotencyKey } from "@/lib/idempotency";

function req(headers: Record<string, string>): Request {
  return new Request("http://t/api/sales", { headers });
}

describe("extractIdempotencyKey header precedence", () => {
  it("accepts the standard Idempotency-Key header", () => {
    expect(extractIdempotencyKey(req({ "Idempotency-Key": "std-key-1" }), {})).toBe("std-key-1");
  });

  it("X-Idempotency-Key still wins when both are present", () => {
    expect(
      extractIdempotencyKey(
        req({ "X-Idempotency-Key": "x-key", "Idempotency-Key": "std-key" }),
        {}
      )
    ).toBe("x-key");
  });

  it("body key still works when no header is sent", () => {
    expect(extractIdempotencyKey(req({}), { idempotencyKey: "body-key" })).toBe("body-key");
  });

  it("returns undefined when nothing is sent", () => {
    expect(extractIdempotencyKey(req({}), {})).toBeUndefined();
  });
});
