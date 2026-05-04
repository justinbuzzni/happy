import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";

interface ProjectCreateParams {
    id?: string;
    name: string;
    description?: string;
    color?: string;
    config?: unknown;
    isDefault?: boolean;
}

interface ProjectRecord {
    id: string;
    accountId: string;
    name: string;
    description: string;
    color: string;
    config: unknown;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Create a new project.
 * Idempotent: if id is provided and already exists for the same user, returns existing.
 *
 * Cross-account id collision: when the id is taken by a different account
 * (e.g. aplus-platform reuses a cuid across personal and company-scoped
 * happy identities — see specs/company-scoped-happy-identity), short-
 * circuit with 'id-taken' instead of letting Prisma's unique-constraint
 * (P2002) bubble up as a 500. Callers map this to 409 so the web-ui can
 * skip the sync without a noisy toast.
 */
export async function projectCreate(
    ctx: Context,
    params: ProjectCreateParams,
): Promise<Result<ProjectRecord>> {
    if (params.id) {
        const existing = await db.project.findUnique({ where: { id: params.id } });
        if (existing) {
            if (existing.accountId === ctx.uid) {
                return { ok: true, value: existing };
            }
            return { ok: false, error: 'id-taken' };
        }
    }

    const created = await db.project.create({
        data: {
            ...(params.id ? { id: params.id } : {}),
            accountId: ctx.uid,
            name: params.name,
            description: params.description ?? '',
            color: params.color ?? '#6366f1',
            config: params.config ?? undefined,
            isDefault: params.isDefault ?? false
        }
    });
    return { ok: true, value: created };
}
