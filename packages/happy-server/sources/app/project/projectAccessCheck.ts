import { Project } from "@prisma/client";
import { Result } from "./types";

type Tx = {
    project: { findUnique: Function };
    projectMember: { findUnique: Function };
};

/**
 * Check if a user has at least the given role on a project.
 * The project creator (accountId) is always treated as owner.
 */
export async function hasProjectRole(
    tx: Tx,
    projectId: string,
    userId: string,
    requiredRole: 'owner' | 'editor' | 'viewer'
): Promise<boolean> {
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project) {
        return false;
    }

    // Project creator is always owner
    if (project.accountId === userId) {
        return true;
    }

    const member = await tx.projectMember.findUnique({
        where: { projectId_accountId: { projectId, accountId: userId } }
    });
    if (!member) {
        return false;
    }

    return roleAtLeast(member.role, requiredRole);
}

/**
 * Load project and verify caller is owner.
 * Distinguishes 'project-not-found' from 'not-owner' so callers can surface
 * the right error to the UI (and so the web-ui's lazy-backfill flow can
 * detect a missing happy-server project and create it).
 */
export async function getProjectAsOwner(
    tx: Tx,
    projectId: string,
    userId: string
): Promise<Result<Project>> {
    const project = await tx.project.findUnique({ where: { id: projectId } }) as Project | null;
    if (!project) {
        return { ok: false, error: 'project-not-found' };
    }

    if (project.accountId === userId) {
        return { ok: true, value: project };
    }

    const member = await tx.projectMember.findUnique({
        where: { projectId_accountId: { projectId, accountId: userId } }
    });
    if (member?.role === 'owner') {
        return { ok: true, value: project };
    }

    return { ok: false, error: 'not-owner' };
}

const ROLE_LEVEL: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };

function roleAtLeast(actual: string, required: string): boolean {
    return (ROLE_LEVEL[actual] ?? -1) >= (ROLE_LEVEL[required] ?? 99);
}
