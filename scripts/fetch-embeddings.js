#!/usr/bin/env node

/**
 * GloVe embedding fetcher — the ONLY network-touching step of the lexicon
 * pipeline. Run manually via `pnpm fetch:embeddings` after editing
 * scripts/lexicon-concepts.json; everything downstream (build:lexicon,
 * verify:lexicon, CI) is offline and deterministic given the committed
 * intermediate this script writes.
 *
 * What it does:
 *   1. Downloads (or reuses from scripts/.cache/) the pinned GloVe 6B archive
 *      and streams out the single glove.6B.100d.txt entry — no entry paths are
 *      ever written to disk (zip-slip impossible), inflated size is capped
 *      (decompression-bomb guard), and the entry's bytes are SHA-256-verified
 *      against a hard-coded pin before any output is written.
 *   2. Selects the vocabulary: the top TOP_N frequency-ranked tokens that pass
 *      the [a-z]{2,20} filter, PLUS every word from lexicon-concepts.json
 *      (concepts + extraWords), looked up in the full 400k vocabulary. An
 *      authored word with no GloVe vector at all is a FATAL error — the vocab
 *      guarantee is enforced here, not assumed.
 *   3. Mean-centers (anisotropy correction), normalizes, and retrofits each
 *      authored word toward its cluster centroid (Faruqui et al. 2015) so the
 *      curated "is a kind of" knowledge the distributional vectors under-
 *      represent (sunflower<->flower) is injected into the shipped table.
 *   4. Maps words to stems with the matcher's own stemmer. Collision policy:
 *      authored words always beat generic tokens; generic-vs-generic keeps the
 *      more frequent word; authored-vs-authored across clusters is fatal (an
 *      authoring mistake). Merges whose two vectors disagree (cosine below
 *      BAD_COLLISION_COSINE — i.e. NOT inflections of one lemma) are counted
 *      and gated by a sanity ceiling so a stemmer regression at 10k-word scale
 *      fails loudly.
 *   5. int8-quantizes with one global scale and writes the packed base64
 *      intermediate scripts/lexicon-embeddings.json with full provenance
 *      (URL, zip + entry SHA-256, retrieval date, license).
 *
 * GloVe 6B (Wikipedia 2014 + Gigaword 5) is released under the PDDL — see
 * https://nlp.stanford.edu/projects/glove/ (Pennington, Socher, Manning 2014).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { stem } = require('../src/js/services/photoPicker');

const GLOVE_URL = 'https://nlp.stanford.edu/data/glove.6B.zip';
// SHA-256 of the whole archive as served by the pinned URL. The entry hash
// below is the actual trust anchor for the data used; this outer pin just
// catches a swapped/truncated download one step earlier.
const ZIP_SHA256 = '617afb2fe6cbd085c235baf7a465b96f4112bd7f7ccb2b2cbd649fed9cbcf2fb';
const ENTRY_NAME = 'glove.6B.100d.txt';
// SHA-256 of the extracted glove.6B.100d.txt — the exact bytes this pipeline
// consumes. Verified on every run, cached or fresh; a mismatch aborts before
// anything is written. (Matches the independently published hash of the file,
// e.g. github.com/tsajed/data.)
const ENTRY_SHA256 = '95dde4dfd627ab26608d33e76d1195ec059734bd29089ea52cadb08d07c64544';
// Refuse to write more than this to the cache — a swapped/looping source
// should fail fast, not fill the disk. The real archive is ~822 MB.
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DIMS = 100;
// Top-N frequency-ranked generic tokens (counted AFTER the filter below, so the
// stored generic vocab really is ~TOP_N stems, not "top lines minus rejects").
const TOP_N = 10000;
const GENERIC_TOKEN_RE = /^[a-z]{2,20}$/;
// glove.6B.100d.txt is ~347 MB; anything past this is not the file we pinned.
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
// Most stem merges are the stemmer doing its job: inflected forms of one lemma
// ("days" -> "day") folding onto one key, whose vectors are near-identical, so
// keeping the more frequent form loses nothing. A merge is only a problem when
// the two words mean DIFFERENT things ("coping" -> "cop") — and with the real
// vectors in hand that is directly measurable: below this cosine the merged
// words are not the same lemma, and the dropped word's meaning is silently
// replaced by an unrelated vector.
const BAD_COLLISION_COSINE = 0.4;
// Bad merges (per the cosine test above) beyond this fraction of the stored
// vocab mean the light stemmer is destroying meaning at scale — fail loudly
// rather than silently shipping degraded vectors.
const MAX_BAD_COLLISION_RATE = 0.05;
// Anisotropy correction: subtract the corpus-mean vector before normalizing.
// GloVe vectors cluster in a narrow cone, so without this, unrelated word
// pairs carry a spurious positive baseline — measured on this vocabulary it
// pushed the validator's unrelated p99 above any workable floor (and let a
// "farm" challenge score sea-life labels above it). Centering costs a little
// related-pair similarity, which the retrofit below more than recovers for
// the curated clusters.
const MEAN_CENTER = true;
// Retrofit strength (Faruqui et al. 2015, "Retrofitting word vectors to
// semantic lexicons"): each authored word is blended toward its cluster's
// centroid, injecting the curated synonym knowledge ("sunflower" IS a
// "flower") that plain distributional vectors under-represent — GloVe puts
// sunflower<->flower at ~0.35, below any workable floor, because the words
// appear in different contexts (oil/seeds/van Gogh vs gardens). 0 disables;
// 1 collapses each cluster to its centroid (the old synthetic behavior).
const RETROFIT_BETA = 0.5;

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.cache');
const ZIP_PATH = path.join(CACHE_DIR, 'glove.6B.zip');
const OUT_PATH = path.join(__dirname, 'lexicon-embeddings.json');
const CONCEPTS_PATH = path.join(__dirname, 'lexicon-concepts.json');

const fail = (lines) => {
    console.error(`❌ ${Array.isArray(lines) ? lines.join('\n   ') : lines}`);
    process.exit(1);
};

const sha256OfFile = (filePath) =>
    new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });

const sha256OfString = (str) => crypto.createHash('sha256').update(str).digest('hex');

/**
 * Authored vocabulary: surface word -> owning concept id (or 'extraWords'),
 * plus any cross-cluster stem collisions (an authoring mistake the caller
 * treats as fatal, mirroring build-lexicon.js). Pure — takes the parsed
 * concepts config, exits nowhere.
 *
 * @param {object} concepts - parsed lexicon-concepts.json
 * @returns {{bySurface: Map<string,string>, collisions: Array<string>}}
 */
