import { Context } from "@/context";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";
import { inTx } from "@/storage/inTx";
import { feedPostToUser } from "@/app/feed/feedPostToUser";

interface WorkspaceCreateParams {
    name: string;
    branchName: string;
}

interface WorkspaceRecord {
    id: string;
    name: string;
    projectId: string;
    accountId: string;
    branchName: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Create a workspace record for a project.
 * Caller must be at least an editor on the project.
 * Branch name uniqueness is enforced per project.
 * Notifies the project owner (if not the creator) via feed post.
 */
export async function workspaceCreate(
    ctx: Context,
    projectId: string,
    params: WorkspaceCreateParams
): Promise<Result<WorkspaceRecord>> {
    return inTx(async (tx) => {
        const hasAccess = await hasProjectRole(tx, projectId, ctx.uid, 'editor');
        if (!hasAccess) {
            return { ok: false, error: 'access-denied' as const };
        }

        const existing = await tx.workspace.findUnique({
            where: { projectId_branchName: { projectId, branchName: params.branchName } }
        });
        if (existing) {
            return { ok: false, error: 'branch-exists' as const };
        }

        const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { accountId: true, name: true }
        });
        const creator = await tx.account.findUnique({
            where: { id: ctx.uid },
            select: { username: true }
        });

        const workspace = await tx.workspace.create({
            data: {
                name: params.name,
                projectId,
                accountId: ctx.uid,
                branchName: params.branchName,
                status: 'active'
            }
        });

        if (project) {
            await feedPostToUser(tx, project.accountId, {
                kind: 'workspace_created',
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                projectId,
                projectName: project.name,
                creatorUsername: creator?.username ?? null,
            }, { excludeUserId: ctx.uid });
        }

        return { ok: true, value: workspace };
    });
}
