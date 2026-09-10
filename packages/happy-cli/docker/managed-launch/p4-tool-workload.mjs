/*
 * 격리된 executor 가 execve 하는 도구 workload.
 *
 * 제품(`toolWorkloadEntry`)만 부른다 — stdin 의 호출 하나를 처리하고 stdout 으로
 * 결과 본문을 돌려준다.
 *
 * **쓰고 나서 곧바로 `process.exit` 하지 않는다.** stdout 이 파이프이고 읽는 쪽이
 * 느리면 `write` 는 버퍼에 남긴 채 돌아오고, 그 자리에서 종료하면 뒷부분이
 * 사라진다. 그래서 종료 코드만 정해 두고 스트림이 비워진 뒤 자연히 끝나게 둔다.
 */
import { createRequire } from 'node:module';

const require = createRequire('/usr/local/lib/saycode/');
const product = require('/usr/local/lib/saycode/toolRuntime.cjs');

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const outcome = product.runToolWorkloadCall(
    Buffer.concat(chunks).toString('utf8'),
    product.defaultToolWorkloadDeps(process.cwd()),
);
process.exitCode = outcome.ok ? 0 : 1;
process.stdout.write(outcome.ok ? outcome.content : outcome.code);
