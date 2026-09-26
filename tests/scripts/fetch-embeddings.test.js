/**
 * Tests for scripts/fetch-embeddings.js — the download, the zip-extraction
 * guards yauzl alone cannot trip, and main()/run() end to end. Fully hermetic:
 * fetch is stubbed (no network), the "archive" is a tiny stored zip built in
 * memory and written into an os.tmpdir() sandbox, and the pins are the hashes
 * of that fixture — the real scripts/.cache, lexicon-embeddings.json and its
 * sidecar are never touched. process.exit is stubbed to throw so a fatal path
 * stops exactly where the real process would.
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
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const yauzl = require('yauzl');

const {
    download,
    fetchHttpsOnly,
    main,
    run,
    sha256OfFile,
    streamEntryLines,
    ENTRY_NAME,
} = require('../../scripts/fetch-embeddings');
const { makeStoredZip } = require('./helpers/stored-zip');

const DIMS = 100;
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

// One GloVe text line: the token plus DIMS numbers derived from `seed`, so
// different seeds give clearly different directions.
const gloveLine = (token, seed, sign = 1) =>
    `${token} ${Array.from({ length: DIMS }, (_, i) => (sign * Math.sin(seed * (i + 1))).toFixed(4)).join(' ')}`;

// A controllable stand-in for a yauzl zipfile, for the guards a well-formed
// archive can never reach (yauzl validates sizes itself).
const fakeZipfile = ({ entry, openReadStream }) => {
    const zip = new EventEmitter();
    zip.close = jest.fn();
    zip.readEntry = () => {
        if (entry) setImmediate(() => zip.emit('entry', entry));
    };
    zip.openReadStream = openReadStream;
    return zip;
};

describe('fetch-embeddings', () => {
    let tmp;
    let exitSpy;
    let logSpy;
    let errorSpy;

    const errors = () => errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const logs = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-embeddings-'));
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

    describe('download', () => {
        let opts;
        let fetchSpy;

        beforeEach(() => {
            opts = {
                cacheDir: path.join(tmp, 'cache'),
                zipPath: path.join(tmp, 'cache', 'glove.zip'),
                url: 'https://example.test/glove.zip',
                maxBytes: 16,
            };
            fetchSpy = jest.spyOn(globalThis, 'fetch');
        });

        test('reuses a cached archive without touching the network', async () => {
            fs.mkdirSync(opts.cacheDir);
            fs.writeFileSync(opts.zipPath, 'cached');
            await download(opts);
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(logs()).toContain('Using cached archive');
        });

        test('refuses a non-https source', async () => {
            await expect(download({ ...opts, url: 'file:///tmp/glove.zip' })).rejects.toThrow('exit 1');
            expect(errors()).toContain('refusing non-https source');
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        test('follows an https redirect hop by hop', async () => {
            const cancel = jest.fn();
            fetchSpy
                .mockResolvedValueOnce({
                    status: 301,
                    headers: new Headers({ location: '/moved/glove.zip' }),
                    body: { cancel },
                })
                .mockResolvedValueOnce({ ok: true, status: 200, body: Readable.from([Buffer.from('zip')]) });
            await download(opts);
            expect(fetchSpy.mock.calls).toEqual([
                ['https://example.test/glove.zip', { redirect: 'manual' }],
                ['https://example.test/moved/glove.zip', { redirect: 'manual' }],
            ]);
            expect(fs.readFileSync(opts.zipPath, 'utf8')).toBe('zip');
            expect(cancel).toHaveBeenCalledTimes(1);
        });

        test('refuses a redirect that downgrades to http', async () => {
            fetchSpy.mockResolvedValue({ status: 302, headers: new Headers({ location: 'http://example.test/x' }) });
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('redirected to non-https source: http://example.test/x');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['an Error', new Error('ECONNRESET'), 'download failed: ECONNRESET'],
            ['a bare value', 'offline', 'download failed: offline'],
        ])('fails cleanly when fetch rejects with %s', async (_label, reason, message) => {
            fetchSpy.mockRejectedValue(reason);
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain(message);
        });

        test('fails on a non-OK HTTP status', async () => {
            fetchSpy.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', body: null });
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('HTTP 404 Not Found');
        });

        test('fails on an OK response with no body', async () => {
            fetchSpy.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', body: null });
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('HTTP 200 OK');
        });

        test('streams the body into the cache via a .partial file', async () => {
            fetchSpy.mockResolvedValue({ ok: true, body: Readable.from([Buffer.from('zip'), Buffer.from('bytes')]) });
            await download(opts);
            expect(fs.readFileSync(opts.zipPath, 'utf8')).toBe('zipbytes');
            expect(fs.existsSync(`${opts.zipPath}.partial`)).toBe(false);
        });

        test('aborts and removes the partial file once the byte cap is exceeded', async () => {
            fetchSpy.mockResolvedValue({ ok: true, body: Readable.from([Buffer.alloc(10), Buffer.alloc(10)]) });
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('download exceeded 16 bytes');
            expect(fs.existsSync(`${opts.zipPath}.partial`)).toBe(false);
            expect(fs.existsSync(opts.zipPath)).toBe(false);
        });

        test('reports a non-Error stream failure verbatim', async () => {
            const body = (async function* () {
                yield Buffer.from('x');
                throw 'socket hang up';
            })();
            fetchSpy.mockResolvedValue({ ok: true, body });
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('download interrupted: socket hang up');
        });
    });

    describe('fetchHttpsOnly', () => {
        test('gives up past the redirect limit', async () => {
            const fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue({ status: 307, headers: new Headers({ location: 'https://example.test/loop' }) });
            await expect(fetchHttpsOnly('https://example.test/a', 2)).rejects.toThrow('more than 2 redirects');
            expect(fetchSpy).toHaveBeenCalledTimes(3);
        });

        test('returns a 3xx without a Location as-is', async () => {
            const res = { ok: false, status: 304, headers: new Headers() };
            jest.spyOn(globalThis, 'fetch').mockResolvedValue(res);
            await expect(fetchHttpsOnly('https://example.test/a')).resolves.toBe(res);
        });
    });

    describe('sha256OfFile', () => {
        test('hashes a file and rejects on a read error', async () => {
            const file = path.join(tmp, 'f.bin');
            fs.writeFileSync(file, 'hello');
            await expect(sha256OfFile(file)).resolves.toBe(sha('hello'));
            await expect(sha256OfFile(path.join(tmp, 'missing'))).rejects.toThrow(/ENOENT/);
        });
    });

    describe('streamEntryLines guards past yauzl', () => {
        const entry = { fileName: ENTRY_NAME, uncompressedSize: 1 };

        test('rejects when the entry stream cannot be opened', async () => {
            jest.spyOn(yauzl, 'fromBuffer').mockImplementation((_buf, _opts, cb) =>
                cb(null, fakeZipfile({ entry, openReadStream: (_e, done) => done(new Error('bad method')) })),
            );
            await expect(streamEntryLines(Buffer.from('x'), () => {})).rejects.toThrow('bad method');
        });

        test('aborts once the inflated bytes pass the cap, whatever the entry declared', async () => {
            jest.spyOn(yauzl, 'fromBuffer').mockImplementation((_buf, _opts, cb) =>
                cb(
                    null,
                    fakeZipfile({
                        entry,
                        openReadStream: (_e, done) => done(null, Readable.from([Buffer.from('aaaa\nbbbb\ncccc\n')])),
                    }),
                ),
            );
            await expect(streamEntryLines(Buffer.from('x'), () => {}, { maxEntryBytes: 5 })).rejects.toThrow(
                'entry inflated past 5 bytes',
            );
        });

        test('propagates a zipfile-level error', async () => {
            const zip = fakeZipfile({});
            jest.spyOn(yauzl, 'fromBuffer').mockImplementation((_buf, _opts, cb) => cb(null, zip));
            const pending = streamEntryLines(Buffer.from('x'), () => {});
            zip.emit('error', new Error('invalid central directory'));
            await expect(pending).rejects.toThrow('invalid central directory');
        });

        test("a late 'end' after the entry was found does not reject", async () => {
            const zip = fakeZipfile({
                entry,
                openReadStream: (_e, done) => done(null, Readable.from([Buffer.from('ok\n')])),
            });
            jest.spyOn(yauzl, 'fromBuffer').mockImplementation((_buf, _opts, cb) => cb(null, zip));
            const lines = [];
            await expect(streamEntryLines(Buffer.from('x'), (l) => lines.push(l))).resolves.toBe(sha('ok\n'));
            zip.emit('end');
            expect(lines).toEqual(['ok']);
            expect(zip.close).toHaveBeenCalled();
        });
    });

    describe('main', () => {
        let opts;

        const CONCEPTS = {
            concepts: [{ id: 'pet', parent: 'animal', words: ['cat', 'kitten'] }],
            extraWords: ['sofa'],
        };
        const HAPPY_LINES = [
            gloveLine('the', 1),
            gloveLine('and', 2),
            gloveLine('extra', 3), // dropped: past topN
            "o'neil 1 2", // dropped: fails the generic token filter
            '', // no token at all
            ' 1 2', // leading space: empty token
            gloveLine('cat', 4),
            gloveLine('kitten', 5),
            'sofa 1 2', // authored but malformed: skipped, the later valid line wins
            gloveLine('sofa', 6),
        ];

        // Write the fixture archive into the cache dir and pin its hashes.
        const setup = ({ concepts = CONCEPTS, lines = HAPPY_LINES, ...rest } = {}) => {
            const content = `${lines.join('\n')}\n`;
            const zip = makeStoredZip([[ENTRY_NAME, content]]);
            fs.mkdirSync(opts.cacheDir, { recursive: true });
            fs.writeFileSync(opts.zipPath, zip);
            fs.writeFileSync(opts.conceptsPath, JSON.stringify(concepts));
            Object.assign(opts, { expectedZipSha256: sha(zip), expectedEntrySha256: sha(content), ...rest });
        };

        beforeEach(() => {
            opts = {
                conceptsPath: path.join(tmp, 'lexicon-concepts.json'),
                cacheDir: path.join(tmp, 'cache'),
                zipPath: path.join(tmp, 'cache', 'glove.zip'),
                outPath: path.join(tmp, 'lexicon-embeddings.json'),
                url: 'https://example.test/glove.zip',
                topN: 2,
            };
        });

        test('defaults to the committed paths and pins (stopped at an authored collision)', async () => {
            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({
                    concepts: [
                        { id: 'a', words: ['cat'] },
                        { id: 'b', words: ['cats'] },
                    ],
                }),
            );
            await expect(main()).rejects.toThrow('exit 1');
            expect(readSpy).toHaveBeenCalledWith(
                path.join(__dirname, '..', '..', 'scripts', 'lexicon-concepts.json'),
                'utf8',
            );
            expect(errors()).toContain('1 authored stem collision(s) across clusters');
        });

        test('fails on an archive whose SHA-256 does not match the pin', async () => {
            setup({ expectedZipSha256: 'f'.repeat(64) });
            await expect(main(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('SHA-256 mismatch for the archive');
        });

        test('fails when the cached archive cannot be opened', async () => {
            fs.mkdirSync(opts.cacheDir);
            fs.writeFileSync(opts.zipPath, 'not a zip');
            fs.writeFileSync(opts.conceptsPath, JSON.stringify(CONCEPTS));
            await expect(main({ ...opts, expectedZipSha256: sha('not a zip') })).rejects.toThrow('exit 1');
            expect(errors()).toContain('extraction failed: cannot open zip');
        });

        test('reports a non-Error extraction failure verbatim', async () => {
            setup();
            const zip = fakeZipfile({});
            jest.spyOn(yauzl, 'open').mockImplementation((_p, _o, cb) => {
                cb(null, zip);
                zip.emit('error', 'truncated');
            });
            await expect(main(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('extraction failed: truncated');
        });

        test('fails on an entry whose SHA-256 does not match the pin', async () => {
            setup({ expectedEntrySha256: '0'.repeat(64) });
            await expect(main(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain(`SHA-256 mismatch for ${ENTRY_NAME}`);
        });

        test('fails when an authored word has no vector anywhere in the vocabulary', async () => {
            setup({ concepts: { concepts: [{ id: 'pet', words: ['cat', 'unicorn'] }] } });
            await expect(main(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('1 authored word(s) have no GloVe vector');
            expect(errors()).toContain('unicorn');
        });

        test('fails when stem merges destroy meaning at scale', async () => {
            setup({ concepts: { concepts: [] }, lines: [gloveLine('day', 1), gloveLine('days', 1, -1)] });
            await expect(main(opts)).rejects.toThrow('exit 1');
            expect(logs()).toContain('worst offenders: days -> day (kept day)');
            expect(errors()).toContain('bad stem-merge rate 100.00% exceeds the 5% ceiling');
        });

        test('writes the intermediate and its payload sidecar (mean-centered + retrofit)', async () => {
            setup();
            await main(opts);
            expect(exitSpy).not.toHaveBeenCalled();
            const out = JSON.parse(fs.readFileSync(opts.outPath, 'utf8'));
            expect(out).toMatchObject({
                version: 1,
                dims: DIMS,
                meanCentered: true,
                retrofitBeta: 0.5,
                source: { url: opts.url, zipSha256: opts.expectedZipSha256, entrySha256: opts.expectedEntrySha256 },
            });
            expect(Object.keys(out.packed).sort()).toEqual(['and', 'cat', 'kitten', 'sofa', 'the']);
            expect(out.surfaces).toEqual({});
            const sidecar = fs.readFileSync(path.join(tmp, 'lexicon-embeddings.sha256'), 'utf8');
            expect(sidecar).toBe(`${sha(JSON.stringify({ packed: out.packed, surfaces: out.surfaces }))}\n`);
            expect(logs()).toContain('Mean-centering applied');
            expect(logs()).toContain('Retrofit (beta=0.5) applied to 2 authored words');
            expect(logs()).not.toContain('worst offenders');
        });

        test('keeps the source spelling for a stemmed search word', async () => {
            setup({ concepts: { concepts: [] }, lines: [gloveLine('cats', 1)] });
            await main(opts);
            const out = JSON.parse(fs.readFileSync(opts.outPath, 'utf8'));
            expect(out.surfaces).toEqual({ cat: 'cats' });
        });

        test('handles an empty scan and skips centering when disabled', async () => {
            setup({ concepts: {}, lines: ["o'neil 1 2"] });
            await main({ ...opts, meanCenter: false });
            const out = JSON.parse(fs.readFileSync(opts.outPath, 'utf8'));
            expect(out).toMatchObject({ meanCentered: false, packed: {}, scale: 1 / 127 });
            expect(logs()).not.toContain('Mean-centering');
            expect(logs()).not.toContain('Retrofit');
        });

        test('mean-centering copes with an empty scan', async () => {
            setup({ concepts: {}, lines: [] });
            await main(opts);
            expect(JSON.parse(fs.readFileSync(opts.outPath, 'utf8')).packed).toEqual({});
            expect(logs()).toContain('0 stems stored');
        });
    });

    describe('run', () => {
        test('turns an unexpected rejection into a fatal exit with its stack', async () => {
            // A directory where the archive should be: "cached", but unreadable.
            const cacheDir = path.join(tmp, 'cache');
            const zipPath = path.join(cacheDir, 'glove.zip');
            fs.mkdirSync(zipPath, { recursive: true });
            const conceptsPath = path.join(tmp, 'concepts.json');
            fs.writeFileSync(conceptsPath, '{}');
            await expect(run({ conceptsPath, cacheDir, zipPath })).rejects.toThrow('exit 1');
            expect(errors()).toContain('❌ Error: EISDIR');
        });

        test('stringifies a rejection that carries no stack', async () => {
            jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
                throw 'unreadable';
            });
            await expect(run()).rejects.toThrow('exit 1');
            expect(errors()).toContain('❌ unreadable');
        });
    });
});
