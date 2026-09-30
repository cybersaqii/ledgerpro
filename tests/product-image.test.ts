import { describe, it, expect } from "vitest";
import { validateImageUrl, ImageUrlError } from "@/lib/product-image";

describe("validateImageUrl", () => {
  it("accepts a plain public https URL", () => {
    expect(validateImageUrl("https://example.com/img/photo.jpg")).toBe("https://example.com/img/photo.jpg");
  });

  it("returns null for empty input", () => {
    expect(validateImageUrl("")).toBeNull();
    expect(validateImageUrl("   ")).toBeNull();
    expect(validateImageUrl(null)).toBeNull();
    expect(validateImageUrl(undefined)).toBeNull();
  });

  it("rejects non-https schemes", () => {
    expect(() => validateImageUrl("http://example.com/a.jpg")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("javascript:alert(1)")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("data:image/png;base64,AAA")).toThrow(ImageUrlError);
  });

  it("rejects private-network targets", () => {
    expect(() => validateImageUrl("https://localhost/a.jpg")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://127.0.0.1/a.jpg")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://192.168.1.5/a.jpg")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://10.0.0.2/a.jpg")).toThrow(ImageUrlError);
  });

  it("rejects garbage and overlong input", () => {
    expect(() => validateImageUrl("not a url")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://example.com/" + "a".repeat(600))).toThrow(ImageUrlError);
  });
});
