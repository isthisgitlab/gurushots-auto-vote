/** Archive transport: https-only download, cache write and single-entry zip streaming. */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { Entry, Options as YauzlOptions, ZipFile } from 'yauzl';
import { errorMessage } from '../../src/ts/errorMessage';
import { ROOT, MAX_REDIRECTS, ENTRY_NAME, MAX_ENTRY_BYTES } from './config';
import { fail } from './support';

type YauzlOpenCallback = (err: Error | null, zipfile: ZipFile) => void;

/**
 * fetch() that follows redirects itself so every hop is held to https — the
 * built-in redirect handling would follow an https→http downgrade silently.
 */
export const fetchHttpsOnly = async (url: string, maxRedirects = MAX_REDIRECTS): Promise<Response> => {
    let current = url;
    for (let hop = 0; ; hop++) {
        const res = await fetch(current, { redirect: 'manual' });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) return res;
        // Release the redirect's socket instead of leaving it to GC.
        await res.body?.cancel();
        if (hop === maxRedirects) throw new Error(`more than ${maxRedirects} redirects`);
        current = new URL(location, current).href;
        if (!current.startsWith('https://')) throw new Error(`redirected to non-https source: ${current}`);
    }
};

export const download = async ({
    cacheDir,
    zipPath,
    url,
    maxBytes,
}: {
    cacheDir: string;
    zipPath: string;
    url: string;
    maxBytes: number;
}): Promise<void> => {
    fs.mkdirSync(cacheDir, { recursive: true });
    if (fs.existsSync(zipPath)) {
        console.log(`📦 Using cached archive: ${path.relative(ROOT, zipPath)}`);
        return;
    }
    if (!url.startsWith('https://')) fail(`refusing non-https source: ${url}`);
    console.log(`⬇️  Downloading ${url} (~822 MB, one-time — cached afterwards)…`);
    let res;
    try {
        res = await fetchHttpsOnly(url);
    } catch (err) {
        fail([
            `download failed: ${errorMessage(err) || err}`,
            `URL: ${url}`,
            'Check network/proxy access and re-run `pnpm fetch:embeddings` — a completed download is',
            'cached and reused on every later run.',
        ]);
    }
    if (!res.ok || !res.body) {
        fail([`download failed: HTTP ${res.status} ${res.statusText}`, `URL: ${url}`]);
    }
    const tmpPath = `${zipPath}.partial`;
    try {
        // Cap the bytes written before any hash check can run — a wrong or
        // malicious source must not be able to fill the disk first.
        let written = 0;
        const capped = async function* (source: AsyncIterable<Uint8Array>) {
            for await (const chunk of source) {
                written += chunk.length;
                if (written > maxBytes) {
                    throw new Error(`download exceeded ${maxBytes} bytes — not the pinned archive`);
                }
                yield chunk;
            }
        };
        // Open the file HERE, synchronously, not inside createWriteStream: its
        // async open can land after a failed pipeline has already run the
        // cleanup below, re-creating the .partial file it just removed.
        await pipeline(res.body, capped, fs.createWriteStream(tmpPath, { fd: fs.openSync(tmpPath, 'w') }));
        fs.renameSync(tmpPath, zipPath);
    } catch (err) {
        fs.rmSync(tmpPath, { force: true });
        fail([`download interrupted: ${errorMessage(err) || err}`, 'Re-run `pnpm fetch:embeddings` to retry.']);
    }
};

/**
 * Stream the single pinned entry out of the zip, hash it, and hand each line to
 * onLine. Never writes any entry to disk; caps inflated size. Resolves with the
 * entry's SHA-256 once fully consumed.
 *
 * @param zipSource - path to the archive, or its bytes (the
 *   Buffer form exists so tests can exercise this path without any fs)
 * @param limits - inflated-size cap (tests lower it)
 * @returns SHA-256 hex of the entry's inflated bytes
 */
export const streamEntryLines = (
    zipSource: string | Buffer,
    onLine: (line: string) => void,
    { maxEntryBytes = MAX_ENTRY_BYTES }: { maxEntryBytes?: number } = {},
): Promise<string> =>
    new Promise((resolve, reject) => {
        const opener: (opts: YauzlOptions, cb: YauzlOpenCallback) => void = Buffer.isBuffer(zipSource)
            ? (opts, cb) => yauzl.fromBuffer(zipSource, opts, cb)
            : (opts, cb) => yauzl.open(zipSource, opts, cb);
        opener({ lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(new Error(`cannot open zip: ${err.message}`));
            let found = false;
            zipfile.on('entry', (entry: Entry) => {
                if (entry.fileName !== ENTRY_NAME) return zipfile.readEntry();
                found = true;
                if (entry.uncompressedSize > maxEntryBytes) {
                    zipfile.close();
                    return reject(
                        new Error(
                            `entry ${ENTRY_NAME} declares ${entry.uncompressedSize} bytes (> ${maxEntryBytes}); not the pinned file`,
                        ),
                    );
                }
                zipfile.openReadStream(entry, (streamErr, stream) => {
                    if (streamErr) return reject(streamErr);
                    const hash = crypto.createHash('sha256');
                    let inflated = 0;
                    stream.on('data', (chunk: Buffer) => {
                        inflated += chunk.length;
                        if (inflated > maxEntryBytes) {
                            stream.destroy(new Error(`entry inflated past ${maxEntryBytes} bytes — aborting`));
                            return;
                        }
                        hash.update(chunk);
                    });
                    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
                    rl.on('line', onLine);
                    // readline re-emits input errors (e.g. the inflated-size
                    // abort above); unhandled, that throws past `reject` and
                    // leaves the promise pending behind an uncaught exception.
                    rl.on('error', reject);
                    rl.on('close', () => {
                        zipfile.close();
                        resolve(hash.digest('hex'));
                    });
                    stream.on('error', reject);
                });
            });
            zipfile.on('end', () => {
                if (!found) reject(new Error(`entry ${ENTRY_NAME} not found in archive`));
            });
            zipfile.on('error', reject);
            zipfile.readEntry();
        });
    });
