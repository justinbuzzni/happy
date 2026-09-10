/*
 * 로컬 Anthropic 대역. **성공 문자열을 지어내지 않는다** — 마지막 텍스트는
 * 실제로 받은 tool_result 내용을 그대로 되풀이한다. 도구가 실패해도 같은
 * 문자열이 나오면 그 문자열은 아무것도 증명하지 못한다(직전 하네스의 결함).
 */
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const RAW = process.env.RAW_LOG || '/tmp/p4-model-requests.jsonl';
const TOOL = process.env.FAKE_TOOL_NAME || 'mcp__saycode-broker__read_file';
writeFileSync(RAW, '');

function sse(res, events) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
}

function collectToolResults(messages) {
    const found = [];
    for (const message of messages ?? []) {
        for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block?.type !== 'tool_result') continue;
            const content = Array.isArray(block.content)
                ? block.content.map((c) => c?.text ?? '').join('')
                : String(block.content ?? '');
            found.push({ isError: block.is_error === true, content });
        }
    }
    return found;
}

createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        appendFileSync(RAW, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }) + '\n');
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* messages 요청이 아니다 */ }
        const results = collectToolResults(parsed.messages);
        const usage = { input_tokens: 10, output_tokens: 5 };
        const msg = { id: 'msg_p4', type: 'message', role: 'assistant', model: parsed.model || 'x',
            content: [], stop_reason: null, stop_sequence: null, usage };
        if (results.length > 0) {
            // 받은 것을 그대로 되돌린다. 지어낸 성공 문자열은 없다.
            const echoed = results.map((r) => `${r.isError ? 'TOOL_ERROR' : 'TOOL_OK'}:${r.content}`).join('|');
            sse(res, [
                ['message_start', { type: 'message_start', message: msg }],
                ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
                ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: echoed } }],
                ['content_block_stop', { type: 'content_block_stop', index: 0 }],
                ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }],
                ['message_stop', { type: 'message_stop' }],
            ]);
            return;
        }
        sse(res, [
            ['message_start', { type: 'message_start', message: msg }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_p4', name: TOOL, input: {} } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"보고서.md"}' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }],
            ['message_stop', { type: 'message_stop' }],
        ]);
    });
}).listen(Number(process.env.FAKE_PORT || 0), '127.0.0.1', function () {
    writeFileSync(process.env.FAKE_PORT_FILE || '/harness-fake.port', String(this.address().port));
});
