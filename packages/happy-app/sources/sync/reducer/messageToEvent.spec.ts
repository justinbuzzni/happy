import { describe, it, expect } from 'vitest';
import { NormalizedMessage } from '../typesRaw';
import { parseMessageAsEvent, shouldSkipNormalProcessing } from './messageToEvent';

function makeToolCallMessage(name: string, input: Record<string, unknown>): NormalizedMessage {
    return {
        id: 'msg1',
        localId: null,
        createdAt: 1000,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id: 'call1',
            name,
            input,
            description: null,
            uuid: 'uuid1',
            parentUUID: null
        }]
    };
}

describe('parseMessageAsEvent', () => {
    describe('mcp__happy__change_title', () => {
        it('should convert change_title tool call to message event', () => {
            const msg = makeToolCallMessage('mcp__happy__change_title', { title: 'My New Title' });
            const event = parseMessageAsEvent(msg);

            expect(event).not.toBeNull();
            expect(event!.type).toBe('message');
            if (event!.type === 'message') {
                expect(event!.message).toBe('Title changed to "My New Title"');
            }
        });

        it('should return null when title is missing', () => {
            const msg = makeToolCallMessage('mcp__happy__change_title', {});
            const event = parseMessageAsEvent(msg);
            expect(event).toBeNull();
        });

        it('should return null when title is not a string', () => {
            const msg = makeToolCallMessage('mcp__happy__change_title', { title: 123 });
            const event = parseMessageAsEvent(msg);
            expect(event).toBeNull();
        });

        it('should skip sidechain messages', () => {
            const msg = makeToolCallMessage('mcp__happy__change_title', { title: 'Title' });
            msg.isSidechain = true;
            const event = parseMessageAsEvent(msg);
            expect(event).toBeNull();
        });
    });

    describe('EnterPlanMode', () => {
        it('should convert EnterPlanMode tool call to message event', () => {
            const msg = makeToolCallMessage('EnterPlanMode', {});
            const event = parseMessageAsEvent(msg);

            expect(event).not.toBeNull();
            expect(event!.type).toBe('message');
            if (event!.type === 'message') {
                expect(event!.message).toBe('Entering plan mode');
            }
        });

        it('should convert enter_plan_mode tool call to message event', () => {
            const msg = makeToolCallMessage('enter_plan_mode', {});
            const event = parseMessageAsEvent(msg);

            expect(event).not.toBeNull();
            expect(event!.type).toBe('message');
        });
    });

    describe('limit-reached', () => {
        it('should convert limit reached text to limit-reached event', () => {
            const msg: NormalizedMessage = {
                id: 'msg1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Claude AI usage limit reached|1700000000',
                    uuid: 'uuid1',
                    parentUUID: null
                }]
            };
            const event = parseMessageAsEvent(msg);

            expect(event).not.toBeNull();
            expect(event!.type).toBe('limit-reached');
            if (event!.type === 'limit-reached') {
                expect(event!.endsAt).toBe(1700000000);
            }
        });
    });

    describe('unrelated messages', () => {
        it('should return null for regular tool calls', () => {
            const msg = makeToolCallMessage('Read', { file_path: '/foo.ts' });
            const event = parseMessageAsEvent(msg);
            expect(event).toBeNull();
        });

        it('should return null for user messages', () => {
            const msg: NormalizedMessage = {
                id: 'msg1',
                localId: null,
                createdAt: 1000,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: 'hello' }
            };
            const event = parseMessageAsEvent(msg);
            expect(event).toBeNull();
        });
    });
});

describe('shouldSkipNormalProcessing', () => {
    it('should return true for messages that convert to events', () => {
        const msg = makeToolCallMessage('mcp__happy__change_title', { title: 'Test' });
        expect(shouldSkipNormalProcessing(msg)).toBe(true);
    });

    it('should return false for regular messages', () => {
        const msg = makeToolCallMessage('Read', { file_path: '/foo.ts' });
        expect(shouldSkipNormalProcessing(msg)).toBe(false);
    });
});
