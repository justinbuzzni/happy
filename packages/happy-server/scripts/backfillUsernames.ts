/**
 * One-shot backfill: heal the missing identity sync between web-ui
 * (~/.aplus-dev/) and happy-server's Account table.
 *
 * Pass 1 — users: copy `username` from users.json into Account.username.
 *   Why: auth flow (authRoutes.ts:29-33) only stores publicKey on upsert,
 *   so Account.username is null for every locally-registered user. The
 *   collaborative-projects invite flow looks users up by username, which
 *   permanently fails without this backfill.
 *
 * Pass 2 — companies: copy `displayName` from companies.json into
 *   Account.firstName for the company's happy-server account (resolved
 *   via the company's happyToken JWT sub). Why: company projects show
 *   the company's Account row as the implicit owner in the members
 *   panel, so the UI fallback `(이름 없음)` appears unless firstName
 *   is set. We don't touch Account.username for companies because the
 *   slug (e.g. "buzzni") may collide with a user owning the same
 *   username; firstName alone is enough for the UI.
 *
 * Scope: data-healing only. The real fix is a sync layer between web-ui
 * and happy-server (see specs/happy-server-username-sync, to be created).
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

interface AplusCompany {
    id: string;
    slug: string;
    displayName: string;
    happyToken: string;
    status: string;
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

interface PassResult {
    updated: number;
    skipped: number;
    missing: number;
    conflict: number;
    total: number;
}

async function backfillUsers(db: PrismaClient): Promise<PassResult> {
    const usersPath = join(homedir(), ".aplus-dev", "users.json");
    const raw = JSON.parse(readFileSync(usersPath, "utf8"));
    const users: AplusUser[] = Array.isArray(raw) ? raw : raw.users;

    let updated = 0, skipped = 0, missing = 0, conflict = 0;

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
        // (e.g. a future GitHub OAuth flow). One-way: null → users.json.
        if (existing.username && existing.username !== u.username) {
            console.warn(
                `! ${u.username} (${accountId}): happy-server already has username='${existing.username}', skipping`
            );
            conflict++;
            continue;
        }

        // username is @unique on Account — guard against collisions even
        // though users.json should be unique by itself.
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
        console.log(`✓ user ${u.username} (${accountId})`);
        updated++;
    }

    return { updated, skipped, missing, conflict, total: users.length };
}

async function backfillCompanies(db: PrismaClient): Promise<PassResult> {
    const companiesPath = join(homedir(), ".aplus-dev", "companies.json");
    const raw = JSON.parse(readFileSync(companiesPath, "utf8"));
    const companies: AplusCompany[] = Array.isArray(raw) ? raw : raw.companies;

    let updated = 0, skipped = 0, missing = 0, conflict = 0;

    for (const c of companies) {
        if (c.status !== "active") {
            skipped++;
            continue;
        }

        const accountId = decodeJwtSub(c.happyToken);
        if (!accountId) {
            console.warn(`! company ${c.displayName}: no sub claim in happyToken`);
            skipped++;
            continue;
        }

        const existing = await db.account.findUnique({ where: { id: accountId } });
        if (!existing) {
            console.warn(`! company ${c.displayName} (${accountId}): no account row on happy-server`);
            missing++;
            continue;
        }

        if (existing.firstName === c.displayName) {
            skipped++;
            continue;
        }

        // Don't clobber a firstName already set (Buzzni was patched manually).
        if (existing.firstName && existing.firstName !== c.displayName) {
            console.warn(
                `! company ${c.displayName} (${accountId}): firstName already set to '${existing.firstName}', skipping`
            );
            conflict++;
            continue;
        }

        await db.account.update({
            where: { id: accountId },
            data: { firstName: c.displayName },
        });
        console.log(`✓ company ${c.displayName} (${accountId})`);
        updated++;
    }

    return { updated, skipped, missing, conflict, total: companies.length };
}

async function main(): Promise<void> {
    if (!process.env.DATABASE_URL) {
        throw new Error(
            "DATABASE_URL is required. Example:\n" +
            "  DATABASE_URL='postgresql://aplus:<pw>@localhost:5433/happy' npx tsx scripts/backfillUsernames.ts"
        );
    }

    const db = new PrismaClient();

    try {
        console.log("=== users.json → Account.username ===");
        const userResult = await backfillUsers(db);
        console.log(
            `users updated=${userResult.updated} skipped=${userResult.skipped} missing=${userResult.missing} conflict=${userResult.conflict} total=${userResult.total}`
        );

        console.log("\n=== companies.json → Account.firstName ===");
        const companyResult = await backfillCompanies(db);
        console.log(
            `companies updated=${companyResult.updated} skipped=${companyResult.skipped} missing=${companyResult.missing} conflict=${companyResult.conflict} total=${companyResult.total}`
        );
    } finally {
        await db.$disconnect();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
