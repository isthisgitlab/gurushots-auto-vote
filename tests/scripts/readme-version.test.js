/**
 * Unit tests for scripts/readme-version.js (`pnpm update:readme` /
 * `pnpm verify:readme`).
 *
 * fs is an in-memory file map, so the real README.md / README.lv.md
 * are never read or rewritten. The script does its work at require time, so
 * each case requires it in an isolated registry with argv set and
 * process.exit stubbed to throw (stopping control where the process would).
 */

const realPath = jest.requireActual('path');

jest.mock('path', () => jest.requireActual('path'));

// Shared instance so the copy required inside jest.isolateModules is this one.
const mockFiles = new Map();
const mockFs = {
    existsSync: jest.fn((p) => mockFiles.has(p)),
    readFileSync: jest.fn((p) => {
        if (!mockFiles.has(p)) throw new Error(`ENOENT: ${p}`);
        return mockFiles.get(p);
    }),
    writeFileSync: jest.fn((p, data) => {
        mockFiles.set(p, data);
    }),
};
jest.mock('fs', () => mockFs);

const ROOT = realPath.join(__dirname, '..', '..');
const PKG = realPath.join(ROOT, 'package.json');
const README = realPath.join(ROOT, 'README.md');
const README_LV = realPath.join(ROOT, 'README.lv.md');
const DL = 'https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download';

const guiSection = (v) =>
    [
        `**Latest Version: v${v}**`,
        `- GuruShotsAutoVote-v${v}-x64.exe`,
        `- GuruShotsAutoVote-v${v}-arm64.dmg`,
        `- GuruShotsAutoVote-v${v}-arm64.app.zip`,
        `- GuruShotsAutoVote-v${v}-x86_64.AppImage`,
        `- GuruShotsAutoVote-v${v}-arm64.AppImage`,
        `- GuruShotsAutoVote-v${v}.apk`,
        `- GuruShotsAutoVote-v${v}-x64-lite.exe`,
        `- GuruShotsAutoVote-v${v}-arm64-lite.dmg`,
        `- GuruShotsAutoVote-v${v}-arm64-lite.app.zip`,
        `- GuruShotsAutoVote-v${v}-x86_64-lite.AppImage`,
        `- GuruShotsAutoVote-v${v}-arm64-lite.AppImage`,
        `${DL}/GuruShotsAutoVote-v${v}-lite.apk`,
        `${DL}/GuruShotsAutoVote-v${v}-x64.exe`,
        `${DL}/GuruShotsAutoVote-v${v}-arm64.dmg`,
        `${DL}/GuruShotsAutoVote-v${v}-arm64.app.zip`,
        `${DL}/GuruShotsAutoVote-v${v}-x86_64.AppImage`,
        `${DL}/GuruShotsAutoVote-v${v}-arm64.AppImage`,
        `${DL}/GuruShotsAutoVote-v${v}.apk`,
        `chmod +x GuruShotsAutoVote-v${v}-*.AppImage`,
        `./GuruShotsAutoVote-v${v}-*.AppImage`,
    ].join('\n');

const cliSection = (v) =>
    [
        '## CLI Applications',
        `${DL}/gurucli-v${v}-mac`,
        `${DL}/gurucli-v${v}-linux-arm`,
        `${DL}/gurucli-v${v}-linux`,
        `${DL}/gurucli-v${v}-linux-arm-lite`,
        `./gurucli-v${v}-[platform]`,
    ].join('\n');

const readme = (v) => `${guiSection(v)}\n${cliSection(v)}\n`;
// The Latvian guide localizes the CLI placeholder as `[platforma]`.
const readmeLv = (v) => `${guiSection(v)}\n${cliSection(v).replace('[platform]', '[platforma]')}\n`;

class ExitCalled extends Error {
    constructor(code) {
        super(`exit ${code}`);
        this.code = code;
    }
}

