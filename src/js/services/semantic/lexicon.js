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
        // Float32 on purpose: the values carry int8 precision, and at ~10k
        // entries f64 would double the resident table for nothing. embed()
        // still accumulates in f64.
        const vec = new Float32Array(dims);
        for (let i = 0; i < dims; i++) vec[i] = bytes[i] * scale;
        words.set(key, vec);
    }
    return words.size > 0 ? { dims, words } : null;
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
 * Mean-pool the vectors of the in-vocabulary stems among `tokens`, then
 * normalize to a unit vector. Returns null when none of the tokens are in the
 * lexicon (no signal to contribute).
 *
 * @param {Array<string>} tokens
 * @returns {Float64Array|null}
 */
const embed = (tokens) => {
    if (!table || !Array.isArray(tokens) || tokens.length === 0) return null;
    const dims = table.dims;
    const acc = new Float64Array(dims);
    let hits = 0;
    for (const tok of tokens) {
        const vec = table.words.get(stemToken(tok));
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

// Cosine similarity. Both inputs come from embed() and are already unit
// vectors, so the dot product is the cosine.
const cosine = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
};

// Test-only: drop the loaded table so a test can re-init from a fresh asset.
const __resetForTests = () => {
    table = undefined;
    initPromise = null;
};

module.exports = { init, isAvailable, embed, cosine, buildTable, __resetForTests };
