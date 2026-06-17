/**
 * Static word-vector lexicon backend.
 *
 * Loads the curated, int8-quantized vector table shipped with the app (see
 * scripts/build-lexicon.js) and turns a list of words into a single mean-pooled
 * unit vector. Because exact synonyms share a vector, a "feline" challenge
 * keyword and a "cat" photo label embed to the same point (cosine 1) — the
 * synonym gap the lexical matcher can't bridge.
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

const buildTable = (raw) => {
    if (!raw || typeof raw !== 'object' || !raw.words || !Number.isFinite(raw.dims)) return null;
    const dims = raw.dims;
    const scale = Number.isFinite(raw.scale) ? raw.scale : 1;
    const words = new Map();
    for (const key of Object.keys(raw.words)) {
        const arr = raw.words[key];
        if (!Array.isArray(arr) || arr.length !== dims) continue;
        const vec = new Float64Array(dims);
        for (let i = 0; i < dims; i++) vec[i] = arr[i] * scale;
        words.set(key, vec);
    }
    return words.size > 0 ? { dims, words } : null;
};

/**
 * Load the lexicon once. Idempotent; concurrent callers share the load.
 * @returns {Promise<{dims:number, words:Map<string,Float64Array>}|null>}
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

module.exports = { init, isAvailable, embed, cosine, __resetForTests };
