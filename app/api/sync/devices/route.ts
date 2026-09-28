// List enrolled sync devices. Owners see every device in the company;
// staff see only their own. Token hashes are never exposed.
// Auth: cookie session (web) or device token (requireCompanyOrDevice) —
// the Bearer path is PRO/trial-gated via requireDevice().
import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { deviceTokens, users } from "@/db/schema";
import { json } from "@/lib/api";
import { requireCompanyOrDevice } from "@/lib/sync-auth";

export async function GET(req: NextRequest) {
  const gate = await requireCompanyOrDevice(req);
  if (!gate.ok) return gate.response;

  const rows = await db
    .select({
      id: deviceTokens.id,
      deviceName: deviceTokens.deviceName,
      deviceModel: deviceTokens.deviceModel,
      userId: deviceTokens.userId,
      userName: users.name,
      createdAt: deviceTokens.createdAt,
      lastUsedAt: deviceTokens.lastUsedAt,
      revokedAt: deviceTokens.revokedAt,
    })
    .from(deviceTokens)
    .innerJoin(users, eq(users.id, deviceTokens.userId))
    .where(
      gate.isOwner
        ? eq(deviceTokens.companyId, gate.companyId)
        : and(eq(deviceTokens.companyId, gate.companyId), eq(deviceTokens.userId, gate.userId))
    )
    .orderBy(deviceTokens.createdAt);

  return json({
    devices: rows.map((d) => ({
      id: d.id,
      deviceName: d.deviceName,
      deviceModel: d.deviceModel,
      userId: d.userId,
      userName: d.userName,
      createdAt: d.createdAt ? d.createdAt.getTime() : null,
      lastUsedAt: d.lastUsedAt ? d.lastUsedAt.getTime() : null,
      revokedAt: d.revokedAt ? d.revokedAt.getTime() : null,
    })),
  });
}
