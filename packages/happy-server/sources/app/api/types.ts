import { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Principal } from "@/app/auth/sessionScopedToken";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { IncomingMessage, Server, ServerResponse } from "http";

export interface GitHubProfile {
    id: number;
    login: string;
    type: string;
    site_admin: boolean;
    avatar_url: string;
    gravatar_id: string | null;
    name: string | null;
    company: string | null;
    blog: string | null;
    location: string | null;
    email: string | null;
    hireable: boolean | null;
    bio: string | null;
    twitter_username: string | null;
    public_repos: number;
    public_gists: number;
    followers: number;
    following: number;
    created_at: string;
    updated_at: string;
    // Private user fields (only available when authenticated)
    private_gists?: number;
    total_private_repos?: number;
    owned_private_repos?: number;
    disk_usage?: number;
    collaborators?: number;
    two_factor_authentication?: boolean;
    plan?: {
        collaborators: number;
        name: string;
        space: number;
        private_repos: number;
    };
}

export interface GitHubOrg {

}

export type Fastify = FastifyInstance<
    Server<typeof IncomingMessage, typeof ServerResponse>,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    FastifyBaseLogger,
    ZodTypeProvider
>;

import type { LiveGrant } from '@/app/managed/managedSessionGrant';

declare module 'fastify' {
    interface FastifyRequest {
        userId: string;
        /**
         * Which kind of bearer made this request, as `auth.resolvePrincipal`
         * reported it.
         *
         * `userId` alone cannot answer that: a managed child acts *for* an
         * account, so both kinds end up with the same id. Anything whose
         * behaviour must differ — and anything that must refuse a child —
         * reads this rather than inferring from the id.
         *
         * Only routes that opted in via `authenticateSessionScope` can ever see
         * a managed principal; everywhere else `authenticate` rejects one.
         */
        principal?: Principal;
        /**
         * The grant row this request was authorised by, when a managed bearer
         * made it.
         *
         * Present only for managed principals, and only after the route, the
         * session and the grant were all checked. A handler reads it when the
         * answer belongs to *this bearer* rather than to the account it acts
         * for — the resealed key envelope of a viewer, for instance, which the
         * owner's envelope may never stand in for.
         */
        managedGrant?: LiveGrant;
        startTime?: number;
    }
    interface FastifyInstance {
        authenticate: any;
        /**
         * Accepts an account bearer exactly as `authenticate` does, and
         * additionally a managed session bearer whose grant is still live for
         * this specific request.
         */
        authenticateSessionScope: any;
    }
}
