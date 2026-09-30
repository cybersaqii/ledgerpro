import { NextRequest } from "next/server";
import { json } from "@/lib/api";

export async function GET(_req: NextRequest) {
  return json({ google: !!process.env.GOOGLE_CLIENT_ID });
}
