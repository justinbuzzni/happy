#!/usr/bin/env node
/**
 * macOS-only postinstall fix for node-pty's spawn-helper.
 *
 * The npm tarball ships prebuilds/darwin-{arm64,x64}/spawn-helper with
 * 0o644 (no execute bit). At runtime node-pty's posix_spawnp on macOS
 * fails with "posix_spawnp failed." because the kernel refuses to
 * execve() a non-executable file. This script flips the bit back
 * during postinstall so users don't have to rebuild from source.
 *
 * No-op on Linux / Windows — those platforms don't use spawn-helper.
 *
 * See specs/remote-terminal/ Phase 6 closure notes (2026-05-03).
 */

const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') {
    process.exit(0);
}

let nodePtyRoot;
try {
    // Resolve from happy-cli's POV — handles both nested and hoisted layouts.
    const entry = require.resolve('node-pty', { paths: [path.dirname(__dirname)] });
    // entry points at lib/index.js — go up to the package root.
    nodePtyRoot = path.dirname(entry);
    if (path.basename(nodePtyRoot) === 'lib') {
        nodePtyRoot = path.dirname(nodePtyRoot);
    }
} catch (_e) {
    // Fallbacks — try a couple of common install layouts.
    const candidates = [
        path.join(__dirname, '..', 'node_modules', 'node-pty'),
        path.join(__dirname, '..', '..', 'node-pty'),
    ];
    nodePtyRoot = candidates.find((d) => fs.existsSync(path.join(d, 'package.json')));
    if (!nodePtyRoot) {
        // Nothing to do — node-pty layout unrecognised.
        process.exit(0);
    }
}

for (const arch of ['arm64', 'x64']) {
    const helper = path.join(nodePtyRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    let st;
    try {
        st = fs.statSync(helper);
    } catch (_e) {
        // Prebuild for this arch wasn't shipped — skip silently.
        continue;
    }
    if ((st.mode & 0o111) !== 0) {
        // Already executable — nothing to do.
        continue;
    }
    try {
        fs.chmodSync(helper, 0o755);
        console.log(`[happy-cli postinstall] chmod +x ${helper}`);
    } catch (e) {
        // Not fatal — surface a hint and move on.
        console.warn(`[happy-cli postinstall] could not chmod ${helper}: ${e.message}`);
    }
}
