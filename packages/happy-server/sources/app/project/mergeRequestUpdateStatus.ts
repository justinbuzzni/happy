import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";

type MergeRequestStatus = 'open' | 'approved' | 'merged' | 'closed';

/**
 * Update merge request status.
 * - approve/merge: requires owner role on project
 * - close: author or project owner
 * - merged status also updates the workspace status to "merged"
 */
export async function mergeRequestUpdateStatus(
    ctx: Context,
    mrId: string,
    status: MergeRequestStatus
): Promise<Result<{ id: string; status: string }>> {
    const mr = await db.mergeRequest.findUnique({
        where: { id: mrId },
        include: { project: true },
    });
    if (!mr) {
        return { ok: false, error: 'merge-request-not-found' };
    }
    if (mr.status !== 'open' && mr.status !== 'approved') {
        return { ok: false, error: 'merge-request-not-open' };
    }

    const isProjectOwner = mr.project.accountId === ctx.uid;
    const isAuthor = mr.authorId === ctx.uid;
    const hasOwnerRole = await hasProjectRole(db, mr.projectId, ctx.uid, 'owner');

    if (status === 'approved' || status === 'merged') {
        if (!isProjectOwner && !hasOwnerRole) {
            return { ok: false, error: 'not-owner' };
        }
    } else if (status === 'closed') {
        if (!isProjectOwner && !hasOwnerRole && !isAuthor) {
            return { ok: false, error: 'access-denied' };
        }
    }

    const updated = await db.mergeRequest.update({
        where: { id: mrId },
        data: { status },
    });

    if (status === 'merged') {
        await db.workspace.update({
            where: { id: mr.workspaceId },
            data: { status: 'merged' },
        });
    }

    return { ok: true, value: { id: updated.id, status: updated.status } };
}
