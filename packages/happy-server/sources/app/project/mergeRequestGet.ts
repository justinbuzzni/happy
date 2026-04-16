import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";

interface MergeRequestDetail {
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
    comments: Array<{
        id: string;
        authorId: string;
        authorUsername: string | null;
        body: string;
        filePath: string | null;
        lineNumber: number | null;
        createdAt: number;
    }>;
    createdAt: number;
    updatedAt: number;
}

/**
 * Get a single merge request with its comments.
 * Caller must be at least a viewer on the project.
 */
export async function mergeRequestGet(
    ctx: Context,
    mrId: string
): Promise<Result<MergeRequestDetail>> {
    const mr = await db.mergeRequest.findUnique({
        where: { id: mrId },
        include: {
            author: { select: { username: true } },
            workspace: { select: { name: true, branchName: true } },
            comments: {
                include: { author: { select: { username: true } } },
                orderBy: { createdAt: 'asc' },
            },
        },
    });
    if (!mr) {
        return { ok: false, error: 'merge-request-not-found' };
    }

    const hasAccess = await hasProjectRole(db, mr.projectId, ctx.uid, 'viewer');
    if (!hasAccess) {
        return { ok: false, error: 'access-denied' };
    }

    return {
        ok: true,
        value: {
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
            comments: mr.comments.map(c => ({
                id: c.id,
                authorId: c.authorId,
                authorUsername: c.author.username,
                body: c.body,
                filePath: c.filePath,
                lineNumber: c.lineNumber,
                createdAt: c.createdAt.getTime(),
            })),
            createdAt: mr.createdAt.getTime(),
            updatedAt: mr.updatedAt.getTime(),
        }
    };
}
