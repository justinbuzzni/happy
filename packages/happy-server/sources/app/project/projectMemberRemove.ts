import { Context } from "@/context";
import { inTx } from "@/storage/inTx";
import { Result } from "./types";
import { getProjectAsOwner } from "./projectAccessCheck";

/**
 * Remove a member from a project.
 * Owner can remove any member. Members can remove themselves (leave).
 */
export async function projectMemberRemove(
    ctx: Context,
    projectId: string,
    memberId: string
): Promise<Result<true>> {
    return await inTx(async (tx) => {
        const member = await tx.projectMember.findUnique({
            where: { id: memberId }
        });
        if (!member || member.projectId !== projectId) {
            return { ok: false, error: 'member-not-found' };
        }

        const isSelf = member.accountId === ctx.uid;
        if (!isSelf) {
            const projectResult = await getProjectAsOwner(tx, projectId, ctx.uid);
            if (!projectResult.ok) {
                return projectResult;
            }
        }

        await tx.projectMember.delete({
            where: { id: memberId }
        });

        return { ok: true, value: true };
    });
}
