import fastify from "fastify";
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { pushRoutes } from "./routes/pushRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { devRoutes } from "./routes/devRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { voiceRoutes } from "./routes/voiceRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { machineSessionOwnerRoutes } from "./routes/machineSessionOwnerRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication, enableSessionScopeAuthentication } from "./utils/enableAuthentication";
import { userRoutes } from "./routes/userRoutes";
import { feedRoutes } from "./routes/feedRoutes";
import { internalFeedRoutes } from "./routes/internalFeedRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { v3SessionRoutes } from "./routes/v3SessionRoutes";
import { sessionRewrapRoutes } from "./routes/sessionRewrapRoutes";
import { v3SessionEventRoutes } from "./routes/v3SessionEventRoutes";
import { projectRoutes } from "./routes/projectRoutes";
import { projectMemberRoutes } from "./routes/projectMemberRoutes";
import { workspaceRoutes } from "./routes/workspaceRoutes";
import { mergeRequestRoutes } from "./routes/mergeRequestRoutes";
import { previewRoutes } from "./routes/previewRoutes";
import { previewWebSocketRelay } from "@/modules/preview/previewWebSocketRelay";
import { parsePreviewHost } from "@/modules/preview/parsePreviewHost";
import { attachmentRoutes } from "./routes/attachmentRoutes";
import { automationRoutes } from "./routes/automationRoutes";
import { scriptAutomationRoutes } from "./routes/scriptAutomationRoutes";
import { startScriptInvocationMaintenance } from "@/app/automation/scriptInvocationMaintenance";
import { sessionFollowupRoutes } from "./routes/sessionFollowupRoutes";
import { agentProfileRoutes } from "./routes/agentProfileRoutes";
import { managedControlRoutes } from "./routes/managedControlRoutes";
import { managedApprovalRoutes } from "@/app/api/routes/managedApprovalRoutes";
import { managedDaemonRenewRoutes } from '@/app/api/routes/managedDaemonRenewRoutes';
import { createManagedControlRuntime, type ManagedControlRuntime } from "@/app/managed/managedControlRuntime";
import {
    activateManagedStorage,
    assertPrivateRootIsolated,
    setManagedBucket,
} from "@/app/managed/managedAttachmentStorage";
import { isLocalStorage, getLocalFilesDir, getManagedFilesDir } from "@/storage/files";
import * as path from "path";
import * as fs from "fs";
import { startUsageOutboxWorker } from "@/app/usage/usageOutbox";

export interface StartApiOptions {
    port?: number;
    host?: string;
    staticDir?: string;
    injectHtmlConfig?: Record<string, unknown>;
}

