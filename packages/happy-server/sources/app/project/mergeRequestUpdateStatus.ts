import { Context } from "@/context";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";
import { inTx } from "@/storage/inTx";
import { feedPostToUser } from "@/app/feed/feedPostToUser";

type MergeRequestStatus = 'open' | 'approved' | 'merged' | 'closed';

/**
 * Update merge request status.
 * - approve/merge: requires owner role on project
 * - close: author or project owner
 * - merged status also updates the workspace status to "merged"
 * - approved/merged: notifies the MR author via feed post
 */
export async function mergeRequestUpdateStatus(
    ctx: Context,
    mrId: string,
    status: MergeRequestStatus
): Promise<Result<{ id: string; status: string }>> {
    return inTx(async (tx) => {
        const mr = await tx.mergeRequest.findUnique({
            where: { id: mrId },
            include: { project: { select: { accountId: true, name: true } } },
        });
        if (!mr) {
            return { ok: false, error: 'merge-request-not-found' as const };
        }
        if (mr.status !== 'open' && mr.status !== 'approved') {
            return { ok: false, error: 'merge-request-not-open' as const };
        }

        const isProjectOwner = mr.project.accountId === ctx.uid;
        const isAuthor = mr.authorId === ctx.uid;
        const hasOwnerRole = await hasProjectRole(tx, mr.projectId, ctx.uid, 'owner');

        if (status === 'approved' || status === 'merged') {
            if (!isProjectOwner && !hasOwnerRole) {
                return { ok: false, error: 'not-owner' as const };
            }
        } else if (status === 'closed') {
            if (!isProjectOwner && !hasOwnerRole && !isAuthor) {
                return { ok: false, error: 'access-denied' as const };
            }
        }

        const updated = await tx.mergeRequest.update({
            where: { id: mrId },
            data: { status },
        });

        if (status === 'merged') {
            await tx.workspace.update({
                where: { id: mr.workspaceId },
                data: { status: 'merged' },
            });
        }

        if (status === 'approved' || status === 'merged') {
            const actor = await tx.account.findUnique({
                where: { id: ctx.uid },
                select: { username: true }
            });
            await feedPostToUser(tx, mr.authorId, {
                kind: status === 'merged' ? 'mr_merged' : 'mr_approved',
                mergeRequestId: mr.id,
                projectId: mr.projectId,
                projectName: mr.project.name,
                title: mr.title,
                actorUsername: actor?.username ?? null,
            }, { excludeUserId: ctx.uid });
        }

        return { ok: true, value: { id: updated.id, status: updated.status } };
    });
}