const collectAuthoredWords = (concepts) => {
    const bySurface = new Map();
    const stemOwner = new Map();
    const collisions = [];
    const claim = (word, owner) => {
        const surface = String(word).toLowerCase();
        if (!bySurface.has(surface)) bySurface.set(surface, owner);
        const key = stem(surface);
        if (!key || key.length < 2) return;
        if (stemOwner.has(key) && stemOwner.get(key) !== owner) {
            collisions.push(`${key} (${stemOwner.get(key)} -> ${owner})`);
        }
        stemOwner.set(key, owner);
    };
    for (const concept of (concepts && concepts.concepts) || []) {
        for (const word of concept.words || []) claim(word, concept.id);
    }
    for (const word of (concepts && concepts.extraWords) || []) claim(word, 'extraWords');
    return { bySurface, collisions };
};

/**
 * Parse one GloVe text line ("token v1 v2 … vN") into { token, vec }, or null
 * when the line is malformed or the wrong dimensionality.
 */
const parseGloveLine = (line, dims) => {
    const firstSpace = line.indexOf(' ');
    if (firstSpace <= 0) return null;
    const token = line.slice(0, firstSpace);
    const parts = line.slice(firstSpace + 1).split(' ');
    if (parts.length !== dims) return null;
    const vec = new Float64Array(dims);
    for (let i = 0; i < dims; i++) {
        vec[i] = Number(parts[i]);
        if (!Number.isFinite(vec[i])) return null;
    }
    return { token, vec };
};

