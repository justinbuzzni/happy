export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProjectRole = typeof PROJECT_ROLES[number];

export const INVITE_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type InviteStatus = typeof INVITE_STATUSES[number];

export interface ProjectMemberInfo {
    id: string;
    projectId: string;
    accountId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    avatar: unknown;
    role: ProjectRole;
    status: InviteStatus;
    createdAt: number;
}

export interface ProjectConfig {
    workspaceDir?: string;
    environmentVariables?: Record<string, string>;
    sandboxConfig?: {
        enabled: boolean;
        sessionIsolation: string;
        extraWritePaths: string[];
        denyReadPaths: string[];
        denyWritePaths: string[];
        networkMode: string;
        allowedDomains: string[];
    };
    devServerPort?: number;
    machineId?: string;
}

export type ProjectError =
    | 'project-not-found'
    | 'access-denied'
    | 'not-owner'
    | 'user-not-found'
    | 'self-invite'
    | 'already-member'
    | 'not-pending'
    | 'member-not-found'
    | 'cannot-delete-default'
    | 'workspace-not-found'
    | 'branch-exists'
    | 'merge-request-not-found'
    | 'merge-request-not-open'
    | 'merge-conflict'
    | 'id-taken';

export type Result<T> =
    | { ok: true; value: T }
    | { ok: false; error: ProjectError };
