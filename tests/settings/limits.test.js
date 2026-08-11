// tests/setup.js mocks `fs` (and path.join/dirname/resolve) globally, so this
// suite reaches for the real modules to read its own source off disk.
const realFs = jest.requireActual('fs');
const realPath = jest.requireActual('path');

const LIMITS_PATH = realPath.join(__dirname, '..', '..', 'src', 'js', 'settings', 'limits.js');
const limits = require('../../src/js/settings/limits');
const schema = require('../../src/js/settings/schema');

describe('settings/limits', () => {
    it('exports the scheduled-fill entry cap', () => {
        expect(limits.MAX_SCHEDULED_FILL_ENTRIES).toBe(6);
    });

    it('stays the single source of truth for the cap', () => {
        // schema.js re-exports it, and the renderer reads it through
        // SettingInput's SCHEDULED_FILL_MAX_ENTRIES alias. If these ever
        // diverge the UI would offer a row the validator rejects on save.
        expect(schema.MAX_SCHEDULED_FILL_ENTRIES).toBe(limits.MAX_SCHEDULED_FILL_ENTRIES);
    });

    // The whole reason this module exists is that it is safe to import from
    // app-bundle.js. settings/schema.js requires zod, and a CJS require of it
    // cannot be tree-shaken, so pulling a bound from there put ~407 KB of zod
    // into the Electron renderer. pnpm size would eventually catch a
    // regression, but only as a confusing budget failure in a separate CI job
    // — this fails fast, right where the contract is written down.
    it('is dependency-free so renderer bundles can import it', () => {
        const source = realFs.readFileSync(LIMITS_PATH, 'utf8');
        const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

        expect(withoutComments).not.toMatch(/\brequire\s*\(/);
        expect(withoutComments).not.toMatch(/^\s*import\s/m);
    });
});
