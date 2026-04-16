import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";

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
 */
export async function mergeRequestCreate(
    ctx: Context,
    params: MergeRequestCreateParams
): Promise<Result<MergeRequestRecord>> {
    const hasAccess = await hasProjectRole(db, params.projectId, ctx.uid, 'editor');
    if (!hasAccess) {
        return { ok: false, error: 'access-denied' };
    }

    const workspace = await db.workspace.findUnique({ where: { id: params.workspaceId } });
    if (!workspace || workspace.projectId !== params.projectId) {
        return { ok: false, error: 'workspace-not-found' };
    }
    if (workspace.status !== 'active') {
        return { ok: false, error: 'workspace-not-found' };
    }

    const mr = await db.mergeRequest.create({
        data: {
            title: params.title,
            description: params.description ?? '',
            projectId: params.projectId,
            workspaceId: params.workspaceId,
            authorId: ctx.uid,
        }
    });

    return { ok: true, value: mr };
}
