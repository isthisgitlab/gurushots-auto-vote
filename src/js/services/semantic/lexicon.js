/**
 * Static word-vector lexicon backend.
 *
 * Loads the pruned, int8-quantized GloVe vector table shipped with the app
 * (v2 packed format — see scripts/build-lexicon.js and fetch-embeddings.js)
 * and turns a list of words into a single mean-pooled unit vector. The vectors
 * are REAL pretrained embeddings, so similarity is graded: "feline" vs "cat"
 * scores high (same meaning), "cat" vs "lion" moderate (related), "cat" vs
 * "skyscraper" near noise — the synonym gap the lexical matcher can't bridge,
 * without being limited to a hand-curated cluster list.
 *
 * Pure JS, no native deps: runs in Electron, the CLI single binary, the Android
 * WebView and the Android headless background service. Tokens are normalized
 * with the matcher's own stemmer so lookups line up with the stored stems.
 */

const { loadLexiconAsset } = require('./assets');
const { stem } = require('../photoPicker');

// undefined = not initialized, null = unavailable, { dims, words: Map } = ready
let table;
let initPromise = null;

/**
 * Decode one packed base64 vector to signed int8 bytes. The builder writes
 * two's-complement bytes, so both branches must reinterpret explicitly:
 * Buffer yields unsigned 0..255 (viewed through Int8Array), and atob yields
 * char codes 0..255 (shifted by hand). Getting the sign wrong would corrupt
 * every negative component SILENTLY — tests/services/semantic/lexicon.test.js
 * round-trips known negative values through BOTH branches to pin this down.
 * Returns null for anything malformed.
 */
const decodeBase64Int8 = (str) => {
    if (typeof str !== 'string' || str.length === 0) return null;
    try {
        if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
            const buf = Buffer.from(str, 'base64');
            return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
        }
        // Android WebView path — no Buffer, atob is always available there.
        const bin = atob(str);
        const out = new Int8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            const code = bin.charCodeAt(i);
            out[i] = code > 127 ? code - 256 : code;
        }
        return out;
    } catch {
        return null;
    }
};

// The concreteness direction build-lexicon.js derives from the table itself
// (see concreteness below). Optional: an asset without one — or with one that
// does not fit this table — just leaves concreteness() returning null, which
// every caller already reads as "no opinion".
const readAxis = (axis, dims) => {
    if (!Array.isArray(axis) || axis.length !== dims || !axis.every(Number.isFinite)) return null;
    return Float64Array.from(axis);
};

const buildTable = (raw) => {
    if (!raw || typeof raw !== 'object' || raw.version !== 2 || !raw.packed || typeof raw.packed !== 'object') {
        return null;
    }
    if (!Number.isFinite(raw.dims) || !Number.isFinite(raw.scale)) return null;
    const dims = raw.dims;
    const scale = raw.scale;
    const words = new Map();
    for (const key of Object.keys(raw.packed)) {
        const bytes = decodeBase64Int8(raw.packed[key]);
        if (!bytes || bytes.length !== dims) continue;
        // Float32 on purpose: the values carry int8 precision, and at ~32k
        // entries f64 would double the resident table for nothing. embed()
        // still accumulates in f64.
        const vec = new Float32Array(dims);
        for (let i = 0; i < dims; i++) vec[i] = bytes[i] * scale;
        words.set(key, vec);
    }
    return words.size > 0
        ? {
              dims,
              words,
              surfaces: raw.surfaces || {},
              axis: readAxis(raw.concreteAxis, dims),
              searchGroups: raw.searchGroups || [],
          }
        : null;
};

/**
 * Load the lexicon once. Idempotent; concurrent callers share the load.
 * @returns {Promise<{dims:number, words:Map<string,Float32Array>}|null>}
 */
const init = () => {
    if (table !== undefined) return Promise.resolve(table);
    if (!initPromise) {
        initPromise = (async () => {
            table = buildTable(await loadLexiconAsset());
            return table;
        })();
    }
    return initPromise;
};

const isAvailable = async () => (await init()) != null;

const stemToken = (t) => stem(String(t).toLowerCase());

/**
 * Vector for one token, tolerating the one known spelling divergence between
 * the current stemmer and the shipped table's keys.
 *
 * The table is keyed by stems produced when the intermediate was generated, and
 * that revision of stem() stripped '-es' unconditionally. The current stemmer
 * only does so after a sibilant, correctly leaving the '-e' elsewhere — so a
 * few stems now spell differently than their key: "buses" keys as `bus` but
 * stems to `buse`, "clothes" keys as `cloth` but stems to `clothe`. Those
 * lookups would silently return no vector, i.e. the semantic tier would go dark
 * for exactly those themes.
 *
 * Retrying without a trailing 'e' is the precise shape of that divergence and
 * costs one extra Map hit on a path that already missed. It only ever runs
 * AFTER a miss, so it cannot shadow a correct key ("rose", "tree", "house" all
 * hit first). Regenerating the 1.2 MB asset would need a network fetch of the
 * source vectors; this is the offline-safe equivalent.
 *
 * @param {string} tok
 * @returns {Float32Array|undefined}
 */
