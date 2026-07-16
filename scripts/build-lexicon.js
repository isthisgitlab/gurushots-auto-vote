#!/usr/bin/env node

/**
 * Static word-vector lexicon builder — the OFFLINE, DETERMINISTIC half of the
 * pipeline. Reads the committed intermediate scripts/lexicon-embeddings.json
 * (pruned + int8-quantized GloVe vectors, produced by the manual, network-
 * touching `pnpm fetch:embeddings` step) and emits the runtime asset
 * src/assets/semantic-vectors.json that the semantic matcher
 * (src/js/services/semantic/lexicon.js) loads on every platform. The asset is
 * NEVER imported into a JS bundle, so the renderer / headless / capacitor
 * size-limit budgets are untouched.
 *
 * Same input -> byte-identical output, which is what lets CI verify the
 * committed asset with `pnpm build:lexicon && git diff --exit-code`.
 *
 * Gates enforced here (both fatal):
 *   - vocab guarantee: every word in scripts/lexicon-concepts.json (concepts +
 *     extraWords) must resolve to a stem present in the intermediate. A miss
 *     means the intermediate is STALE — someone edited the concepts file
 *     without re-running `pnpm fetch:embeddings`.
 *   - authored stem collisions: two clusters claiming the same stem is an
 *     authoring mistake that would silently corrupt the validator's eval
 *     pairs (last-wins), so it fails instead.
 *
 * Run: `pnpm build:lexicon` (also invoked by build:prep so dist/ gets a copy
 * for the Android webDir). The committed src/assets copy ships in the Electron
 * asar and is embedded as a SEA asset for the CLI single binary.
 */

const fs = require('node:fs');
const path = require('node:path');
const { stem } = require('../src/js/services/photoPicker');

const ROOT = path.join(__dirname, '..');
const EMBEDDINGS_PATH = path.join(__dirname, 'lexicon-embeddings.json');
const CONCEPTS_PATH = path.join(__dirname, 'lexicon-concepts.json');
const OUT_ASSET = path.join(ROOT, 'src', 'assets', 'semantic-vectors.json');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIST = path.join(DIST_DIR, 'semantic-vectors.json');

/**
 * Validate the authored vocabulary against the intermediate and assemble the
 * runtime asset object. Pure — no fs, no process.exit — so the fatal paths are
 * unit-testable against small fixtures.
 *
 * @param {object} intermediate - parsed scripts/lexicon-embeddings.json
 * @param {object} concepts - parsed scripts/lexicon-concepts.json
 * @returns {{output: object, missing: Array<string>, collisions: Array<string>}}
 */
const buildAsset = (intermediate, concepts) => {
    const packed = (intermediate && intermediate.packed) || {};
    const stemOwner = new Map();
    const collisions = [];
    const missing = [];
    const claim = (word, owner) => {
        const key = stem(String(word).toLowerCase());
        if (!key || key.length < 2) return;
        if (stemOwner.has(key) && stemOwner.get(key) !== owner) {
            collisions.push(`${key} (${stemOwner.get(key)} -> ${owner})`);
        }
        stemOwner.set(key, owner);
        if (!Object.prototype.hasOwnProperty.call(packed, key)) {
            missing.push(`${word} (stem "${key}", ${owner})`);
        }
    };
    for (const concept of (concepts && concepts.concepts) || []) {
        for (const word of concept.words || []) claim(word, concept.id);
    }
    for (const word of (concepts && concepts.extraWords) || []) claim(word, 'extraWords');

    const output = {
        version: 2,
        generator: 'build-lexicon.js',
        source: intermediate ? intermediate.source : undefined,
        dims: intermediate ? intermediate.dims : undefined,
        scale: intermediate ? intermediate.scale : undefined,
        meanCentered: intermediate ? Boolean(intermediate.meanCentered) : false,
        packed,
    };
    return { output, missing, collisions };
};

const main = () => {
    if (!fs.existsSync(EMBEDDINGS_PATH)) {
        console.error(
            '❌ scripts/lexicon-embeddings.json is missing — run `pnpm fetch:embeddings` first (network, one-time).',
        );
        process.exit(1);
    }
    const intermediate = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, 'utf8'));
    const concepts = JSON.parse(fs.readFileSync(CONCEPTS_PATH, 'utf8'));
    const { output, missing, collisions } = buildAsset(intermediate, concepts);

    if (collisions.length) {
        console.error(`❌ ${collisions.length} stem(s) claimed by more than one concept:`);
        for (const c of collisions) console.error(`   - ${c}`);
        console.error('   Each stem must belong to exactly one concept. Fix scripts/lexicon-concepts.json.');
        process.exit(1);
    }
    if (missing.length) {
        console.error(`❌ ${missing.length} authored word(s) missing from the intermediate:`);
        for (const m of missing) console.error(`   - ${m}`);
        console.error(
            '   The intermediate is stale for the current concepts file — re-run `pnpm fetch:embeddings`\n' +
                '   (offline once scripts/.cache/ holds the archive), then build again.',
        );
        process.exit(1);
    }

    const json = JSON.stringify(output);
    fs.writeFileSync(OUT_ASSET, json);
    let copied = '';
    if (fs.existsSync(DIST_DIR)) {
        fs.writeFileSync(OUT_DIST, json);
        copied = ` (+ dist copy)`;
    }
    const bytes = fs.statSync(OUT_ASSET).size;
    console.log(
        `✅ Lexicon: ${Object.keys(output.packed).length} word-stems, ${output.dims}d, ` +
            `${(bytes / 1024 / 1024).toFixed(2)} MB → src/assets/semantic-vectors.json${copied}`,
    );
};

module.exports = { buildAsset };

if (require.main === module) main();
