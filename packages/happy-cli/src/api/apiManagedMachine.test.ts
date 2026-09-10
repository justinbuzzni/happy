/**
 * The client a managed runtime's daemon uses for the Machine it already is.
 *
 * Every control here is about a capability this principal must **not** have.
 * The parent registered this Machine with key material the server keeps
 * write-once; a runtime that registered again, derived its own key, pushed to
 * the account, or synthesised a local Machine when the server was unreachable
 * would each break something that cannot be repaired afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApiClient } from '@/api/api';
import { configuration } from '@/configuration';
import { encodeBase64, encrypt } from '@/api/encryption';

const MACHINE_ID = 'machine-1';
const MACHINE_KEY = new Uint8Array(32).fill(7);

let server: Server;
let requests: Array<{ method: string; url: string; authorization: string | undefined }>;
let respond: (url: string) => { status: number; body: unknown };
let originalUrl: string;

function client() {
    return ApiClient.managedMachine({
        machineId: MACHINE_ID,
        token: 'daemon.scoped.bearer',
        machineKey: MACHINE_KEY,
        serverOrigin: new URL(configuration.serverUrl).origin,
    });
}

beforeEach(async () => {
    requests = [];
    respond = () => ({ status: 200, body: { machine: machineRow() } });
    server = createServer((req, res) => {
        requests.push({
            method: req.method ?? '',
            url: req.url ?? '',
            authorization: req.headers.authorization,
        });
        const answer = respond(req.url ?? '');
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    originalUrl = configuration.serverUrl;
    (configuration as { serverUrl: string }).serverUrl =
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    (configuration as { serverUrl: string }).serverUrl = originalUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function machineRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: MACHINE_ID,
        metadata: encodeBase64(encrypt(MACHINE_KEY, 'dataKey', { host: 'runtime' })),
        metadataVersion: 3,
        daemonState: null,
        daemonStateVersion: 0,
        ...over,
    };
}

describe('a managed runtime attaching to the Machine the parent registered', () => {
    it('reads the machine and decrypts it with the key the parent provided', async () => {
        const machine = await client().attachRegisteredMachine();
        expect(machine).toMatchObject({
            id: MACHINE_ID,
            encryptionVariant: 'dataKey',
            metadata: { host: 'runtime' },
            metadataVersion: 3,
        });
        expect(machine.encryptionKey).toEqual(MACHINE_KEY);
        // A read, not a registration.
        expect(requests.map((entry) => entry.method)).toEqual(['GET']);
        expect(requests[0].url).toContain(`/v1/machines/${MACHINE_ID}`);
        expect(requests[0].authorization).toBe('Bearer daemon.scoped.bearer');
    });

    it('refuses to register a machine of its own', async () => {
        // The server treats the key material as write-once. Registering again
        // is at best a no-op and at worst replaces what the parent stored —
        // after which nothing can read this machine.
        await expect(client().getOrCreateMachine({
            machineId: MACHINE_ID,
            metadata: { host: 'runtime' } as never,
        })).rejects.toThrow(/does not register its own machine/);
        expect(requests).toHaveLength(0);
    });

    it('refuses a response describing another machine', async () => {
        // The one case where continuing attaches this runtime to somebody
        // else's Machine, so the id is compared rather than adopted.
        respond = () => ({ status: 200, body: { machine: machineRow({ id: 'machine-2' }) } });
        await expect(client().attachRegisteredMachine()).rejects.toThrow(/different machine/);
    });

    it('does not synthesise a machine when the server cannot be reached', async () => {
        // The ordinary path may build a local Machine offline, which is right
        // for a laptop. Here it would make the runtime answer the parent about
        // a registration that does not exist.
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await expect(client().attachRegisteredMachine()).rejects.toThrow();
    });

    it('refuses a credential issued for another server', async () => {
        /*
         * The credential names the Happy that issued it, and this process talks
         * to whatever `configuration.serverUrl` says. If those differ, the
         * bearer is about to be sent to a host of somebody else's choosing —
         * so it is refused **before** the first request, not after a failure
         * that would look like a network problem.
         */
        expect(() => ApiClient.managedMachine({
            machineId: MACHINE_ID,
            token: 'daemon.scoped.bearer',
            machineKey: MACHINE_KEY,
            serverOrigin: 'https://another-happy.example.test',
        })).toThrow(/issued for a different server/);
        expect(requests).toHaveLength(0);
    });

    it('refuses to attach when the principal is not a managed runtime', async () => {
        const account = await ApiClient.create({
            token: 'account.bearer',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        });
        await expect(account.attachRegisteredMachine())
            .rejects.toThrow(/needs a managed runtime credential/);
    });

    it('registers no push receiver for the account', async () => {
        // Its bearer is scoped to this machine; pushing from it would put
        // runtime activity into the person's notification stream.
        const machine = client() as unknown as { pushClient: unknown };
        expect(machine.pushClient).toBeNull();
    });
});
