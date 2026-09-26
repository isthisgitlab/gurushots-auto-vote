/**
 * Tests for scripts/build-lexicon.js main() — the fatal gates and the asset
 * write, run against os.tmpdir() fixtures so the committed intermediate and
 * src/assets/semantic-vectors.json are never read or written. process.exit is
 * stubbed to throw so a fatal path stops exactly where the real process would.
 */

// tests/setup.js globally mocks fs and path; this suite needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { main } = require('../../scripts/build-lexicon');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('build-lexicon main', () => {
    let tmp;
    let paths;
    let exitSpy;
    let logSpy;
    let errorSpy;

    const PACKED = { cat: 'AAAA', kitten: 'AAAA' };

    const writeFixture = ({ packed = PACKED, sidecar, concepts } = {}) => {
        fs.writeFileSync(paths.embeddingsPath, JSON.stringify({ dims: 4, scale: 0.01, packed }));
        fs.writeFileSync(paths.embeddingsShaPath, `${sidecar ?? sha(JSON.stringify(packed))}\n`);
        fs.writeFileSync(
            paths.conceptsPath,
            JSON.stringify(concepts ?? { concepts: [{ id: 'cat', parent: 'pet', words: ['cat', 'kitten'] }] }),
        );
    };

    const errors = () => errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-lexicon-'));
        paths = {
            embeddingsPath: path.join(tmp, 'lexicon-embeddings.json'),
            embeddingsShaPath: path.join(tmp, 'lexicon-embeddings.sha256'),
            conceptsPath: path.join(tmp, 'lexicon-concepts.json'),
            outAsset: path.join(tmp, 'semantic-vectors.json'),
            distDir: path.join(tmp, 'dist'),
        };
        exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`exit ${code}`);
        });
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('fails when the intermediate is missing', () => {
        expect(() => main(paths)).toThrow('exit 1');
        expect(errors()).toContain('lexicon-embeddings.json is missing');
    });

    test('defaults to the committed paths (checked without touching them)', () => {
        const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        expect(() => main()).toThrow('exit 1');
        expect(existsSpy).toHaveBeenCalledWith(path.join(__dirname, '..', '..', 'scripts', 'lexicon-embeddings.json'));
    });

    test('fails the tamper check when the sidecar hash does not match the payload', () => {
        writeFixture({ sidecar: 'deadbeef' });
        expect(() => main(paths)).toThrow('exit 1');
        expect(errors()).toContain('does not match scripts/lexicon-embeddings.sha256');
        expect(errors()).toContain('sidecar  deadbeef');
    });

    test('fails on a stem claimed by two concepts', () => {
        writeFixture({
            concepts: {
                concepts: [
                    { id: 'cat', parent: 'pet', words: ['cat'] },
                    { id: 'feline', parent: 'wild', words: ['cats'] },
                ],
            },
        });
        expect(() => main(paths)).toThrow('exit 1');
        expect(errors()).toContain('1 stem(s) claimed by more than one concept');
    });

    test('fails on an authored word missing from the intermediate', () => {
        writeFixture({ concepts: { concepts: [{ id: 'bird', parent: 'bird', words: ['bird'] }] } });
        expect(() => main(paths)).toThrow('exit 1');
        expect(errors()).toContain('1 authored word(s) missing from the intermediate');
        expect(fs.existsSync(paths.outAsset)).toBe(false);
    });

    test('writes the asset (no dist copy when dist/ is absent)', () => {
        writeFixture();
        main(paths);
        expect(exitSpy).not.toHaveBeenCalled();
        const asset = JSON.parse(fs.readFileSync(paths.outAsset, 'utf8'));
        expect(asset).toMatchObject({ version: 2, dims: 4, packed: PACKED });
        expect(asset.searchGroups).toEqual([['cat', 'kitten']]);
        expect(fs.existsSync(path.join(paths.distDir, 'semantic-vectors.json'))).toBe(false);
        const summary = logSpy.mock.calls[0][0];
        expect(summary).toContain('2 word-stems, 4d');
        expect(summary).not.toContain('dist copy');
    });

    test('also writes a byte-identical dist copy when dist/ exists', () => {
        writeFixture();
        fs.mkdirSync(paths.distDir);
        main(paths);
        const distCopy = fs.readFileSync(path.join(paths.distDir, 'semantic-vectors.json'), 'utf8');
        expect(distCopy).toBe(fs.readFileSync(paths.outAsset, 'utf8'));
        expect(logSpy.mock.calls[0][0]).toContain('(+ dist copy)');
    });
});
