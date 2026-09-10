/*
 * The tool workload the isolated executor runs: one call in on stdin, its
 * result out on stdout.
 *
 * **It does not call `process.exit` after writing.** stdout is a pipe, and if
 * the reader is slow `write` returns with the bytes still buffered — exiting
 * there truncates the result. So the exit code is set and the process is left
 * to end once the stream has drained.
 *
 * The product code arrives as a CommonJS bundle at a fixed absolute path, so
 * this file carries no logic of its own to keep in step with it.
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
