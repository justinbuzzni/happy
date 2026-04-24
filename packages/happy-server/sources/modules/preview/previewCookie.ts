/**
 * Per-preview HTTP cookie helpers.
 *
 * Phase 9 of specs/remote-preview-relay moves the auth secret off the URL
 * (where it leaks via browser history / referrer / DevTools) into a
 * path-scoped, HttpOnly cookie. These utilities are intentionally pure and
 * free of fastify/reply plumbing so the matching unit tests don't need a
 * server harness.
 *
 * Name format: `happy_preview_{machineId}_{port}`.
 * Path scope:  `/v1/preview/{machineId}/{port}/`.
 *
 * The cookie value is the same signed ptoken the URL query carries — one
 * secret, two transports. `previewRoutes` accepts either.
 */

export function cookieName(machineId: string, port: number): string {
    return `happy_preview_${machineId}_${port}`;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readPreviewCookie(
    cookieHeader: string | undefined,
    machineId: string,
    port: number,
): string | null {
    if (!cookieHeader) return null;
    const name = cookieName(machineId, port);
    // Anchor on start-of-string or semicolon so a cookie whose name merely
    // *starts* with ours (e.g. `${name}_extra`) doesn't match.
    const re = new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=([^;]*)`);
    const m = cookieHeader.match(re);
    if (!m) return null;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        // Malformed URI encoding — treat as no cookie.
        return null;
    }
}

export interface BuildPreviewCookieOptions {
    /** HTTPS deploys must set true so browsers send the cookie over TLS.
     *  Default false for HTTP dev setups (Secure cookies would be dropped). */
    secure?: boolean;
    /** `Lax` (default, same-origin iframes), or `None` (cross-origin HTTPS
     *  iframes — requires Secure=true). `Strict` is not useful here. */
    sameSite?: 'Lax' | 'None' | 'Strict';
}

export function buildPreviewCookie(
    machineId: string,
    port: number,
    token: string,
    maxAgeSeconds: number,
    options: BuildPreviewCookieOptions = {},
): string {
    const sameSite = options.sameSite ?? 'Lax';
    const parts = [
        `${cookieName(machineId, port)}=${encodeURIComponent(token)}`,
        `Path=/v1/preview/${machineId}/${port}/`,
        `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
        'HttpOnly',
        `SameSite=${sameSite}`,
    ];
    if (options.secure) parts.push('Secure');
    return parts.join('; ');
}
