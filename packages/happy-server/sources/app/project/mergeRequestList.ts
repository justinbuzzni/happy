import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";

interface MergeRequestInfo {
    id: string;
    title: string;
    description: string;
    projectId: string;
    workspaceId: string;
    workspaceName: string;
    branchName: string;
    authorId: string;
    authorUsername: string | null;
    status: string;
    commentCount: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * List merge requests for a project.
 * Caller must be at least a viewer on the project.
 * Returns open MRs first, then others by date.
 */
export async function mergeRequestList(
    ctx: Context,
    projectId: string
): Promise<Result<MergeRequestInfo[]>> {
    const hasAccess = await hasProjectRole(db, projectId, ctx.uid, 'viewer');
    if (!hasAccess) {
        return { ok: false, error: 'access-denied' };
    }

    const mrs = await db.mergeRequest.findMany({
        where: { projectId },
        include: {
            author: { select: { username: true } },
            workspace: { select: { name: true, branchName: true } },
            _count: { select: { comments: true } },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });

    return {
        ok: true,
        value: mrs.map(mr => ({
            id: mr.id,
            title: mr.title,
            description: mr.description,
            projectId: mr.projectId,
            workspaceId: mr.workspaceId,
            workspaceName: mr.workspace.name,
            branchName: mr.workspace.branchName,
            authorId: mr.authorId,
            authorUsername: mr.author.username,
            status: mr.status,
            commentCount: mr._count.comments,
            createdAt: mr.createdAt.getTime(),
            updatedAt: mr.updatedAt.getTime(),
        }))
    };
}