const vectorFor = (tbl, tok) => {
    const key = stemToken(tok);
    const hit = tbl.words.get(key);
    if (hit) return hit;
    return key.length > 3 && key.endsWith('e') ? tbl.words.get(key.slice(0, -1)) : undefined;
};

/**
 * Mean-pool the vectors of the in-vocabulary stems among `tokens`, then
 * normalize to a unit vector. Returns null when none of the tokens are in the
 * lexicon (no signal to contribute).
 *
 * Takes the table explicitly so scripts/build-lexicon.js pools the concreteness
 * poles with exactly the arithmetic the runtime scores against; embed() below
 * is this over the loaded table.
 *
 * @param {{dims:number, words:Map<string,Float32Array>}|null|undefined} tbl
 * @param {Array<string>} tokens
 * @returns {Float64Array|null}
 */
const embedIn = (tbl, tokens) => {
    if (!tbl || !Array.isArray(tokens) || tokens.length === 0) return null;
    const dims = tbl.dims;
    const acc = new Float64Array(dims);
    let hits = 0;
    for (const tok of tokens) {
        const vec = vectorFor(tbl, tok);
        if (!vec) continue;
        for (let i = 0; i < dims; i++) acc[i] += vec[i];
        hits++;
    }
    if (hits === 0) return null;
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += acc[i] * acc[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) acc[i] /= norm;
    return acc;
};

/**
 * @param {Array<string>} tokens
 * @returns {Float64Array|null}
 */
const embed = (tokens) => embedIn(table, tokens);
const hasVector = (token) => Boolean(table && vectorFor(table, token));

const MAX_RELATED_SEARCH_TERMS = 6;
const GENERIC_SEARCH_FLOOR = 0.76;

const nearestSearchTerms = (term) => {
    const query = embed([term]);
    if (!query) return [];
    const termStem = stemToken(term);
    const matches = [];
    for (const [key, vec] of table.words) {
        if (key === termStem) continue;
        let dot = 0;
        let norm = 0;
        for (let i = 0; i < vec.length; i++) {
            dot += query[i] * vec[i];
            norm += vec[i] * vec[i];
        }
        const score = dot / Math.sqrt(norm);
        if (score >= GENERIC_SEARCH_FLOOR) {
            matches.push({ word: Object.hasOwn(table.surfaces, key) ? table.surfaces[key] : key, score });
        }
    }
    return matches
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RELATED_SEARCH_TERMS)
        .map(({ word }) => word);
};

const interleaveSearchTerms = (groups, terms) => {
    const seen = new Set(terms.map(stemToken));
    const related = [];
    const width = Math.max(0, ...groups.map((group) => group.length));
    for (let i = 0; i < width && related.length < MAX_RELATED_SEARCH_TERMS; i++) {
        for (const group of groups) {
            const word = group[i];
            if (!word || seen.has(stemToken(word))) continue;
            seen.add(stemToken(word));
            related.push(word);
            if (related.length === MAX_RELATED_SEARCH_TERMS) return related;
        }
    }
    return related;
};

const relatedSearchTerms = (terms) => {
    if (!table || !Array.isArray(terms)) return [];
    const groups = terms.map((term) => {
        const curated = interleaveSearchTerms(
            table.searchGroups
                .filter((group) => group.triggers.some((word) => stemToken(word) === stemToken(term)))
                .map((group) => group.words),
            [term],
        );
        return curated.length ? curated : nearestSearchTerms(term);
    });
    // The authored groups cover common themes. Other words use nearby source
    // words from the bundled generic vocabulary; interleaving keeps each
    // title subject represented under the fixed server-search limit.
    return interleaveSearchTerms(groups, terms);
};

// Cosine similarity. Both inputs come from embed() and are already unit
// vectors, so the dot product is the cosine.
const cosine = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
};

/**
 * How much `token` names a photographable THING rather than an idea, as a
 * cosine in -1..1 (positive = concrete). Null when the lexicon is not loaded,
 * the asset carries no axis, or the word is out of vocabulary.
 *
 * The axis is the direction from an abstract pole (a handful of anchor words
 * like "idea", "feeling", "success") to the centroid of every curated visual
 * subject in scripts/lexicon-concepts.json — the "semantic axis" construction
 * (An, Kwak & Ahn 2018). It is a PROPERTY OF THE VECTOR SPACE, not a list: a
 * title word nobody has ever authored still lands somewhere on it, which is the
 * point — challenge names change every week, and "Balloon Fun" must read as
 * balloons without anyone having written down that "fun" is not a subject.
 * scripts/validate-lexicon.js gates the build on real titles reading correctly.
 *
 * @param {string} token
 * @returns {number|null}
 */
const concreteness = (token) => {
    if (!table || !table.axis) return null;
    const vec = embed([token]);
    return vec ? cosine(vec, table.axis) : null;
};

// Test-only: drop the loaded table so a test can re-init from a fresh asset.
const __resetForTests = () => {
    table = undefined;
    initPromise = null;
};

module.exports = {
    init,
    isAvailable,
    embed,
    embedIn,
    hasVector,
    relatedSearchTerms,
    cosine,
    concreteness,
    buildTable,
    __resetForTests,
};
