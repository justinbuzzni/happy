import { Context } from "@/context";
import { Result } from "./types";
import { inTx } from "@/storage/inTx";

/**
 * Delete a workspace record atomically.
 * Only the workspace creator or project owner can delete.
 * Returns the deleted workspace's branchName for caller to clean up git.
 */
export async function workspaceDelete(
    ctx: Context,
    workspaceId: string
): Promise<Result<{ branchName: string; projectId: string }>> {
    return inTx(async (tx) => {
        const workspace = await tx.workspace.findUnique({
            where: { id: workspaceId },
            include: { project: { select: { accountId: true } } }
        });
        if (!workspace) {
            return { ok: false, error: 'workspace-not-found' as const };
        }

        const isOwnerOrCreator = workspace.accountId === ctx.uid || workspace.project.accountId === ctx.uid;
        if (!isOwnerOrCreator) {
            return { ok: false, error: 'access-denied' as const };
        }

        await tx.workspace.delete({ where: { id: workspaceId } });

        return { ok: true, value: { branchName: workspace.branchName, projectId: workspace.projectId } };
    });
}