const normalize = (vec) => {
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
};

const cosineOf = (a, b) => {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
};

/**
 * Blend each authored word's (already unit-length) vector toward its cluster
 * centroid, then re-normalize — Faruqui-style retrofitting. Mutates the rows'
 * vectors in place. extraWords have no cluster and are left untouched;
 * single-word clusters are a no-op by construction.
 *
 * @param {Array<{token:string, vec:Float64Array, isAuthored:boolean}>} rows
 * @param {Map<string,string>} authored - surface word -> owner id
 * @param {number} beta - blend strength in [0, 1]
 * @returns {number} how many vectors were adjusted
 */
const retrofit = (rows, authored, beta) => {
    if (!(beta > 0)) return 0;
    const clusters = new Map();
    for (const row of rows) {
        if (!row.isAuthored) continue;
        const owner = authored.get(row.token);
        if (!owner || owner === 'extraWords') continue;
        if (!clusters.has(owner)) clusters.set(owner, []);
        clusters.get(owner).push(row.vec);
    }
    let retrofitted = 0;
    for (const members of clusters.values()) {
        if (members.length < 2) continue;
        const dims = members[0].length;
        const centroid = new Float64Array(dims);
        for (const vec of members) for (let i = 0; i < dims; i++) centroid[i] += vec[i];
        for (let i = 0; i < dims; i++) centroid[i] /= members.length;
        for (const vec of members) {
            for (let i = 0; i < dims; i++) vec[i] = (1 - beta) * vec[i] + beta * centroid[i];
            normalize(vec);
            retrofitted++;
        }
    }
    return retrofitted;
};

/**
 * Fold rows onto stem keys with the collision policy described in the header:
 * authored rows claim their stems first (in row order — GloVe frequency order),
 * generic rows only fill still-free stems. A generic merge whose two vectors
 * disagree (cosine < badCosine) is counted as bad.
 *
 * @param {Array<{token:string, vec:Float64Array, isAuthored:boolean}>} rows
 * @param {number} badCosine
 * @returns {{stems: Map<string, object>, merges: number, badMerges: number, badSamples: Array<string>}}
 */
const assignStems = (rows, badCosine) => {
    const stems = new Map();
    const badSamples = [];
    let merges = 0;
    let badMerges = 0;
    for (const authoredPass of [true, false]) {
        for (const row of rows) {
            if (row.isAuthored !== authoredPass) continue;
            const key = stem(row.token);
            if (!key || key.length < 2) continue;
            const existing = stems.get(key);
            if (existing) {
                if (!row.isAuthored) {
                    merges++;
                    if (cosineOf(existing.vec, row.vec) < badCosine) {
                        badMerges++;
                        if (badSamples.length < 20) {
                            badSamples.push(`${row.token} -> ${key} (kept ${existing.token})`);
                        }
                    }
                }
                continue;
            }
            stems.set(key, row);
        }
    }
    return { stems, merges, badMerges, badSamples };
};

/**
 * int8-quantize every stem's vector with one global scale and pack each as
 * base64 (two's-complement bytes — the runtime decoder reinterprets them as
 * signed).
 *
 * @param {Map<string, {vec: Float64Array}>} stems
 * @param {number} dims
 * @returns {{scale: number, packed: object}}
 */
