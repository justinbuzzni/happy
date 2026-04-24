import { describe, it, expect } from 'vitest';
import { rewriteHtml, rewriteJsCss } from '@/modules/preview/rewriteHtml';

const PREFIX = '/v1/preview/m1/3000';

// Phase 9: the auth secret no longer travels via URL — the relay sets a
// path-scoped HttpOnly cookie on the first response, and every subsequent
// subresource request picks it up automatically. The rewriter must stop
// appending ?ptoken= to rewritten URLs. See plan.md Phase 9 step 3.

describe('rewriteHtml — absolute path rewriting', () => {
    it('rewrites src="/..." to prefix', () => {
        const out = rewriteHtml('<img src="/logo.png">', PREFIX);
        expect(out).toContain(`src="${PREFIX}/logo.png"`);
    });

    it('rewrites href="/..." to prefix', () => {
        const out = rewriteHtml('<link href="/main.css">', PREFIX);
        expect(out).toContain(`href="${PREFIX}/main.css"`);
    });

    it('rewrites action="/..." to prefix', () => {
        const out = rewriteHtml('<form action="/submit">', PREFIX);
        expect(out).toContain(`action="${PREFIX}/submit"`);
    });

    it('preserves the original query string on rewritten paths', () => {
        const out = rewriteHtml('<script src="/a.js?v=1"></script>', PREFIX);
        expect(out).toContain(`src="${PREFIX}/a.js?v=1"`);
    });

    it('leaves protocol-relative paths (//cdn/...) untouched', () => {
        const out = rewriteHtml('<script src="//cdn.example.com/lib.js"></script>', PREFIX);
        expect(out).toContain('src="//cdn.example.com/lib.js"');
        expect(out).not.toContain(`${PREFIX}//cdn`);
    });

    it('does not double-rewrite already-prefixed paths', () => {
        const already = `<img src="${PREFIX}/logo.png">`;
        const out = rewriteHtml(already, PREFIX);
        expect(out).toContain(`src="${PREFIX}/logo.png"`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('rewrites ES module imports starting with /', () => {
        const out = rewriteHtml(`<script type="module">import foo from '/src/foo.js'</script>`, PREFIX);
        expect(out).toContain(`'${PREFIX}/src/foo.js'`);
    });

    it('rewrites from "/..." in dynamic imports', () => {
        const out = rewriteHtml(`<script>import('/x.js')</script>`, PREFIX);
        expect(out).toContain(`'${PREFIX}/x.js'`);
    });

    it('leaves external absolute URLs untouched', () => {
        const out = rewriteHtml('<a href="https://example.com/x">ok</a>', PREFIX);
        expect(out).toContain('href="https://example.com/x"');
    });

    it('does not append ?ptoken= to any rewritten src/href/action attribute', () => {
        // Phase 9: URLs must stay clean — cookie-based auth replaces it.
        const input = '<img src="/a.png"><link href="/b.css"><form action="/c"></form>';
        const out = rewriteHtml(input, PREFIX);
        // Scope the assertion to the attribute values so the interceptor
        // script's internal literals (there are none for ptoken in Phase 9,
        // but keep the check explicit) can't cross-contaminate.
        const attrValues = (out.match(/(?:src|href|action)="[^"]+"/g) ?? []).join('\n');
        expect(attrValues).not.toContain('ptoken=');
    });
});

describe('rewriteHtml — interceptor injection', () => {
    it('injects <base href> before the interceptor script after <head>', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).toMatch(new RegExp(`<head><base href="${PREFIX}/"><script>`));
    });

    it('injects after <html> when <head> is absent', () => {
        const out = rewriteHtml('<html><body></body></html>', PREFIX);
        expect(out).toMatch(new RegExp(`<html><base href="${PREFIX}/"><script>`));
    });

    it('prepends <base> + interceptor when neither <head> nor <html> is present', () => {
        const out = rewriteHtml('<div>naked fragment</div>', PREFIX);
        expect(out.startsWith(`<base href="${PREFIX}/"><script>`)).toBe(true);
        expect(out).toContain('<div>naked fragment</div>');
    });

    // <base href> pins the document base URL so that relative-path resources
    // (<script src="app.js">, <link href="style.css">) keep resolving through
    // the relay even after the interceptor's history.replaceState mutates
    // location.pathname. Without this, app.js requests fall back to the
    // platform origin and the browser hits a SPA-fallback HTML page that
    // fails JS parsing with "Unexpected token '<'".
    // See specs/preview-api-proxy/ Phase 5 (R9).
    it('injects <base href> with the configured prefix and trailing slash', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`<base href="${PREFIX}/">`);
    });

    it('places <base href> ahead of the interceptor script in document order', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        const baseIdx = out.indexOf('<base href=');
        const scriptIdx = out.indexOf('<script>');
        expect(baseIdx).toBeGreaterThanOrEqual(0);
        expect(scriptIdx).toBeGreaterThanOrEqual(0);
        expect(baseIdx).toBeLessThan(scriptIdx);
    });

    it('interceptor embeds the configured prefix', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).toContain(`var P='${PREFIX}'`);
    });

    it('interceptor no longer embeds a ptoken constant (cookie replaces it)', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).not.toContain(`var T=`);
        expect(out).not.toContain('ptoken=');
    });

    it('interceptor patches fetch and XMLHttpRequest', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain('window.fetch');
        expect(out).toContain('XMLHttpRequest.prototype.open');
    });

    it('interceptor stubs WebSocket for HMR protocols', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain('NoopWS');
        expect(out).toContain('vite-hmr');
    });
});

describe('rewriteJsCss', () => {
    it('rewrites ES import paths', () => {
        const out = rewriteJsCss(`import x from '/lib/x.js'`, PREFIX);
        expect(out).toContain(`'${PREFIX}/lib/x.js'`);
    });

    it('rewrites CSS url() references', () => {
        const out = rewriteJsCss(`.bg{background:url("/img/bg.png")}`, PREFIX);
        expect(out).toContain(`url("${PREFIX}/img/bg.png")`);
    });

    it('leaves protocol-relative paths untouched and does not double-prefix', () => {
        const input = `import a from '//cdn/lib.js'; import b from '${PREFIX}/local.js';`;
        const out = rewriteJsCss(input, PREFIX);
        expect(out).toContain("'//cdn/lib.js'");
        expect(out).toContain(`'${PREFIX}/local.js'`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('preserves existing query strings on rewritten paths', () => {
        const out = rewriteJsCss(`@import url("/theme.css?v=2")`, PREFIX);
        expect(out).toContain(`url("${PREFIX}/theme.css?v=2")`);
    });

    it('does not append ?ptoken= to rewritten URLs', () => {
        const input = `import x from '/a.js'; .bg{background:url("/img/b.png")}`;
        const out = rewriteJsCss(input, PREFIX);
        expect(out).not.toContain('ptoken=');
    });
});
