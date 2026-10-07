import { NextResponse } from "next/server";

// GET /.well-known/security.txt — vulnerability disclosure contact (RFC 9116).
export async function GET() {
  const body = [
    "Contact: mailto:support@ledgerprosolution.com",
    "Contact: https://www.ledgerprosolution.com/support",
    "Preferred-Languages: en, ur",
  ].join("\n");
  return new NextResponse(body + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
