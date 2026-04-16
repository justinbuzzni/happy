import { FeedBody } from "./types";
import { afterTx, Tx } from "@/storage/inTx";
import { allocateUserSeq } from "@/storage/seq";
import { eventRouter, buildNewFeedPostUpdate } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

/**
 * Add a feed post to a target user (not the caller).
 * Used for collaboration notifications where one user's action notifies others.
 * Skips if targetUserId equals excludeUserId (typically the actor).
 */
export async function feedPostToUser(
    tx: Tx,
    targetUserId: string,
    body: FeedBody,
    options?: { repeatKey?: string; excludeUserId?: string }
): Promise<void> {
    if (options?.excludeUserId && targetUserId === options.excludeUserId) {
        return;
    }

    if (options?.repeatKey) {
        await tx.userFeedItem.deleteMany({
            where: { userId: targetUserId, repeatKey: options.repeatKey }
        });
    }

    const user = await tx.account.update({
        where: { id: targetUserId },
        select: { feedSeq: true },
        data: { feedSeq: { increment: 1 } }
    });

    const item = await tx.userFeedItem.create({
        data: {
            counter: user.feedSeq,
            userId: targetUserId,
            repeatKey: options?.repeatKey ?? null,
            body: body
        }
    });

    afterTx(tx, async () => {
        const updateSeq = await allocateUserSeq(targetUserId);
        const updatePayload = buildNewFeedPostUpdate(
            { ...item, createdAt: item.createdAt.getTime(), cursor: '0-' + item.counter.toString(10) },
            updateSeq,
            randomKeyNaked(12)
        );

        eventRouter.emitUpdate({
            userId: targetUserId,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });
    });
}

/**
 * Broadcast a feed post to all members of a project (owner + accepted members).
 * Excludes the actor (who triggered the action).
 */
export async function feedPostToProjectMembers(
    tx: Tx,
    projectId: string,
    actorUserId: string,
    body: FeedBody
): Promise<void> {
    const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { accountId: true }
    });
    if (!project) return;

    const members = await tx.projectMember.findMany({
        where: { projectId, status: 'accepted' },
        select: { accountId: true }
    });

    const recipientIds = new Set<string>([project.accountId, ...members.map((m) => m.accountId)]);
    recipientIds.delete(actorUserId);

    for (const userId of recipientIds) {
        await feedPostToUser(tx, userId, body);
    }
}
