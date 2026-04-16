import * as z from "zod";

export const FeedBodySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('friend_request'), uid: z.string() }),
    z.object({ kind: z.literal('friend_accepted'), uid: z.string() }),
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({
        kind: z.literal('mr_created'),
        mergeRequestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        title: z.string(),
        authorUsername: z.string().nullable()
    }),
    z.object({
        kind: z.literal('mr_approved'),
        mergeRequestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        title: z.string(),
        actorUsername: z.string().nullable()
    }),
    z.object({
        kind: z.literal('mr_merged'),
        mergeRequestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        title: z.string(),
        actorUsername: z.string().nullable()
    }),
    z.object({
        kind: z.literal('mr_comment'),
        mergeRequestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        title: z.string(),
        commentBody: z.string(),
        authorUsername: z.string().nullable()
    }),
    z.object({
        kind: z.literal('workspace_created'),
        workspaceId: z.string(),
        workspaceName: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        creatorUsername: z.string().nullable()
    })
]);

export type FeedBody = z.infer<typeof FeedBodySchema>;

export interface UserFeedItem {
    id: string;
    userId: string;
    repeatKey: string | null;
    body: FeedBody;
    createdAt: number;
    cursor: string;
}

export interface FeedCursor {
    before?: string;
    after?: string;
}

export interface FeedOptions {
    limit?: number;
    cursor?: FeedCursor;
}

export interface FeedResult {
    items: UserFeedItem[];
    hasMore: boolean;
}