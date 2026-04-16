import { Context } from "@/context";
import { Result } from "./types";
import { inTx } from "@/storage/inTx";

type WorkspaceStatus = 'active' | 'merged' | 'closed';

/**
 * Update workspace status atomically.
 * Only the workspace creator or project owner can change status.
 */
export async function workspaceUpdateStatus(
    ctx: Context,
    workspaceId: string,
    status: WorkspaceStatus
): Promise<Result<{ id: string; status: string }>> {
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

        const updated = await tx.workspace.update({
            where: { id: workspaceId },
            data: { status }
        });

        return { ok: true, value: { id: updated.id, status: updated.status } };
    });
}
