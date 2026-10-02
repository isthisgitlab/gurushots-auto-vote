/** `main`/`run`: orchestrates download, verification, vocabulary selection and the intermediate write. */

import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../../src/ts/errorMessage';
import {
    ROOT,
    CACHE_DIR,
    ZIP_PATH,
    OUT_PATH,
    CONCEPTS_PATH,
    GLOVE_URL,
    ZIP_SHA256,
    ENTRY_NAME,
    ENTRY_SHA256,
    MAX_DOWNLOAD_BYTES,
    DIMS,
    TOP_N,
    CENTER_TOP_N,
    GENERIC_TOKEN_RE,
    BAD_COLLISION_COSINE,
    MAX_BAD_COLLISION_RATE,
    MEAN_CENTER,
    RETROFIT_BETA,
} from './config';
import { fail, sha256OfFile, sha256OfString } from './support';
import { collectAuthoredWords, parseGloveLine, normalize, retrofit, assignStems, quantizePack } from './vectors';
import { download, streamEntryLines } from './archive';

import type { ConceptsConfig } from '../build-lexicon';
import type { ScanRow } from './vectors';

/** main()'s options; every one defaults to the pinned production value. */
export interface MainOptions {
    conceptsPath?: string;
    cacheDir?: string;
    zipPath?: string;
    outPath?: string;
    url?: string;
    expectedZipSha256?: string;
    expectedEntrySha256?: string;
    maxDownloadBytes?: number;
    topN?: number;
    meanCenter?: boolean;
}

/**
 * CLI entry. Every option defaults to the pinned production value; tests
 * override paths (os.tmpdir() fixtures), pins (hashes of a tiny fixture zip)
 * and the scale knobs so the whole pipeline runs offline in milliseconds.
 */
