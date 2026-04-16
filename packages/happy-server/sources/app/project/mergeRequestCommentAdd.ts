import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";

interface CommentAddParams {
    mergeRequestId: string;
    body: string;
    filePath?: string;
    lineNumber?: number;
}

interface CommentRecord {
    id: string;
    mergeRequestId: string;
    authorId: string;
    body: string;
    filePath: string | null;
    lineNumber: number | null;
    createdAt: number;
}

/**
 * Add a comment to a merge request.
 * Caller must be at least an editor on the project.
 * Comments can optionally target a specific file and line.
 */
export async function mergeRequestCommentAdd(
    ctx: Context,
    params: CommentAddParams
): Promise<Result<CommentRecord>> {
    const mr = await db.mergeRequest.findUnique({ where: { id: params.mergeRequestId } });
    if (!mr) {
        return { ok: false, error: 'merge-request-not-found' };
    }

    const hasAccess = await hasProjectRole(db, mr.projectId, ctx.uid, 'editor');
    if (!hasAccess) {
        return { ok: false, error: 'access-denied' };
    }

    const comment = await db.mergeRequestComment.create({
        data: {
            mergeRequestId: params.mergeRequestId,
            authorId: ctx.uid,
            body: params.body,
            filePath: params.filePath ?? null,
            lineNumber: params.lineNumber ?? null,
        }
    });

    return {
        ok: true,
        value: {
            id: comment.id,
            mergeRequestId: comment.mergeRequestId,
            authorId: comment.authorId,
            body: comment.body,
            filePath: comment.filePath,
            lineNumber: comment.lineNumber,
            createdAt: comment.createdAt.getTime(),
        }
    };
}
