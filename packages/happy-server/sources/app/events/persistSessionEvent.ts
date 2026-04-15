import { db } from "@/storage/db";
import { allocateSessionEventSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import type { SessionEventType } from "@/app/events/sessionEventTypes";

export async function persistSessionEvent(params: {
    sessionId: string;
    eventType: SessionEventType;
    content: string;
}) {
    const { sessionId, eventType, content } = params;

    const seq = await allocateSessionEventSeq(sessionId);

    const event = await db.sessionEvent.create({
        data: {
            sessionId,
            eventType,
            seq,
            content: { t: 'encrypted', c: content },
        },
        select: {
            id: true,
            seq: true,
            createdAt: true,
        },
    });

    return event;
}
