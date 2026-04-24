/**
 * Regression test for the preview route's content-type parser.
 *
 * The relay forwards the raw request body to the daemon as base64; that only
 * works if `request.body` arrives as a Buffer for every content-type — JSON
 * included. Fastify's `addContentTypeParser('*', …)` is a fallback, not an
 * override, so the built-in JSON parser would otherwise hand us a parsed
 * object and the relay would forward zero bytes (with Content-Length still
 * set), causing the upstream dev server to hang and the relay to 504.
 *
 * Mirrors the encapsulated-scope parser registration from previewRoutes.ts.
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

async function buildApp() {
    const app = Fastify();
    app.register(async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
            done(null, body);
        });
        scope.route({
            method: ['POST', 'PUT', 'PATCH'],
            url: '/echo-body-meta',
            handler: async (request, reply) => {
                const body = request.body as unknown;
                const isBuffer = Buffer.isBuffer(body);
                const length = isBuffer ? (body as Buffer).length : null;
                return reply.send({ isBuffer, length });
            },
        });
    });
    await app.ready();
    return app;
}

describe('preview route content-type parser', () => {
    it('delivers application/json bodies as a Buffer (not a parsed object)', async () => {
        const app = await buildApp();
        const payload = Buffer.from(JSON.stringify({ text: 'add me' }), 'utf-8');
        const res = await app.inject({
            method: 'POST',
            url: '/echo-body-meta',
            headers: { 'content-type': 'application/json' },
            payload,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ isBuffer: true, length: payload.length });
        await app.close();
    });

    it('delivers application/x-www-form-urlencoded as a Buffer', async () => {
        const app = await buildApp();
        const payload = Buffer.from('text=add+me&done=false', 'utf-8');
        const res = await app.inject({
            method: 'POST',
            url: '/echo-body-meta',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            payload,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ isBuffer: true, length: payload.length });
        await app.close();
    });

    it('delivers arbitrary content-types (text/plain) as a Buffer', async () => {
        const app = await buildApp();
        const payload = Buffer.from('hello', 'utf-8');
        const res = await app.inject({
            method: 'POST',
            url: '/echo-body-meta',
            headers: { 'content-type': 'text/plain' },
            payload,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ isBuffer: true, length: payload.length });
        await app.close();
    });
});
