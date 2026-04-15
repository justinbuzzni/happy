/**
 * Worker MCP Server for Orchestrator-Worker multi-agent pattern.
 *
 * Exposes spawn_worker, check_worker, get_worker_result tools via MCP.
 * The orchestrator Claude calls these tools to delegate work to specialized workers.
 * Workers are spawned as separate Claude Code SDK processes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { getWorkerProfile } from "./workerProfiles";
import type { WorkerTask, WorkerRole, SpawnWorkerInput } from "./types";

const VALID_ROLES: WorkerRole[] = ['coder', 'reviewer', 'tester', 'researcher'];

interface WorkerMcpOptions {
    cwd: string;
    workerModel: string;
    maxConcurrentWorkers: number;
    runWorker: (task: WorkerTask) => Promise<string>;
}

export function createWorkerMcpServer(options: WorkerMcpOptions): McpServer {
    const tasks = new Map<string, WorkerTask>();
    let activeWorkerCount = 0;

    const mcp = new McpServer({
        name: "Happy Worker Orchestrator",
        version: "1.0.0",
    });

    mcp.registerTool('spawn_worker', {
        description: 'Spawn a specialized worker agent to handle a subtask. Workers run independently and can execute in parallel.',
        title: 'Spawn Worker Agent',
        inputSchema: {
            role: z.enum(['coder', 'reviewer', 'tester', 'researcher'])
                .describe('Worker role: coder (write code), reviewer (review code), tester (write/run tests), researcher (search/investigate)'),
            task: z.string().describe('Clear task description for the worker. Be specific about objectives, boundaries, and expected output format.'),
            context: z.string().optional().describe('Additional context: file paths, code snippets, or constraints the worker needs.'),
        },
    }, async (args) => {
        if (activeWorkerCount >= options.maxConcurrentWorkers) {
            return {
                content: [{ type: 'text', text: `Cannot spawn worker: max concurrent workers (${options.maxConcurrentWorkers}) reached. Wait for existing workers to complete.` }],
                isError: true,
            };
        }

        const taskId = randomUUID().slice(0, 8);
        const profile = getWorkerProfile(args.role as WorkerRole);

        const task: WorkerTask = {
            id: taskId,
            workerRole: args.role as WorkerRole,
            prompt: args.task,
            context: args.context,
            status: 'running',
            startedAt: Date.now(),
        };

        tasks.set(taskId, task);
        activeWorkerCount++;

        logger.debug(`[WorkerMCP] Spawning ${args.role} worker ${taskId}: ${args.task.slice(0, 100)}`);

        Promise.resolve().then(() => options.runWorker(task)).then((result) => {
            task.status = 'complete';
            task.result = result;
            task.completedAt = Date.now();
            activeWorkerCount--;
            logger.debug(`[WorkerMCP] Worker ${taskId} completed in ${task.completedAt - task.startedAt!}ms`);
        }).catch((error) => {
            task.status = 'failed';
            task.error = error instanceof Error ? error.message : String(error);
            task.completedAt = Date.now();
            activeWorkerCount--;
            logger.debug(`[WorkerMCP] Worker ${taskId} failed: ${task.error}`);
        }).finally(() => {
            // Clean up completed tasks after 5 minutes to prevent unbounded memory growth
            setTimeout(() => { tasks.delete(taskId); }, 5 * 60 * 1000);
        });

        return {
            content: [{ type: 'text', text: JSON.stringify({ workerId: taskId, role: args.role, status: 'running' }) }],
            isError: false,
        };
    });

    mcp.registerTool('check_worker', {
        description: 'Check the status of a spawned worker agent.',
        title: 'Check Worker Status',
        inputSchema: {
            workerId: z.string().describe('The worker ID returned by spawn_worker'),
        },
    }, async (args) => {
        const task = tasks.get(args.workerId);
        if (!task) {
            return {
                content: [{ type: 'text', text: `Worker ${args.workerId} not found.` }],
                isError: true,
            };
        }

        const elapsed = task.startedAt ? Date.now() - task.startedAt : 0;
        return {
            content: [{ type: 'text', text: JSON.stringify({
                workerId: args.workerId,
                role: task.workerRole,
                status: task.status,
                elapsedMs: elapsed,
            }) }],
            isError: false,
        };
    });

    mcp.registerTool('get_worker_result', {
        description: 'Get the result from a completed worker agent. Returns the worker output or error.',
        title: 'Get Worker Result',
        inputSchema: {
            workerId: z.string().describe('The worker ID returned by spawn_worker'),
        },
    }, async (args) => {
        const task = tasks.get(args.workerId);
        if (!task) {
            return {
                content: [{ type: 'text', text: `Worker ${args.workerId} not found.` }],
                isError: true,
            };
        }

        if (task.status === 'running' || task.status === 'pending') {
            return {
                content: [{ type: 'text', text: JSON.stringify({ workerId: args.workerId, status: task.status, message: 'Worker is still running. Use check_worker to poll status.' }) }],
                isError: false,
            };
        }

        if (task.status === 'failed') {
            return {
                content: [{ type: 'text', text: `Worker ${args.workerId} failed: ${task.error}` }],
                isError: true,
            };
        }

        return {
            content: [{ type: 'text', text: task.result || '(empty result)' }],
            isError: false,
        };
    });

    return mcp;
}

export const ORCHESTRATOR_SYSTEM_PROMPT = [
    'You have access to worker agents for complex tasks. Delegate subtasks to specialized workers:',
    '- spawn_worker(role="coder") — Code generation and modification',
    '- spawn_worker(role="reviewer") — Code review, quality analysis, bug detection',
    '- spawn_worker(role="tester") — Test writing and execution',
    '- spawn_worker(role="researcher") — Web search, documentation research',
    '',
    'Workflow:',
    '1. Analyze the task and decide which workers to spawn (can be parallel)',
    '2. Use spawn_worker with clear task descriptions and context',
    '3. Use check_worker to poll worker status',
    '4. Use get_worker_result to collect completed work',
    '5. Synthesize all worker outputs into a coherent response for the user',
    '',
    'Give each worker a focused, unambiguous task. Include relevant file paths and context.',
].join('\n');
