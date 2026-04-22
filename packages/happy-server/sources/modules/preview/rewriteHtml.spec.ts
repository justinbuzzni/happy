import { describe, it, expect } from 'vitest';
import { rewriteHtml, rewriteJsCss } from '@/modules/preview/rewriteHtml';

const PREFIX = '/v1/preview/m1/3000';

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
});

describe('rewriteHtml — interceptor injection', () => {
    it('injects the interceptor script after <head>', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).toMatch(/<head><script>/);
    });

    it('injects after <html> when <head> is absent', () => {
        const out = rewriteHtml('<html><body></body></html>', PREFIX);
        expect(out).toMatch(/<html><script>/);
    });

    it('prepends interceptor when neither <head> nor <html> is present', () => {
        const out = rewriteHtml('<div>naked fragment</div>', PREFIX);
        expect(out.startsWith('<script>')).toBe(true);
        expect(out).toContain('<div>naked fragment</div>');
    });

    it('interceptor embeds the configured prefix', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).toContain(`var P='${PREFIX}'`);
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

    it('leaves protocol-relative and already-prefixed paths untouched', () => {
        const input = `import a from '//cdn/lib.js'; import b from '${PREFIX}/local.js';`;
        const out = rewriteJsCss(input, PREFIX);
        expect(out).toContain("'//cdn/lib.js'");
        expect(out).toContain(`'${PREFIX}/local.js'`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });
});
