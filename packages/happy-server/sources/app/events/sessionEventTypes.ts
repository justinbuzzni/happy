export const SESSION_EVENT_TYPES = {
    SESSION_END: 'session-end',
    TOOL_CALL_START: 'tool-call-start',
    TOOL_CALL_END: 'tool-call-end',
    AGENT_THINKING: 'agent-thinking',
    AGENT_MESSAGE: 'agent-message',
    USAGE_REPORT: 'usage-report',
    ERROR: 'error',
    CHECKPOINT_SNAPSHOT: 'checkpoint-snapshot',
    CHECKPOINT_REWIND: 'checkpoint-rewind',
} as const;

export type SessionEventType = typeof SESSION_EVENT_TYPES[keyof typeof SESSION_EVENT_TYPES];
