/**
 * Single-writer ownership for a managed runtime's durable receipt store.
 *
 * Ownership is bound to a Linux abstract-namespace Unix socket. The kernel
 * releases an abstract socket the moment its holder dies, and the name has no
 * filesystem entry, so there is nothing to leave behind and nothing to guess
 * about. A second holder gets EADDRINUSE; there is no stale state to reclaim.
 *
 * This deliberately does not reuse `acquireDaemonLock` (persistence.ts). That
 * lock treats *every* failure of `process.kill(pid, 0)` as "the process is
 * gone" and unlinks the lock file — including EPERM, which means the holder is
 * alive but owned by another user. Under the UID separation this feature needs,
 * EPERM becomes the normal case and that lock would hand ownership to a second
 * writer. It stays as it is for BYOS; managed never calls it.
 *
 * Losing the lock is never inferred. If the socket cannot be bound and the
 * reason is not a live holder, the caller is told `unknown` and must refuse to
 * mutate rather than assume it may proceed.
 */

import net from 'node:net';

export type ManagedWriterLockOutcome =
    | { ok: true; release: () => Promise<void> }
    /** Another live process holds it. Never steal, never wait. */
    | { ok: false; reason: 'held' }
    /** Abstract sockets are Linux-only; managed runtimes are Linux. */
    | { ok: false; reason: 'unsupported-platform' }
    /** Anything else. The caller must fail closed, not assume ownership. */
    | { ok: false; reason: 'unknown'; detail: string };

export function managedWriterLockAddress(runtimeId: string): string {
    // Leading NUL selects the abstract namespace: no path, no permissions, no
    // residue after the holder exits.
    return `\0happy-managed-writer:${runtimeId}`;
}

export function isAbstractSocketSupported(platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'linux';
}

export async function acquireManagedWriterLock(input: {
    runtimeId: string;
    platform?: NodeJS.Platform;
}): Promise<ManagedWriterLockOutcome> {
    if (!isAbstractSocketSupported(input.platform ?? process.platform)) {
        return { ok: false, reason: 'unsupported-platform' };
    }

    const server = net.createServer();
    // A connection would mean someone dialled our lock address. We hold it for
    // the name, not for traffic, so anything that arrives is closed at once.
    server.on('connection', (socket) => socket.destroy());

    return new Promise<ManagedWriterLockOutcome>((resolve) => {
        let settled = false;
        const finish = (outcome: ManagedWriterLockOutcome) => {
            if (settled) return;
            settled = true;
            resolve(outcome);
        };

        server.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                finish({ ok: false, reason: 'held' });
                return;
            }
            finish({ ok: false, reason: 'unknown', detail: error.code ?? error.message });
        });

        server.listen(managedWriterLockAddress(input.runtimeId), () => {
            // The lock must not keep the daemon alive on its own.
            server.unref();
            finish({
                ok: true,
                release: () => new Promise<void>((done) => server.close(() => done())),
            });
        });
    });
}
