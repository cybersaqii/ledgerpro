import { cookies } from "next/headers";
import { json } from "@/lib/api";
import { verifyGoogleSignupToken, GOOGLE_SIGNUP_COOKIE } from "@/lib/google";

// Returns the Google account details (name + email) for pre-filling the
// signup form after an OAuth sign-in that found no existing account.
// The g_signup cookie is HttpOnly; this endpoint is the client's only way to
// read it. Consuming endpoints (signup POST) verify the same token again.
export async function GET() {
  const jar = await cookies();
  const raw = jar.get(GOOGLE_SIGNUP_COOKIE)?.value;
  if (!raw) return json({ error: "No pending Google signup." }, { status: 404 });
  const claims = await verifyGoogleSignupToken(raw);
  if (!claims) {
    jar.delete(GOOGLE_SIGNUP_COOKIE);
    return json({ error: "No pending Google signup." }, { status: 404 });
  }
  return json({ email: claims.email, name: claims.name });
}
