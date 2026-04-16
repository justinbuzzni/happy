import { Context } from "@/context";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";
import { inTx } from "@/storage/inTx";
import { feedPostToUser } from "@/app/feed/feedPostToUser";

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
 * Notifies MR author and prior commenters via feed posts.
 */
export async function mergeRequestCommentAdd(
    ctx: Context,
    params: CommentAddParams
): Promise<Result<CommentRecord>> {
    return inTx(async (tx) => {
        const mr = await tx.mergeRequest.findUnique({
            where: { id: params.mergeRequestId },
            include: {
                project: { select: { name: true } },
                comments: { select: { authorId: true } }
            }
        });
        if (!mr) {
            return { ok: false, error: 'merge-request-not-found' as const };
        }

        const hasAccess = await hasProjectRole(tx, mr.projectId, ctx.uid, 'editor');
        if (!hasAccess) {
            return { ok: false, error: 'access-denied' as const };
        }

        const author = await tx.account.findUnique({
            where: { id: ctx.uid },
            select: { username: true }
        });

        const comment = await tx.mergeRequestComment.create({
            data: {
                mergeRequestId: params.mergeRequestId,
                authorId: ctx.uid,
                body: params.body,
                filePath: params.filePath ?? null,
                lineNumber: params.lineNumber ?? null,
            }
        });

        const notifyIds = new Set<string>([mr.authorId, ...mr.comments.map((c) => c.authorId)]);
        notifyIds.delete(ctx.uid);
        for (const userId of notifyIds) {
            await feedPostToUser(tx, userId, {
                kind: 'mr_comment',
                mergeRequestId: mr.id,
                projectId: mr.projectId,
                projectName: mr.project.name,
                title: mr.title,
                commentBody: params.body.slice(0, 200),
                authorUsername: author?.username ?? null,
            });
        }

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
    });
}