export const main = async ({
    conceptsPath = CONCEPTS_PATH,
    cacheDir = CACHE_DIR,
    zipPath = ZIP_PATH,
    outPath = OUT_PATH,
    url = GLOVE_URL,
    expectedZipSha256 = ZIP_SHA256,
    expectedEntrySha256 = ENTRY_SHA256,
    maxDownloadBytes = MAX_DOWNLOAD_BYTES,
    topN = TOP_N,
    meanCenter = MEAN_CENTER,
}: MainOptions = {}): Promise<void> => {
    const concepts = JSON.parse(fs.readFileSync(conceptsPath, 'utf8')) as ConceptsConfig | null;
    const { bySurface: authored, collisions } = collectAuthoredWords(concepts);
    if (collisions.length) {
        fail([
            `${collisions.length} authored stem collision(s) across clusters:`,
            ...collisions,
            'Each stem must belong to exactly one concept. Fix scripts/lexicon-concepts.json.',
        ]);
    }
    await download({ cacheDir, zipPath, url, maxBytes: maxDownloadBytes });
    const zipSha256 = await sha256OfFile(zipPath);
    if (zipSha256 !== expectedZipSha256) {
        fail([
            `SHA-256 mismatch for the archive:`,
            `expected ${expectedZipSha256}`,
            `got      ${zipSha256}`,
            'Delete scripts/.cache/glove.6B.zip and re-run; if the mismatch persists, do not commit —',
            'the pinned URL is serving different bytes than it did when this pin was recorded.',
        ]);
    }

    // Single frequency-ordered scan. `rows` keeps encounter order (= GloVe
    // frequency order), which assignStems' precedence relies on.
    const rows: Array<ScanRow> = [];
    const authoredFound = new Set<string>();
    let genericKept = 0;
    let parsed = 0;
    const onLine = (line: string) => {
        parsed++;
        const firstSpace = line.indexOf(' ');
        if (firstSpace <= 0) return;
        const token = line.slice(0, firstSpace);
        const isAuthored = authored.has(token);
        if (!isAuthored && (genericKept >= topN || !GENERIC_TOKEN_RE.test(token))) return;
        const row = parseGloveLine(line, DIMS);
        if (!row) return;
        rows.push({ ...row, isAuthored, centerBaseline: isAuthored || genericKept < CENTER_TOP_N });
        if (isAuthored) authoredFound.add(token);
        else genericKept++;
    };

    console.log(`🔍 Scanning ${ENTRY_NAME} for top ${topN} tokens + ${authored.size} authored words…`);
    let entrySha256;
    try {
        entrySha256 = await streamEntryLines(zipPath, onLine);
    } catch (err) {
        fail([
            `extraction failed: ${errorMessage(err) || err}`,
            'The cached archive may be corrupt — delete scripts/.cache/glove.6B.zip and re-run.',
        ]);
    }
    if (entrySha256 !== expectedEntrySha256) {
        fail([
            `SHA-256 mismatch for ${ENTRY_NAME}:`,
            `expected ${expectedEntrySha256}`,
            `got      ${entrySha256}`,
            'The downloaded archive is NOT the pinned upstream file. Delete scripts/.cache/glove.6B.zip,',
            're-run, and if the mismatch persists do not commit — investigate the source before trusting it.',
        ]);
    }
    console.log(`✅ ${ENTRY_NAME} verified (${parsed} lines, sha256 ${entrySha256.slice(0, 12)}…)`);

    const missing = [...authored.keys()].filter((w) => !authoredFound.has(w));
    if (missing.length) {
        fail([
            `${missing.length} authored word(s) have no GloVe vector (checked the full vocabulary):`,
            missing.join(', '),
            'Fix or drop them in scripts/lexicon-concepts.json — the vocab guarantee is enforced, not assumed.',
        ]);
    }

    if (meanCenter) {
        const mean = new Float64Array(DIMS);
        const baseline = rows.filter((row) => row.centerBaseline);
        for (const { vec } of baseline) for (let i = 0; i < DIMS; i++) mean[i] += vec[i];
        for (let i = 0; i < DIMS; i++) mean[i] /= baseline.length || 1;
        for (const { vec } of rows) for (let i = 0; i < DIMS; i++) vec[i] -= mean[i];
        console.log('ℹ️  Mean-centering applied (anisotropy correction).');
    }
    for (const { vec } of rows) normalize(vec);

    const retrofitted = retrofit(rows, authored, RETROFIT_BETA);
    if (retrofitted) console.log(`ℹ️  Retrofit (beta=${RETROFIT_BETA}) applied to ${retrofitted} authored words.`);

    const { stems, merges, badMerges, badSamples } = assignStems(rows, BAD_COLLISION_COSINE);
    const badRate = badMerges / (stems.size || 1);
    console.log(
        `🔗 ${stems.size} stems stored; ${merges} stem merges, of which ${badMerges} look bad ` +
            `(cosine < ${BAD_COLLISION_COSINE}; ${(badRate * 100).toFixed(2)}% of stored vocab)`,
    );
    if (badSamples.length) console.log(`   worst offenders: ${badSamples.join('; ')}`);
    if (badRate > MAX_BAD_COLLISION_RATE) {
        fail([
            `bad stem-merge rate ${(badRate * 100).toFixed(2)}% exceeds the ` +
                `${MAX_BAD_COLLISION_RATE * 100}% ceiling — the stemmer is merging unrelated words at scale.`,
            'Inspect the samples above; fix the stemmer edge case (src/ts/services/photoPicker/stemming.ts) before committing.',
        ]);
    }

    const { scale, packed } = quantizePack(stems, DIMS);
    const surfaces = Object.fromEntries(
        [...stems].filter(([key, row]) => key !== row.token).map(([key, row]) => [key, row.token]),
    );
    const output = {
        version: 1,
        generator: 'fetch-embeddings.ts',
        source: {
            url,
            zipSha256,
            entry: ENTRY_NAME,
            entrySha256,
            retrieved: new Date().toISOString().slice(0, 10),
            license: 'PDDL',
            citation: 'Pennington, Socher, Manning (2014). GloVe: Global Vectors for Word Representation.',
        },
        dims: DIMS,
        scale,
        meanCentered: meanCenter,
        retrofitBeta: RETROFIT_BETA,
        packed,
        surfaces,
    };
    fs.writeFileSync(outPath, JSON.stringify(output));
    // Sidecar payload hash: the intermediate itself is an unreviewable
    // multi-MB blob, so a hand-edit to its vectors would be invisible in a
    // diff. This one-line file makes any payload change show up as a
    // human-readable hunk, and build-lexicon.ts refuses to build if the
    // committed payload no longer matches it.
    fs.writeFileSync(
        `${outPath.replace(/\.json$/, '')}.sha256`,
        `${sha256OfString(JSON.stringify({ packed, surfaces }))}\n`,
    );
    const bytes = fs.statSync(outPath).size;
    console.log(
        `✅ Intermediate: ${stems.size} word-stems, ${DIMS}d, ${(bytes / 1024 / 1024).toFixed(2)} MB ` +
            `→ ${path.relative(ROOT, outPath)}`,
    );
    console.log('   Next: pnpm build:lexicon && pnpm verify:lexicon');
};

export const run = (opts?: MainOptions): Promise<void> =>
    main(opts).catch((err: Error) => fail(err.stack || String(err)));