describe('scripts/readme-version.js', () => {
    const originalArgv = process.argv;
    let logSpy;
    let errorSpy;

    beforeEach(() => {
        mockFiles.clear();
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new ExitCalled(code);
        });
        setVersion('2.0.0');
    });

    afterEach(() => {
        process.argv = originalArgv;
        jest.restoreAllMocks();
    });

    function setVersion(version) {
        mockFiles.set(PKG, JSON.stringify(version === undefined ? { name: 'x' } : { name: 'x', version }));
    }

    /** Runs the script; resolves to the exit code, or null when it returned normally. */
    const run = (args = []) => {
        process.argv = ['node', 'scripts/readme-version.js', ...args];
        try {
            jest.isolateModules(() => {
                require('../../scripts/readme-version.js');
            });
        } catch (err) {
            if (err instanceof ExitCalled) return err.code;
            throw err;
        }
        return null;
    };

    const out = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const err = () => errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    test('exits 1 when package.json has no version', () => {
        setVersion(undefined);

        expect(run()).toBe(1);
        expect(err()).toContain('No version in package.json');
    });

    describe('update mode', () => {
        test('rewrites every stale occurrence in both docs', () => {
            mockFiles.set(README, readme('1.8.2'));
            mockFiles.set(README_LV, readmeLv('1.8.2-beta.1'));

            expect(run()).toBeNull();

            expect(mockFiles.get(README)).toBe(readme('2.0.0'));
            expect(mockFiles.get(README_LV)).toBe(readmeLv('2.0.0'));
            // -linux-arm must not be clobbered by the bare -linux rule, nor the
            // lite APK by the full one (its `-lite` reads like a prerelease tag).
            expect(mockFiles.get(README)).toContain('gurucli-v2.0.0-linux-arm');
            expect(mockFiles.get(README)).toContain('GuruShotsAutoVote-v2.0.0-lite.apk');
            expect(out()).toContain('✓ README.md: 28 occurrence(s) updated to v2.0.0');
            expect(out()).toContain('✓ README.lv.md: 28 occurrence(s) updated');
            expect(out()).toContain('56 total replacement(s) for v2.0.0.');
        });

        test('reports files already at the current version without writing', () => {
            mockFiles.set(README, readme('2.0.0'));

            expect(run()).toBeNull();

            expect(mockFs.writeFileSync).not.toHaveBeenCalled();
            expect(out()).toContain('✓ README.md: already at v2.0.0');
            expect(out()).toContain('0 total replacement(s) for v2.0.0.');
        });

        test('treats a file with no matches as already current', () => {
            mockFiles.set(README, 'nothing versioned here\n');

            expect(run()).toBeNull();
            expect(mockFs.writeFileSync).not.toHaveBeenCalled();
            expect(out()).toContain('✓ README.md: already at v2.0.0');
        });

        test('escapes $ in the version so it is not read as a replacement back-reference', () => {
            setVersion('2.0.0-rc$&');
            mockFiles.set(README, '**Latest Version: v1.0.0**\n');

            expect(run()).toBeNull();
            expect(mockFiles.get(README)).toBe('**Latest Version: v2.0.0-rc$&**\n');
        });
    });

    describe('--check mode', () => {
        test('passes when both docs match', () => {
            mockFiles.set(README, readme('2.0.0'));
            mockFiles.set(README_LV, readmeLv('2.0.0'));

            expect(run(['--check'])).toBeNull();

            expect(out()).toContain('✓ README.md: matches v2.0.0');
            expect(out()).toContain('✓ README.lv.md: matches v2.0.0');
            expect(out()).not.toContain('total replacement');
            expect(err()).toBe('');
            expect(mockFs.writeFileSync).not.toHaveBeenCalled();
        });

        test('fails on stale occurrences without writing', () => {
            mockFiles.set(README, readme('1.8.2'));

            expect(run(['--check'])).toBe(1);

            expect(err()).toMatch(/✗ README\.md: 1 occurrence\(s\) of .* do not match v2\.0\.0/);
            expect(err()).toContain('Run `pnpm run update:readme` to fix.');
            expect(mockFs.writeFileSync).not.toHaveBeenCalled();
        });

        test('fails when a required section is missing', () => {
            mockFiles.set(README, `${guiSection('2.0.0').replace(/.*\.apk\n/g, '')}\n${cliSection('2.0.0')}\n`);

            expect(run(['--check'])).toBe(1);
            expect(err()).toContain('required pattern');
            expect(err()).toContain('has zero matches');
        });

        test('only requires CLI patterns in files that already have a CLI section', () => {
            // A "gurucli-v" reference alone marks the file as having a CLI section.
            mockFiles.set(README, `${guiSection('2.0.0')}\ngurucli-v2.0.0-mac\n`);
            // No CLI marker at all: the cli rules stay optional.
            mockFiles.set(README_LV, `${guiSection('2.0.0')}\n`);

            expect(run(['--check'])).toBe(1);
            const errors = err();
            expect(errors).toContain('✗ README.md: required pattern /gurucli-v');
            expect(errors).not.toContain('README.lv.md');
            expect(out()).toContain('README.lv.md: matches v2.0.0');
        });
    });
});