const quantizePack = (stems, dims) => {
    let maxAbs = 0;
    for (const { vec } of stems.values()) for (const x of vec) maxAbs = Math.max(maxAbs, Math.abs(x));
    const scale = maxAbs / 127 || 1 / 127;
    const packed = Object.create(null);
    for (const [key, { vec }] of stems) {
        const q = new Int8Array(dims);
        for (let i = 0; i < dims; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
        packed[key] = Buffer.from(q.buffer, q.byteOffset, q.byteLength).toString('base64');
    }
    return { scale, packed };
};

const download = async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (fs.existsSync(ZIP_PATH)) {
        console.log(`📦 Using cached archive: ${path.relative(ROOT, ZIP_PATH)}`);
        return;
    }
    if (!GLOVE_URL.startsWith('https://')) fail(`refusing non-https source: ${GLOVE_URL}`);
    console.log(`⬇️  Downloading ${GLOVE_URL} (~822 MB, one-time — cached afterwards)…`);
    let res;
    try {
        res = await fetch(GLOVE_URL);
    } catch (err) {
        fail([
            `download failed: ${err.message || err}`,
            `URL: ${GLOVE_URL}`,
            'Check network/proxy access and re-run `pnpm fetch:embeddings` — a completed download is',
            'cached and reused on every later run.',
        ]);
    }
    if (!res.ok || !res.body) {
        fail([`download failed: HTTP ${res.status} ${res.statusText}`, `URL: ${GLOVE_URL}`]);
    }
    const tmpPath = `${ZIP_PATH}.partial`;
    try {
        // Cap the bytes written before any hash check can run — a wrong or
        // malicious source must not be able to fill the disk first.
        let written = 0;
        const capped = async function* (source) {
            for await (const chunk of source) {
                written += chunk.length;
                if (written > MAX_DOWNLOAD_BYTES) {
                    throw new Error(`download exceeded ${MAX_DOWNLOAD_BYTES} bytes — not the pinned archive`);
                }
                yield chunk;
            }
        };
        await pipeline(res.body, capped, fs.createWriteStream(tmpPath));
        fs.renameSync(tmpPath, ZIP_PATH);
    } catch (err) {
        fs.rmSync(tmpPath, { force: true });
        fail([`download interrupted: ${err.message || err}`, 'Re-run `pnpm fetch:embeddings` to retry.']);
    }
};

/**
 * Stream the single pinned entry out of the zip, hash it, and hand each line to
 * onLine. Never writes any entry to disk; caps inflated size. Resolves with the
 * entry's SHA-256 once fully consumed.
 *
 * @param {string|Buffer} zipSource - path to the archive, or its bytes (the
 *   Buffer form exists so tests can exercise this path without any fs)
 * @param {(line: string) => void} onLine
 * @returns {Promise<string>} SHA-256 hex of the entry's inflated bytes
 */
