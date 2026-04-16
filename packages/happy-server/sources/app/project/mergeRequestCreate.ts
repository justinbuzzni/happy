import { Context } from "@/context";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";
import { inTx } from "@/storage/inTx";
import { feedPostToProjectMembers } from "@/app/feed/feedPostToUser";

interface MergeRequestCreateParams {
    title: string;
    description?: string;
    workspaceId: string;
    projectId: string;
}

interface MergeRequestRecord {
    id: string;
    title: string;
    description: string;
    projectId: string;
    workspaceId: string;
    authorId: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Create a merge request from a workspace to the project's main branch.
 * Caller must be at least an editor on the project.
 * The workspace must be active.
 * Notifies all other project members via feed posts.
 */
export async function mergeRequestCreate(
    ctx: Context,
    params: MergeRequestCreateParams
): Promise<Result<MergeRequestRecord>> {
    return inTx(async (tx) => {
        const hasAccess = await hasProjectRole(tx, params.projectId, ctx.uid, 'editor');
        if (!hasAccess) {
            return { ok: false, error: 'access-denied' as const };
        }

        const workspace = await tx.workspace.findUnique({ where: { id: params.workspaceId } });
        if (!workspace || workspace.projectId !== params.projectId) {
            return { ok: false, error: 'workspace-not-found' as const };
        }
        if (workspace.status !== 'active') {
            return { ok: false, error: 'workspace-not-found' as const };
        }

        const project = await tx.project.findUnique({
            where: { id: params.projectId },
            select: { name: true }
        });
        const author = await tx.account.findUnique({
            where: { id: ctx.uid },
            select: { username: true }
        });

        const mr = await tx.mergeRequest.create({
            data: {
                title: params.title,
                description: params.description ?? '',
                projectId: params.projectId,
                workspaceId: params.workspaceId,
                authorId: ctx.uid,
            }
        });

        if (project) {
            await feedPostToProjectMembers(tx, params.projectId, ctx.uid, {
                kind: 'mr_created',
                mergeRequestId: mr.id,
                projectId: params.projectId,
                projectName: project.name,
                title: mr.title,
                authorUsername: author?.username ?? null,
            });
        }

        return { ok: true, value: mr };
    });
}
