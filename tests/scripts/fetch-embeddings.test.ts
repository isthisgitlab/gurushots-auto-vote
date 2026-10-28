/**
 * Tests for scripts/fetch-embeddings.ts — the download, the zip-extraction
 * guards yauzl alone cannot trip, and main()/run() end to end. Fully hermetic:
 * fetch is stubbed (no network), the "archive" is a tiny stored zip built in
 * memory and written into an os.tmpdir() sandbox, and the pins are the hashes
 * of that fixture — the real scripts/.cache, lexicon-embeddings.json and its
 * sidecar are never touched. process.exit is stubbed to throw so a fatal path
 * stops exactly where the real process would.
 */

// tests/setup.ts globally mocks fs and path; this suite needs the real modules.
jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import os = require('node:os');
import pathModule = require('node:path');
const path = jest.mocked(pathModule);
import crypto = require('node:crypto');
const { EventEmitter } = require('node:events') as typeof node_eventsModule;
const { Readable } = require('node:stream') as typeof node_streamModule;
import yauzl = require('yauzl');
import type * as node_eventsModule from 'node:events';
import type * as node_streamModule from 'node:stream';
import type * as fetch_embeddingsModule from '../../scripts/fetch-embeddings';
import type * as configModule from '../../scripts/fetch-embeddings/config';
import type * as stored_zipModule from './helpers/stored-zip';
import { invalid } from '../helpers/invalid';
import type { MainOptions } from '../../scripts/fetch-embeddings';
import type { Intermediate } from '../../scripts/build-lexicon';
import { isRecordOf, isShape, isString, optional, parseJsonAs } from '../helpers/parseJson';

const isWrittenIntermediate = isShape<Pick<Intermediate, 'packed' | 'surfaces'>>({
    packed: optional(isRecordOf(isString)),
    surfaces: optional(isRecordOf(isString)),
});

/** The intermediate main() writes to outPath (fetch-embeddings' `output`). */

type OpenCallback = (err: Error | null, zipfile: yauzl.ZipFile) => void;
type FakeOpenReadStream = (
    entry: yauzl.Entry,
    done: (err: Error | null, stream?: node_streamModule.Readable) => void,
) => void;

const { download, fetchHttpsOnly, main, run, sha256OfFile, streamEntryLines, ENTRY_NAME } =
    require('../../scripts/fetch-embeddings') as typeof fetch_embeddingsModule;
const config = require('../../scripts/fetch-embeddings/config') as typeof configModule;
const { makeStoredZip } = require('./helpers/stored-zip') as typeof stored_zipModule;

const DIMS = 100;
const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

// One GloVe text line: the token plus DIMS numbers derived from `seed`, so
// different seeds give clearly different directions.
const gloveLine = (token: string, seed: number, sign = 1) =>
    `${token} ${Array.from({ length: DIMS }, (_, i) => (sign * Math.sin(seed * (i + 1))).toFixed(4)).join(' ')}`;

// A controllable stand-in for a yauzl zipfile, for the guards a well-formed
// archive can never reach (yauzl validates sizes itself).
const fakeZipfile = ({
    entry,
    openReadStream,
}: {
    entry?: { fileName: string; uncompressedSize: number };
    openReadStream?: FakeOpenReadStream;
}) => {
    const zip = invalid<yauzl.ZipFile>(new EventEmitter());
    zip.close = jest.fn();
    zip.readEntry = () => {
        if (entry) setImmediate(() => zip.emit('entry', entry));
    };
    zip.openReadStream = invalid(openReadStream);
    return zip;
};