const streamEntryLines = (zipSource, onLine) =>
    new Promise((resolve, reject) => {
        const opener = Buffer.isBuffer(zipSource)
            ? (opts, cb) => yauzl.fromBuffer(zipSource, opts, cb)
            : (opts, cb) => yauzl.open(zipSource, opts, cb);
        opener({ lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(new Error(`cannot open zip: ${err.message}`));
            let found = false;
            zipfile.on('entry', (entry) => {
                if (entry.fileName !== ENTRY_NAME) return zipfile.readEntry();
                found = true;
                if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
                    zipfile.close();
                    return reject(
                        new Error(
                            `entry ${ENTRY_NAME} declares ${entry.uncompressedSize} bytes (> ${MAX_ENTRY_BYTES}); not the pinned file`,
                        ),
                    );
                }
                zipfile.openReadStream(entry, (streamErr, stream) => {
                    if (streamErr) return reject(streamErr);
                    const hash = crypto.createHash('sha256');
                    let inflated = 0;
                    stream.on('data', (chunk) => {
                        inflated += chunk.length;
                        if (inflated > MAX_ENTRY_BYTES) {
                            stream.destroy(new Error(`entry inflated past ${MAX_ENTRY_BYTES} bytes — aborting`));
                            return;
                        }
                        hash.update(chunk);
                    });
                    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
                    rl.on('line', onLine);
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

const main = async () => {
    const concepts = JSON.parse(fs.readFileSync(CONCEPTS_PATH, 'utf8'));
    const { bySurface: authored, collisions } = collectAuthoredWords(concepts);
    if (collisions.length) {
        fail([
            `${collisions.length} authored stem collision(s) across clusters:`,
            ...collisions,
            'Each stem must belong to exactly one concept. Fix scripts/lexicon-concepts.json.',
        ]);
    }
    await download();
    const zipSha256 = await sha256OfFile(ZIP_PATH);
    if (zipSha256 !== ZIP_SHA256) {
        fail([
            `SHA-256 mismatch for the archive:`,
            `expected ${ZIP_SHA256}`,
            `got      ${zipSha256}`,
            'Delete scripts/.cache/glove.6B.zip and re-run; if the mismatch persists, do not commit —',
            'the pinned URL is serving different bytes than it did when this pin was recorded.',
        ]);
    }

    // Single frequency-ordered scan. `rows` keeps encounter order (= GloVe
    // frequency order), which assignStems' precedence relies on.
    const rows = [];
    const authoredFound = new Set();
    let genericKept = 0;
    let parsed = 0;
    const onLine = (line) => {
        parsed++;
        const firstSpace = line.indexOf(' ');
        if (firstSpace <= 0) return;
        const token = line.slice(0, firstSpace);
        const isAuthored = authored.has(token);
        if (!isAuthored && (genericKept >= TOP_N || !GENERIC_TOKEN_RE.test(token))) return;
        const row = parseGloveLine(line, DIMS);
        if (!row) return;
        rows.push({ ...row, isAuthored });
        if (isAuthored) authoredFound.add(token);
        else genericKept++;
    };

    console.log(`🔍 Scanning ${ENTRY_NAME} for top ${TOP_N} tokens + ${authored.size} authored words…`);
    let entrySha256;
    try {
        entrySha256 = await streamEntryLines(ZIP_PATH, onLine);
    } catch (err) {
        fail([
            `extraction failed: ${err.message || err}`,
            'The cached archive may be corrupt — delete scripts/.cache/glove.6B.zip and re-run.',
        ]);
    }
    if (entrySha256 !== ENTRY_SHA256) {
        fail([
            `SHA-256 mismatch for ${ENTRY_NAME}:`,
            `expected ${ENTRY_SHA256}`,
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

    if (MEAN_CENTER) {
        const mean = new Float64Array(DIMS);
        for (const { vec } of rows) for (let i = 0; i < DIMS; i++) mean[i] += vec[i];
        for (let i = 0; i < DIMS; i++) mean[i] /= rows.length || 1;
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
            'Inspect the samples above; fix the stemmer edge case (src/js/services/photoPicker.js) before committing.',
        ]);
    }

    const { scale, packed } = quantizePack(stems, DIMS);
    const output = {
        version: 1,
        generator: 'fetch-embeddings.js',
        source: {
            url: GLOVE_URL,
            zipSha256,
            entry: ENTRY_NAME,
            entrySha256,
            retrieved: new Date().toISOString().slice(0, 10),
            license: 'PDDL',
            citation: 'Pennington, Socher, Manning (2014). GloVe: Global Vectors for Word Representation.',
        },
        dims: DIMS,
        scale,
        meanCentered: MEAN_CENTER,
        retrofitBeta: RETROFIT_BETA,
        packed,
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(output));
    // Sidecar payload hash: the intermediate itself is an unreviewable
    // multi-MB blob, so a hand-edit to its vectors would be invisible in a
    // diff. This one-line file makes any payload change show up as a
    // human-readable hunk, and build-lexicon.js refuses to build if the
    // committed payload no longer matches it.
    fs.writeFileSync(`${OUT_PATH.replace(/\.json$/, '')}.sha256`, `${sha256OfString(JSON.stringify(packed))}\n`);
    const bytes = fs.statSync(OUT_PATH).size;
    console.log(
        `✅ Intermediate: ${stems.size} word-stems, ${DIMS}d, ${(bytes / 1024 / 1024).toFixed(2)} MB ` +
            `→ ${path.relative(ROOT, OUT_PATH)}`,
    );
    console.log('   Next: pnpm build:lexicon && pnpm verify:lexicon');
};

module.exports = {
    collectAuthoredWords,
    parseGloveLine,
    normalize,
    retrofit,
    assignStems,
    quantizePack,
    streamEntryLines,
    sha256OfString,
    GENERIC_TOKEN_RE,
    ENTRY_NAME,
};

if (require.main === module) {
    main().catch((err) => fail(err.stack || String(err)));
}
