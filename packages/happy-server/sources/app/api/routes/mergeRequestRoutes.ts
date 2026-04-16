import { z } from "zod";
import { Fastify } from "../types";
import { Context } from "@/context";
import { mergeRequestCreate } from "@/app/project/mergeRequestCreate";
import { mergeRequestList } from "@/app/project/mergeRequestList";
import { mergeRequestGet } from "@/app/project/mergeRequestGet";
import { mergeRequestUpdateStatus } from "@/app/project/mergeRequestUpdateStatus";
import { mergeRequestCommentAdd } from "@/app/project/mergeRequestCommentAdd";
import { ProjectError } from "@/app/project/types";

/**
 * Merge request routes: create, list, get, update status, add comment.
 */
export function mergeRequestRoutes(app: Fastify) {

    app.post('/v1/projects/:id/merge-requests', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                title: z.string(),
                description: z.string().default(''),
                workspaceId: z.string(),
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await mergeRequestCreate(ctx, {
            projectId: request.params.id,
            title: request.body.title,
            description: request.body.description,
            workspaceId: request.body.workspaceId,
        });
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ mergeRequest: formatMR(result.value) });
    });

    app.get('/v1/projects/:id/merge-requests', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await mergeRequestList(ctx, request.params.id);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ mergeRequests: result.value });
    });

    app.get('/v1/merge-requests/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await mergeRequestGet(ctx, request.params.id);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ mergeRequest: result.value });
    });

    app.post('/v1/merge-requests/:id/status', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                status: z.enum(['open', 'approved', 'merged', 'closed'])
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await mergeRequestUpdateStatus(ctx, request.params.id, request.body.status);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send(result.value);
    });

    app.post('/v1/merge-requests/:id/comments', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                body: z.string(),
                filePath: z.string().optional(),
                lineNumber: z.number().optional(),
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await mergeRequestCommentAdd(ctx, {
            mergeRequestId: request.params.id,
            body: request.body.body,
            filePath: request.body.filePath,
            lineNumber: request.body.lineNumber,
        });
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ comment: result.value });
    });
}

function formatMR(mr: {
    id: string;
    title: string;
    description: string;
    projectId: string;
    workspaceId: string;
    authorId: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: mr.id,
        title: mr.title,
        description: mr.description,
        projectId: mr.projectId,
        workspaceId: mr.workspaceId,
        authorId: mr.authorId,
        status: mr.status,
        createdAt: mr.createdAt.getTime(),
        updatedAt: mr.updatedAt.getTime(),
    };
}

function errorToStatus(error: ProjectError): number {
    switch (error) {
        case 'merge-request-not-found':
        case 'workspace-not-found':
        case 'project-not-found':
            return 404;
        case 'access-denied':
        case 'not-owner':
            return 403;
        case 'merge-request-not-open':
            return 400;
        case 'merge-conflict':
            return 409;
        default:
            return 400;
    }
}