describe('fetch-embeddings', () => {
    let tmp: string;
    let exitSpy: jest.SpiedFunction<typeof process.exit>;
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;

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

    describe('config', () => {
        const scriptsDir = path.join(__dirname, '..', '..', 'scripts');

        test('default cache, zip and output paths resolve under scripts/', () => {
            expect(config.CACHE_DIR).toBe(path.join(scriptsDir, '.cache'));
            expect(config.ZIP_PATH).toBe(path.join(scriptsDir, '.cache', 'glove.6B.zip'));
            expect(config.OUT_PATH).toBe(path.join(scriptsDir, 'lexicon-embeddings.json'));
        });

        test('production integrity pins and limits are fixed', () => {
            expect(config.GLOVE_URL).toBe('https://nlp.stanford.edu/data/glove.6B.zip');
            expect(new URL(config.GLOVE_URL).protocol).toBe('https:');
            expect(config.ZIP_SHA256).toBe('617afb2fe6cbd085c235baf7a465b96f4112bd7f7ccb2b2cbd649fed9cbcf2fb');
            expect(config.ENTRY_SHA256).toBe('95dde4dfd627ab26608d33e76d1195ec059734bd29089ea52cadb08d07c64544');
            expect(config.MAX_DOWNLOAD_BYTES).toBe(1073741824);
            expect(config.MAX_ENTRY_BYTES).toBe(1073741824);
            expect(config.MAX_REDIRECTS).toBe(5);
        });

        test('compound selection pins: regex shape and the 150000 line-rank cap', () => {
            expect(config.COMPOUND_TOKEN_RE.test('close-up')).toBe(true);
            expect(config.COMPOUND_TOKEN_RE.test('black-and-white')).toBe(true);
            expect(config.COMPOUND_TOKEN_RE.test('cat')).toBe(false); // no hyphen
            expect(config.COMPOUND_TOKEN_RE.test('x-ray')).toBe(false); // single-letter part
            expect(config.COMPOUND_TOKEN_RE.test('a-b-c-d')).toBe(false); // more than three parts
            expect(config.COMPOUND_TOKEN_RE.test('close-Ups')).toBe(false); // uppercase
            expect(config.COMPOUND_TOKEN_RE.test('close-ups-')).toBe(false); // trailing hyphen
            expect(config.COMPOUND_TOP_N).toBe(150000);
        });
    });

    describe('download', () => {
        let opts: Parameters<typeof download>[0];
        let fetchSpy: jest.SpiedFunction<typeof fetch>;

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
                .mockResolvedValueOnce(
                    invalid({
                        status: 301,
                        headers: new Headers({ location: '/moved/glove.zip' }),
                        body: { cancel },
                    }),
                )
                .mockResolvedValueOnce(invalid({ ok: true, status: 200, body: Readable.from([Buffer.from('zip')]) }));
            await download(opts);
            expect(fetchSpy.mock.calls).toEqual([
                ['https://example.test/glove.zip', { redirect: 'manual' }],
                ['https://example.test/moved/glove.zip', { redirect: 'manual' }],
            ]);
            expect(fs.readFileSync(opts.zipPath, 'utf8')).toBe('zip');
            expect(cancel).toHaveBeenCalledTimes(1);
        });

        test('refuses a redirect that downgrades to http', async () => {
            fetchSpy.mockResolvedValue(
                invalid({ status: 302, headers: new Headers({ location: 'http://example.test/x' }) }),
            );
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
            fetchSpy.mockResolvedValue(invalid({ ok: false, status: 404, statusText: 'Not Found', body: null }));
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('HTTP 404 Not Found');
        });

        test('fails on an OK response with no body', async () => {
            fetchSpy.mockResolvedValue(invalid({ ok: true, status: 200, statusText: 'OK', body: null }));
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('HTTP 200 OK');
        });

        test('streams the body into the cache via a .partial file', async () => {
            fetchSpy.mockResolvedValue(
                invalid({ ok: true, body: Readable.from([Buffer.from('zip'), Buffer.from('bytes')]) }),
            );
            await download(opts);
            expect(fs.readFileSync(opts.zipPath, 'utf8')).toBe('zipbytes');
            expect(fs.existsSync(`${opts.zipPath}.partial`)).toBe(false);
        });

        test('aborts and removes the partial file once the byte cap is exceeded', async () => {
            fetchSpy.mockResolvedValue(
                invalid({ ok: true, body: Readable.from([Buffer.alloc(10), Buffer.alloc(10)]) }),
            );
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
            fetchSpy.mockResolvedValue(invalid({ ok: true, body }));
            await expect(download(opts)).rejects.toThrow('exit 1');
            expect(errors()).toContain('download interrupted: socket hang up');
        });
    });

    describe('fetchHttpsOnly', () => {
        test('gives up past the redirect limit', async () => {
            const fetchSpy = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(
                    invalid({ status: 307, headers: new Headers({ location: 'https://example.test/loop' }) }),
                );
            await expect(fetchHttpsOnly('https://example.test/a', 2)).rejects.toThrow('more than 2 redirects');
            expect(fetchSpy).toHaveBeenCalledTimes(3);
        });

        test('returns a 3xx without a Location as-is', async () => {
            const res = invalid<Response>({ ok: false, status: 304, headers: new Headers() });
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
            jest.spyOn(yauzl, 'fromBuffer').mockImplementation(
                invalid((_buf: Buffer, _opts: yauzl.Options, cb: OpenCallback) =>
                    cb(null, fakeZipfile({ entry, openReadStream: (_e, done) => done(new Error('bad method')) })),
                ),
            );
            await expect(streamEntryLines(Buffer.from('x'), () => {})).rejects.toThrow('bad method');
        });

        test('aborts once the inflated bytes pass the cap, whatever the entry declared', async () => {
            jest.spyOn(yauzl, 'fromBuffer').mockImplementation(
                invalid((_buf: Buffer, _opts: yauzl.Options, cb: OpenCallback) =>
                    cb(
                        null,
                        fakeZipfile({
                            entry,
                            openReadStream: (_e, done) =>
                                done(null, Readable.from([Buffer.from('aaaa\nbbbb\ncccc\n')])),
                        }),
                    ),
                ),
            );
            await expect(streamEntryLines(Buffer.from('x'), () => {}, { maxEntryBytes: 5 })).rejects.toThrow(
                'entry inflated past 5 bytes',
            );
        });

        test('propagates a zipfile-level error', async () => {
            const zip = fakeZipfile({});
            jest.spyOn(yauzl, 'fromBuffer').mockImplementation(
                invalid((_buf: Buffer, _opts: yauzl.Options, cb: OpenCallback) => cb(null, zip)),
            );
            const pending = streamEntryLines(Buffer.from('x'), () => {});
            zip.emit('error', new Error('invalid central directory'));
            await expect(pending).rejects.toThrow('invalid central directory');
        });

        test("a late 'end' after the entry was found does not reject", async () => {
            const zip = fakeZipfile({
                entry,
                openReadStream: (_e, done) => done(null, Readable.from([Buffer.from('ok\n')])),
            });
            jest.spyOn(yauzl, 'fromBuffer').mockImplementation(
                invalid((_buf: Buffer, _opts: yauzl.Options, cb: OpenCallback) => cb(null, zip)),
            );
            const lines: string[] = [];
            await expect(streamEntryLines(Buffer.from('x'), (l) => lines.push(l))).resolves.toBe(sha('ok\n'));
            zip.emit('end');
            expect(lines).toEqual(['ok']);
            expect(zip.close).toHaveBeenCalled();
        });
    });

    describe('main', () => {
        let opts: MainOptions &
            Required<Pick<MainOptions, 'conceptsPath' | 'cacheDir' | 'zipPath' | 'outPath' | 'url'>>;

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
        const setup = ({
            concepts = CONCEPTS,
            lines = HAPPY_LINES,
            ...rest
        }: { concepts?: object; lines?: string[]; expectedZipSha256?: string; expectedEntrySha256?: string } = {}) => {
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

        test.each([[[]], [{}], [{ concepts: 'cat' }]])(
            'fails on a concepts file without a concepts list (%j) instead of treating it as empty',
            async (concepts) => {
                setup({ concepts, expectedZipSha256: 'f'.repeat(64) });
                await expect(main(opts)).rejects.toThrow('exit 1');
                expect(errors()).toContain('lexicon-concepts.json must be a JSON object with a `concepts` list');
                expect(errors()).not.toContain('SHA-256 mismatch for the archive');
            },
        );

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
            jest.spyOn(yauzl, 'open').mockImplementation(
                invalid((_p: string, _o: yauzl.Options, cb: OpenCallback) => {
                    cb(null, zip);
                    zip.emit('error', 'truncated');
                }),
            );
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
            const out = parseJsonAs(fs.readFileSync(opts.outPath, 'utf8'), isWrittenIntermediate);
            expect(out).toMatchObject({
                version: 1,
                dims: DIMS,
                meanCentered: true,
                retrofitBeta: 0.5,
                source: { url: opts.url, zipSha256: opts.expectedZipSha256, entrySha256: opts.expectedEntrySha256 },
            });
            expect(Object.keys(out.packed!).sort()).toEqual(['and', 'cat', 'kitten', 'sofa', 'the']);
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
            const out = parseJsonAs(fs.readFileSync(opts.outPath, 'utf8'), isWrittenIntermediate);
            expect(out.surfaces).toEqual({ cat: 'cats' });
        });

        test('handles an empty scan and skips centering when disabled', async () => {
            setup({ concepts: { concepts: [] }, lines: ["o'neil 1 2"] });
            await main({ ...opts, meanCenter: false });
            const out = parseJsonAs(fs.readFileSync(opts.outPath, 'utf8'), isWrittenIntermediate);
            expect(out).toMatchObject({ meanCentered: false, packed: {}, scale: 1 / 127 });
            expect(logs()).not.toContain('Mean-centering');
            expect(logs()).not.toContain('Retrofit');
        });

        test('mean-centering copes with an empty scan', async () => {
            setup({ concepts: { concepts: [] }, lines: [] });
            await main(opts);
            expect(parseJsonAs(fs.readFileSync(opts.outPath, 'utf8'), isWrittenIntermediate).packed).toEqual({});
            expect(logs()).toContain('0 stems stored');
        });

        describe('compound tokens', () => {
            // Six generic rows (topN 6: the/close/up/ups/way/out), then the
            // compounds. close-ups shares close-up's stem but sits at a later
            // rank; cold-shoulder's parts are never kept as rows; "hot-spring
            // 1 2" is compound-shaped but malformed (2 dims).
            const COMPOUND_LINES = [
                gloveLine('the', 1),
                gloveLine('close', 2),
                gloveLine('up', 3),
                gloveLine('ups', 4),
                gloveLine('way', 5),
                gloveLine('out', 6),
                gloveLine('close-up', 7),
                gloveLine('close-ups', 7), // same lemma direction: a benign merge
                gloveLine('cold-shoulder', 8),
                gloveLine('way-out', 10),
                'hot-spring 1 2',
            ];
            const GENERIC_KEYS = ['close', 'out', 'the', 'up', 'ups', 'way'];

            const readOut = () => parseJsonAs(fs.readFileSync(opts.outPath, 'utf8'), isWrittenIntermediate);
            const decode = (b64: string) => {
                const buf = Buffer.from(b64, 'base64');
                return Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.length));
            };
            const cosine = (a: number[], b: number[]) => {
                let dot = 0;
                let na = 0;
                let nb = 0;
                for (let i = 0; i < DIMS; i++) {
                    dot += a[i] * b[i];
                    na += a[i] * a[i];
                    nb += b[i] * b[i];
                }
                return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
            };

            test('parses buffered compounds only after the entry hash check passes', async () => {
                setup({ concepts: { concepts: [] }, lines: COMPOUND_LINES, expectedEntrySha256: '0'.repeat(64) });
                await expect(main({ ...opts, topN: 6, compoundTopN: 11 })).rejects.toThrow('exit 1');
                expect(errors()).toContain(`SHA-256 mismatch for ${ENTRY_NAME}`);
                expect(fs.existsSync(opts.outPath)).toBe(false);
            });

            test('keeps rank-ordered compounds whose parts are kept rows and drops the rest', async () => {
                setup({ concepts: { concepts: [] }, lines: COMPOUND_LINES });
                await main({ ...opts, topN: 6, compoundTopN: 11 });
                const out = readOut();
                // The 6 generic keys plus close-up (rank 7) and way-out (rank
                // 10). hot-spring is malformed; cold-shoulder's parts are absent.
                expect(Object.keys(out.packed!).sort()).toEqual([...GENERIC_KEYS, 'close-up', 'way-out'].sort());
                // close-up won the shared stem from the LATER close-ups by rank:
                // a close-ups win would read { "close-up": "close-ups" } here.
                expect(out.surfaces).toEqual({});
            });

            test('drops a compound past the compoundTopN rank cap', async () => {
                setup({ concepts: { concepts: [] }, lines: COMPOUND_LINES });
                await main({ ...opts, topN: 6, compoundTopN: 9 });
                const out = readOut();
                // way-out sits at line rank 10, one past the cap; close-up at
                // rank 7 is still within it.
                expect(Object.keys(out.packed!).sort()).toEqual([...GENERIC_KEYS, 'close-up'].sort());
            });

            test('leaves the generic row count and the centering set unchanged by compounds', async () => {
                setup({ concepts: { concepts: [] }, lines: COMPOUND_LINES });
                await main({ ...opts, topN: 6, compoundTopN: 0 }); // cap 0 buffers nothing
                const off = readOut();
                await main({ ...opts, topN: 6, compoundTopN: 11 });
                const on = readOut();
                // 6 generic keys, the same fixture count as with compounds off.
                expect(Object.keys(off.packed!).sort()).toEqual(GENERIC_KEYS);
                const genericKeys = Object.keys(on.packed!).filter((k) => !k.includes('-'));
                expect(genericKeys.sort()).toEqual(GENERIC_KEYS);
                // Byte-equal generic vectors would be a stronger pin, but the
                // quantization scale is table-wide and a compound row may move
                // it. The decoded directions must still match: a compound that
                // joined the centering baseline would shift the mean — and with
                // it every generic direction — measurably.
                for (const key of genericKeys) {
                    expect(cosine(decode(on.packed![key]), decode(off.packed![key]))).toBeGreaterThan(0.99);
                }
            });

            test('counts compound stem merges in the bad-collision rate over the grown denominator', async () => {
                setup({ concepts: { concepts: [] }, lines: COMPOUND_LINES });
                await main({ ...opts, topN: 6, compoundTopN: 11 });
                // 8 stored stems — the compounds join stems.size, the rate's
                // denominator — and exactly one merge, close-ups into
                // close-up's key, benign with the shared lemma direction.
                expect(logs()).toContain(
                    '🔗 8 stems stored; 1 stem merges, of which 0 look bad (cosine < 0.4; 0.00% of stored vocab)',
                );
            });

            test('keeps an authored compound-shaped word as authored instead of buffering it', async () => {
                setup({
                    concepts: { concepts: [{ id: 'known', parent: 'known', words: ['well-known'] }] },
                    lines: [
                        gloveLine('the', 1),
                        gloveLine('well-known', 2),
                        gloveLine('well', 3),
                        gloveLine('known', 4),
                    ],
                });
                await main({ ...opts, topN: 3, compoundTopN: 10 });
                const out = readOut();
                // Buffering it would skip the authored claim and fail main()
                // with "authored word(s) have no GloVe vector". known is rank 4
                // and still kept: authored rows do not consume topN.
                expect(Object.keys(out.packed!).sort()).toEqual(['known', 'the', 'well', 'well-known']);
            });
        });
    });

    describe('run', () => {
        test('turns an unexpected rejection into a fatal exit with its stack', async () => {
            // A directory where the archive should be: "cached", but unreadable.
            const cacheDir = path.join(tmp, 'cache');
            const zipPath = path.join(cacheDir, 'glove.zip');
            fs.mkdirSync(zipPath, { recursive: true });
            const conceptsPath = path.join(tmp, 'concepts.json');
            fs.writeFileSync(conceptsPath, '{"concepts":[]}');
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
