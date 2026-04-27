/**
 * One-shot backfill: copy `username` from web-ui's users.json
 * (~/.aplus-dev/users.json) into happy-server's account.username column.
 *
 * Why: happy-server's auth flow only stores publicKey on account.upsert
 * (sources/app/api/routes/authRoutes.ts:29-33), so account.username is
 * null for every locally-registered user. The collaborative-projects
 * invite flow looks users up by username, which permanently fails.
 *
 * Scope: this script ONLY heals the existing inconsistency. The real fix
 * is a sync layer between web-ui's users.json and happy-server's account
 * table — see specs/happy-server-username-sync (to be created).
 *
 * Usage (containerized Postgres — the production path):
 *
 *   cd vendor/happy/packages/happy-server
 *   DATABASE_URL='postgresql://aplus:<password>@localhost:5433/happy' \
 *     npx tsx scripts/backfillUsernames.ts
 *
 * Postgres allows concurrent writes, so the happy-server container does
 * NOT need to be stopped. The script connects via Prisma using the
 * DATABASE_URL env var and exits when done.
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { PrismaClient } from "@prisma/client";

interface AplusUser {
    id: string;
    username: string;
    happyToken: string;
}

function decodeJwtSub(jwt: string): string | null {
    // happy tokens are JWTs whose `sub` claim is the happy-server account id.
    // We only need to read the payload — no signature check, since the data
    // we're using to identify the row is the same data the server itself
    // would resolve from this token at request time.
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    try {
        const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8")
        );
        return typeof payload.sub === "string" ? payload.sub : null;
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const usersPath = join(homedir(), ".aplus-dev", "users.json");
    const raw = JSON.parse(readFileSync(usersPath, "utf8"));
    const users: AplusUser[] = Array.isArray(raw) ? raw : raw.users;

    if (!process.env.DATABASE_URL) {
        throw new Error(
            "DATABASE_URL is required. Example:\n" +
            "  DATABASE_URL='postgresql://aplus:<pw>@localhost:5433/happy' npx tsx scripts/backfillUsernames.ts"
        );
    }

    const db = new PrismaClient();

    let updated = 0;
    let skipped = 0;
    let missing = 0;
    let conflict = 0;

    try {
        for (const u of users) {
            const accountId = decodeJwtSub(u.happyToken);
            if (!accountId) {
                console.warn(`! ${u.username}: no sub claim in happyToken`);
                skipped++;
                continue;
            }

            const existing = await db.account.findUnique({ where: { id: accountId } });
            if (!existing) {
                console.warn(`! ${u.username} (${accountId}): no account row on happy-server`);
                missing++;
                continue;
            }

            if (existing.username === u.username) {
                skipped++;
                continue;
            }

            // Don't clobber a username already set via a different path
            // (e.g. a future GitHub OAuth flow). The healing is one-way:
            // null → users.json value.
            if (existing.username && existing.username !== u.username) {
                console.warn(
                    `! ${u.username} (${accountId}): happy-server already has username='${existing.username}', skipping`
                );
                conflict++;
                continue;
            }

            // username is @unique on Account — guard against another web-ui
            // user already owning this name on happy-server (shouldn't
            // happen given users.json uniqueness, but the constraint is
            // there for a reason).
            const taken = await db.account.findFirst({
                where: { username: u.username, NOT: { id: accountId } },
                select: { id: true }
            });
            if (taken) {
                console.warn(
                    `! ${u.username}: username already used by account ${taken.id}, skipping`
                );
                conflict++;
                continue;
            }

            await db.account.update({
                where: { id: accountId },
                data: { username: u.username },
            });
            console.log(`✓ ${u.username} (${accountId})`);
            updated++;
        }
    } finally {
        await db.$disconnect();
    }

    console.log(
        `\nDone. updated=${updated} skipped=${skipped} missing=${missing} conflict=${conflict} total=${users.length}`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
