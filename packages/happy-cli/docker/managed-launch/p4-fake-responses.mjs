/*
 * codex 용 로컬 모델 대역(Responses). 성공 문자열을 지어내지 않는다 — 도구
 * 결과를 그대로 되돌린다. 첫 요청에서만 도구를 부르고, 다음 요청에서는 받은
 * 결과를 텍스트로 옮긴다.
 */
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const RAW = process.env.RAW_LOG || '/tmp/p4-codex-requests.jsonl';
const FORCE_JS = process.env.FAKE_FORCE_JS
    ?? `const names = Object.keys(tools).filter((n) => n.indexOf('saycode') >= 0);
text('MCP_TOOL_NAMES:' + JSON.stringify(names));
text('NESTED_TOOL_NAMES:' + JSON.stringify(Object.keys(tools).sort()));
const call = async (label, name, args) => {
  try { text(label + ':' + JSON.stringify(await tools[name](args))); }
  catch (error) { text(label + ':ERROR ' + String(error && error.message ? error.message : error)); }
};
const inScope = names.find((n) => n.endsWith('read_file'));
const outOfScope = names.find((n) => n.endsWith('delete_file'));
if (inScope) await call('IN_SCOPE', inScope, { path: '보고서.md' });
if (outOfScope) await call('OUT_OF_SCOPE', outOfScope, { path: '보고서.md' });`;
writeFileSync(RAW, '');
let seen = 0;

const usage = {
    input_tokens: 1, input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2,
};

createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        appendFileSync(RAW, `${JSON.stringify({ url: req.url, body: body.slice(0, 200_000) })}\n`);
        seen += 1;
        const item = seen === 1
            ? { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: FORCE_JS }
            : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
            { type: 'response.created', response: { id: 'r1' } },
            { type: 'response.output_item.done', item },
            { type: 'response.completed', response: { id: 'r1', usage } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
    });
}).listen(Number(process.env.FAKE_PORT || 0), '127.0.0.1', function () {
    writeFileSync(process.env.FAKE_PORT_FILE || '/harness-fake.port', String(this.address().port));
});
