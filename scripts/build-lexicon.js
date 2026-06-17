#!/usr/bin/env node

/**
 * Static word-vector lexicon generator.
 *
 * Reads scripts/lexicon-concepts.json (curated synonym clusters) and emits a
 * compact int8-quantized vector table to src/assets/semantic-vectors.json. The
 * semantic matcher (src/js/services/semantic/lexicon.js) loads that file as a
 * runtime asset — it is NEVER imported into a JS bundle, so the renderer /
 * headless / capacitor size-limit budgets are untouched.
 *
 * Each concept gets a deterministic pseudo-random unit vector (seeded by its
 * id, so output is reproducible across runs and machines). Every word in a
 * concept maps to the SAME blended vector — conceptWeight * conceptVector +
 * parentWeight * parentVector — so exact synonyms score cosine 1 and siblings
 * sharing a parent (cat vs dog under "animal") score a mild positive. Words are
 * stemmed with the matcher's own stemmer so runtime lookups line up.
 *
 * Run: `pnpm build:lexicon` (also invoked by build:prep so dist/ gets a copy
 * for the Android webDir). The committed src/assets copy ships in the Electron
 * asar and is embedded as a SEA asset for the CLI single binary.
 */

const fs = require('node:fs');
const path = require('node:path');
const { stem } = require('../src/js/services/photoPicker');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(__dirname, 'lexicon-concepts.json');
const OUT_ASSET = path.join(ROOT, 'src', 'assets', 'semantic-vectors.json');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIST = path.join(DIST_DIR, 'semantic-vectors.json');

// Deterministic string hash → 32-bit seed (cyrb53-lite). Same id → same seed →
// same vector on every run and every machine, so the asset is reproducible.
const seedOf = (str) => {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
};

// mulberry32 — tiny seeded PRNG; deterministic given the seed.
const mulberry32 = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const randomUnitVector = (id, dims) => {
    const rand = mulberry32(seedOf(id));
    const v = new Array(dims);
    let norm = 0;
    for (let i = 0; i < dims; i++) {
        // Box–Muller for a roughly Gaussian spread → uniform direction.
        const u1 = Math.max(rand(), 1e-9);
        const u2 = rand();
        v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) v[i] /= norm;
    return v;
};

const normalize = (v) => {
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return v.map((x) => x / norm);
};

const main = () => {
    const config = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
    const dims = config.dims || 48;
    const cWeight = config.conceptWeight ?? 0.75;
    const pWeight = config.parentWeight ?? 0.28;
    const concepts = config.concepts || [];

    // 1. A unit vector per concept id and per distinct parent id.
    const conceptIds = new Set();
    const parentIds = new Set();
    for (const c of concepts) {
        if (c.id) conceptIds.add(c.id);
        if (c.parent) parentIds.add(c.parent);
    }
    const vecOf = new Map();
    for (const id of [...conceptIds, ...parentIds]) {
        if (!vecOf.has(id)) vecOf.set(id, randomUnitVector(`concept:${id}`, dims));
    }

    // 2. Each word → normalized blend of its concept and parent vectors.
    const floatWords = new Map();
    const collisions = [];
    for (const c of concepts) {
        const conceptVec = vecOf.get(c.id);
        const parentVec = c.parent ? vecOf.get(c.parent) : null;
        const blended = new Array(dims);
        for (let i = 0; i < dims; i++) {
            blended[i] = cWeight * conceptVec[i] + (parentVec ? pWeight * parentVec[i] : 0);
        }
        const wordVec = normalize(blended);
        for (const raw of c.words || []) {
            const key = stem(String(raw).toLowerCase());
            if (!key || key.length < 2) continue;
            if (floatWords.has(key) && floatWords.get(key).concept !== c.id) {
                collisions.push(`${key} (${floatWords.get(key).concept} -> ${c.id})`);
            }
            floatWords.set(key, { concept: c.id, vec: wordVec });
        }
    }

    // 3. Quantize to int8 with one global scale (values are unit vectors, so
    //    the max magnitude is ~1). dequant at runtime is value * scale.
    let maxAbs = 0;
    for (const { vec } of floatWords.values()) {
        for (const x of vec) maxAbs = Math.max(maxAbs, Math.abs(x));
    }
    const scale = maxAbs / 127 || 1 / 127;
    const words = {};
    for (const [key, { vec }] of floatWords) {
        words[key] = vec.map((x) => Math.max(-127, Math.min(127, Math.round(x / scale))));
    }

    const output = {
        version: 1,
        generator: 'build-lexicon.js',
        dims,
        scale,
        words,
    };

    fs.writeFileSync(OUT_ASSET, JSON.stringify(output));
    let copied = '';
    if (fs.existsSync(DIST_DIR)) {
        fs.writeFileSync(OUT_DIST, JSON.stringify(output));
        copied = ` (+ dist copy)`;
    }

    const bytes = fs.statSync(OUT_ASSET).size;
    console.log(
        `✅ Lexicon: ${Object.keys(words).length} word-stems, ${concepts.length} concepts, ${dims}d, ` +
            `${(bytes / 1024).toFixed(1)} KB → src/assets/semantic-vectors.json${copied}`,
    );
    if (collisions.length) {
        console.warn(`⚠️  ${collisions.length} word(s) claimed by more than one concept (last wins):`);
        for (const c of collisions) console.warn(`   - ${c}`);
    }
};

main();
