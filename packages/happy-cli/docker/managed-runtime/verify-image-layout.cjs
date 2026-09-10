#!/usr/bin/env node
/*
 * Checks the image against the layout the runtime reads its paths from.
 *
 * It runs inside the build, against the files that were just installed, and
 * uses the same module the running system uses — so the build cannot pass with
 * a layout the runtime would then refuse.
 */
const { assertManagedImageLayout } = require('/usr/local/lib/saycode/toolRuntime.cjs');

assertManagedImageLayout().then((problems) => {
    if (problems.length === 0) {
        console.log('managed image layout OK');
        return;
    }
    for (const problem of problems) console.error('LAYOUT PROBLEM', JSON.stringify(problem));
    process.exitCode = 1;
});