export async function startApi(opts: StartApiOptions = {}) {

    // Configure
    log('Starting API...');
    const usageIngestUrl = process.env.SAYCODE_USAGE_INGEST_URL;
    const usageIngestSecret = process.env.SAYCODE_USAGE_INGEST_SECRET;
    if (!!usageIngestUrl !== !!usageIngestSecret) {
        throw new Error('SAYCODE_USAGE_INGEST_URL and SAYCODE_USAGE_INGEST_SECRET must be configured together');
    }

    // Start API
    const app = fastify({
        loggerInstance: logger,
        // specs/happy-server-log-volume — Fastify 기본 요청 로그는 요청당 16줄
        // (incoming request + request completed)을 남겨 전체 로그의 73% 를
        // 차지했다. pino-pretty 가 동기 in-process 스트림이라 그 비용이 요청
        // 처리와 같은 이벤트 루프에 얹힌다. 대체재는 enableMonitoring 의
        // onResponse 훅 — Prometheus 로 전량 집계하고, 5xx/느린 요청만 한 줄
        // 남긴다.
        disableRequestLogging: true,
        bodyLimit: 1024 * 1024 * 100, // 100MB,
        // specs/preview-iframe-origin-isolation-subdomain Phase 3 fix —
        // Fastify lifecycle runs routing BEFORE onRequest hooks, so a hook
        // that mutates `request.raw.url` cannot redirect routing decisions.
        // rewriteUrl runs *before* the router, which is what we need: when
        // the iframe Host is `<mid>-<port>.preview.<zone>`, rewrite the URL
        // into the canonical `/v1/preview/{mid}/{port}/<app-path>` shape
        // so the existing preview route picks it up.
        rewriteUrl: (req) => {
            const host = req.headers.host;
            const parsed = parsePreviewHost(host);
            if (!parsed) return req.url ?? '/';
            const url = req.url ?? '/';
            const qIdx = url.indexOf('?');
            const rawPath = qIdx >= 0 ? url.slice(0, qIdx) : url;
            const search = qIdx >= 0 ? url.slice(qIdx) : '';
            const trimmed = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
            return `/v1/preview/${parsed.machineId}/${parsed.port}/${trimmed}${search}`;
        },
    });
    app.register(import('@fastify/cors'), {
        origin: '*',
        allowedHeaders: '*',
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    });

    // Required for local-mode attachment uploads (PUT /v1/sessions/:id/attachments/:file).
    // Fastify v5 rejects unknown media types with 415 before reaching the handler.
    app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer' },
        (_req, body, done) => done(null, body),
    );

    // Root handler — when not serving a static webapp, return a banner.
    // When serving a static webapp, @fastify/static handles `/` via its index.
    if (!opts.staticDir) {
        app.get('/', function (request, reply) {
            reply.send('Welcome to Happy Server!');
        });
    }

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed, { skipNotFoundHandler: !!opts.staticDir });
    enableAuthentication(typed);

    // Serve local files when using local storage
    if (isLocalStorage()) {
        app.get('/files/*', function (request, reply) {
            const filePath = (request.params as any)['*'];
            const baseDir = path.resolve(getLocalFilesDir());
            const fullPath = path.resolve(baseDir, filePath);
            if (!fullPath.startsWith(baseDir + path.sep)) {
                reply.code(403).send('Forbidden');
                return;
            }
            if (!fs.existsSync(fullPath)) {
                reply.code(404).send('Not found');
                return;
            }
            const stream = fs.createReadStream(fullPath);
            reply.send(stream);
        });
    }

    // Managed control is off unless the deployment configures verification
    // keys; `createManagedControlRuntime` returns null when it has not, and the
    // routes then refuse rather than falling back to the account bearer.
    const managedControl: ManagedControlRuntime | null = await createManagedControlRuntime(process.env);

    // The one configured issuer, handed to the session-data decorator. Building
    // a second here would verify against a second key.
    enableSessionScopeAuthentication(typed, () => managedControl?.scopedTokens ?? null);

    // Routes
    managedControlRoutes(typed, () => managedControl);
    // The credential-recovery half of the same control plane: it extends or
    // re-reads a daemon grant that already exists and never touches machine key
    // material, so it is signed for under its own operations.
    managedDaemonRenewRoutes(typed, () => managedControl);
    // Answering a permission prompt from a browser. It needs the session-scope
    // decorator enabled above, and nothing from the control runtime: the
    // bearer it accepts is a managed one, not a control-plane assertion.
    managedApprovalRoutes(typed);
    authRoutes(typed);
    pushRoutes(typed);
    sessionRoutes(typed);
    accountRoutes(typed);
    agentProfileRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    machineSessionOwnerRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    voiceRoutes(typed);
    userRoutes(typed);
    feedRoutes(typed);
    internalFeedRoutes(typed);
    kvRoutes(typed);
    v3SessionRoutes(typed);
    sessionRewrapRoutes(typed);
    v3SessionEventRoutes(typed);
    projectRoutes(typed);
    projectMemberRoutes(typed);
    workspaceRoutes(typed);
    mergeRequestRoutes(typed);
    previewRoutes(typed);
    // The same initialized runtime the scoped-token decorator uses. Building a
    // second here would derive a second key and publish a second origin.
    //
    // Storage is a separate gate: the relay only runs once the private root is
    // provably distinct from the public one, and — on an object store — the
    // managed bucket has been seen to carry no policy at all. Anything less
    // than that leaves the relay off rather than pointed somewhere public.
    let managedStorageReady = false;
    if (managedControl) {
        assertPrivateRootIsolated(getLocalFilesDir(), getManagedFilesDir());
        const activation = await activateManagedStorage(process.env);
        if (activation.ok) {
            managedStorageReady = true;
            setManagedBucket(activation.mode === 's3' ? activation.bucket : null);
        } else {
            log({ module: 'managed-attachments', level: 'error' },
                `Managed attachment storage inactive (${activation.reason})`);
        }
    }
    attachmentRoutes(typed, () => (managedStorageReady ? managedControl : null));
    automationRoutes(typed);
    scriptAutomationRoutes(typed);
    sessionFollowupRoutes(typed);

    // Static webapp (self-host mode)
    if (opts.staticDir) {
        const fastifyStatic = (await import('@fastify/static')).default;
        const injectScript = opts.injectHtmlConfig
            ? `<script>window.__HAPPY_CONFIG__ = ${JSON.stringify(opts.injectHtmlConfig)};</script>`
            : null;
        app.register(fastifyStatic, {
            root: opts.staticDir,
            prefix: '/',
            decorateReply: false,
            // SPA fallback — if file not found, serve index.html
            wildcard: false,
        });
        if (injectScript) {
            app.addHook('onSend', async (request, reply, payload) => {
                const url = request.raw.url || '';
                const isIndex = url === '/' || url === '/index.html' || url.startsWith('/?');
                if (!isIndex) return payload;
                const contentType = reply.getHeader('content-type');
                if (typeof contentType !== 'string' || !contentType.includes('text/html')) return payload;
                let html: string;
                if (typeof payload === 'string') {
                    html = payload;
                } else if (Buffer.isBuffer(payload)) {
                    html = payload.toString('utf8');
                } else if (payload && typeof (payload as any).pipe === 'function') {
                    // stream — read it
                    const chunks: Buffer[] = [];
                    for await (const chunk of payload as any) {
                        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                    }
                    html = Buffer.concat(chunks).toString('utf8');
                } else {
                    return payload;
                }
                const injected = html.replace(/<head[^>]*>/i, (m) => `${m}\n${injectScript}`);
                reply.header('content-length', Buffer.byteLength(injected));
                return injected;
            });
        }
        // SPA fallback: serve index.html for any unmatched GET that looks like a route.
        app.setNotFoundHandler(async (request, reply) => {
            const url = request.raw.url || '';
            // Don't fall through for API/socket/files paths
            if (request.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
            if (url.startsWith('/v1') || url.startsWith('/v3') || url.startsWith('/socket') ||
                url.startsWith('/files/') || url.startsWith('/metrics') || url.startsWith('/health')) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const indexPath = path.join(opts.staticDir!, 'index.html');
            if (!fs.existsSync(indexPath)) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const html = fs.readFileSync(indexPath, 'utf8');
            const injected = injectScript ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${injectScript}`) : html;
            reply.type('text/html').send(injected);
        });
    }

    // Start HTTP
    const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3005);
    const host = opts.host ?? '0.0.0.0';
    await app.listen({ port, host });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(typed, managedControl);

    // Preview WebSocket relay — must attach after startSocket so engine.io's
    // upgrade listener is already in place (they coexist on app.server; see
    // previewWebSocketRelay.ts). Handles /v1/preview/:machineId/:port/* upgrades.
    previewWebSocketRelay(typed);

    if (usageIngestUrl && usageIngestSecret) {
        const usageOutboxWorker = startUsageOutboxWorker({
            endpoint: usageIngestUrl,
            secret: usageIngestSecret,
        });
        onShutdown('usage-outbox', async () => {
            usageOutboxWorker.stop();
        });
    }

    // End
    if (process.env.HAPPY_SCRIPT_AUTOMATIONS_ENABLED === '1') {
        const scriptMaintenance = startScriptInvocationMaintenance();
        onShutdown('script-invocation-maintenance', () => scriptMaintenance.stop());
    }
    log(`API ready on http://${host}:${port}`);
    return { port, host };
}
