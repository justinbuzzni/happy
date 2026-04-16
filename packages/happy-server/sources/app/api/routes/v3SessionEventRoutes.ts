import { persistSessionEvent } from "@/app/events/persistSessionEvent";
import { SESSION_EVENT_TYPES, type SessionEventType } from "@/app/events/sessionEventTypes";
import { db } from "@/storage/db";
import { z } from "zod";
import { type Fastify } from "../types";

const validEventTypes = Object.values(SESSION_EVENT_TYPES) as [string, ...string[]];

const sendEventBodySchema = z.object({
    eventType: z.enum(validEventTypes),
    content: z.string(),
});

export const getEventsQuerySchema = z
    .object({
        after_seq: z.coerce.number().int().min(0).default(0),
        before_seq: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        type: z.string().optional(),
        order: z.enum(['asc', 'desc']).default('asc'),
    })
    .refine(
        // `after_seq` defaults to 0, so treat "explicitly > 0 AND before_seq set" as the ambiguous case.
        // Sending both cursors at once leaves the filter direction undefined; callers must pick one.
        (q) => !(q.after_seq > 0 && q.before_seq !== undefined),
        { message: 'after_seq and before_seq cannot be combined' },
    );

interface SelectedEvent {
    id: string;
    eventType: string;
    seq: number;
    content: unknown;
    createdAt: Date;
    updatedAt: Date;
}

function toResponseEvent(event: SelectedEvent) {
    return {
        id: event.id,
        eventType: event.eventType,
        seq: event.seq,
        content: event.content,
        createdAt: event.createdAt.getTime(),
        updatedAt: event.updatedAt.getTime(),
    };
}

export function v3SessionEventRoutes(app: Fastify) {
    app.get('/v3/sessions/:sessionId/events', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            querystring: getEventsQuerySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { after_seq, before_seq, limit, type, order } = request.query;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId,
            },
            select: { id: true },
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const where: {
            sessionId: string;
            seq: { gt: number } | { lt: number };
            eventType?: string;
        } = {
            sessionId,
            seq: before_seq !== undefined ? { lt: before_seq } : { gt: after_seq },
        };
        if (type) {
            where.eventType = type;
        }

        const events = await db.sessionEvent.findMany({
            where,
            orderBy: { seq: order },
            take: limit + 1,
            select: {
                id: true,
                eventType: true,
                seq: true,
                content: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        const hasMore = events.length > limit;
        const page = hasMore ? events.slice(0, limit) : events;

        return reply.send({
            events: page.map(toResponseEvent),
            hasMore,
        });
    });

    app.post('/v3/sessions/:sessionId/events', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: sendEventBodySchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { eventType, content } = request.body;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId,
            },
            select: { id: true },
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const event = await persistSessionEvent({
            sessionId,
            eventType: eventType as SessionEventType,
            content,
        });

        return reply.send({
            event: {
                id: event.id,
                seq: event.seq,
                createdAt: event.createdAt.getTime(),
            },
        });
    });
}
