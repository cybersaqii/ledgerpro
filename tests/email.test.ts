import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendEmail } from "@/lib/email";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  vi.restoreAllMocks();
});

describe("sendEmail", () => {
  it("posts to Resend with Bearer auth and returns { ok: true, id } on 200", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "LedgerPro <noreply@ledgerprosolution.com>";
    const fetchMock = mockFetch(200, { id: "email_123" });
    globalThis.fetch = fetchMock;

    const result = await sendEmail({
      to: "user@example.com",
      subject: "Your verification code",
      html: "<p>Hello</p>",
      text: "Hello",
    });

    expect(result).toEqual({ ok: true, id: "email_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      from: "LedgerPro <noreply@ledgerprosolution.com>",
      to: ["user@example.com"],
      subject: "Your verification code",
      html: "<p>Hello</p>",
      text: "Hello",
    });
  });

  it("returns { ok: false, skipped: true } and does not call fetch without RESEND_API_KEY", async () => {
    const fetchMock = mockFetch(200, { id: "email_123" });
    globalThis.fetch = fetchMock;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sendEmail({
      to: "user@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
    });

    expect(result).toEqual({ ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("user@example.com"));
  });

  it("returns { ok: false } without throwing when Resend returns 401", async () => {
    process.env.RESEND_API_KEY = "re_bad_key";
    const fetchMock = mockFetch(401, { error: { message: "invalid key" } });
    globalThis.fetch = fetchMock;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendEmail({
      to: "user@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
    });

    expect(result).toEqual({ ok: false });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("never logs email bodies (e.g. OTP codes) to the console", async () => {
    const fakeOtp = "742981";
    const collected: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      collected.push(args.map(String).join(" "));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      collected.push(args.map(String).join(" "));
    });

    // Path A: skipped send (missing key)
    await sendEmail({
      to: "user@example.com",
      subject: "Your verification code",
      html: `<p>OTP: ${fakeOtp}</p>`,
      text: `OTP: ${fakeOtp}`,
    });

    // Path B: Resend failure with OTP in the body
    process.env.RESEND_API_KEY = "re_test_key";
    globalThis.fetch = mockFetch(401, { error: { message: "unauthorized" } });
    await sendEmail({
      to: "user@example.com",
      subject: "Your verification code",
      html: `<p>OTP: ${fakeOtp}</p>`,
      text: `OTP: ${fakeOtp}`,
    });

    const allOutput = collected.join("\n");
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(allOutput).not.toContain(fakeOtp);
  });
});
