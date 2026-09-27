#!/usr/bin/env node

/**
 * Static word-vector lexicon builder — the OFFLINE, DETERMINISTIC half of the
 * pipeline. Reads the committed intermediate scripts/lexicon-embeddings.json
 * (pruned + int8-quantized GloVe vectors, produced by the manual, network-
 * touching `pnpm fetch:embeddings` step) and emits the runtime asset
 * src/assets/semantic-vectors.json that the semantic matcher
 * (src/js/services/semantic/lexicon.ts) loads on every platform. The asset is
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

import fs from 'node:fs';
import path from 'node:path';
import { stem } from '../src/js/services/photoPicker';
// The collision/vocab rules are shared with the fetch step ON PURPOSE — two
// hand-rolled copies of "stem -> owner, fail on cross-cluster collision"
// would drift apart silently.
import { collectAuthoredWords, sha256OfString } from './fetch-embeddings';
// The runtime's own decode + pooling, so the shipped axis is measured in exactly
// the space concreteness() later projects onto.
import { buildTable, embedIn } from '../src/js/services/semantic/lexicon';
import { runIfMain } from './lib/run-if-main';

import type { SearchGroup } from '../src/js/types/semantic';

/** One authored cluster of scripts/lexicon-concepts.json. */
interface Concept {
    id: string;
    parent: string;
    /** Canonical words first — the validator embeds the front of the list. */
    words: string[];
    /** Related-search expansion; defaults to `words`. */
    searchWords?: string[];
}

/** A `concreteness.cases` entry: a title and the words it must demote. */
interface SubjectCase {
    title: string;
    abstract: string[];
}

/** The parsed scripts/lexicon-concepts.json (shared with validate-lexicon.ts). */
export interface ConceptsConfig {
    concepts: Concept[];
    extraWords?: string[];
    organizationalParents?: string[];
    /** Parent pairs, each entry `[parentA, parentB]`. */
    unrelatedParents?: string[][];
    /** Concept-id pairs, each entry `[conceptIdA, conceptIdB]`. */
    nearMissPairs?: string[][];
    concreteness?: {
        excludeParents?: string[];
        abstractAnchors?: string[];
        cases?: SubjectCase[];
    };
}

/** Provenance block fetch-embeddings writes into the intermediate. */
interface EmbeddingsSource {
    url: string;
    zipSha256: string;
    entry: string;
    entrySha256: string;
    retrieved: string;
    license: string;
    citation: string;
}

/**
 * The parsed scripts/lexicon-embeddings.json (written by fetch-embeddings).
 * Fields are optional because buildAsset tolerates a partial intermediate.
 */
interface Intermediate {
    source?: EmbeddingsSource;
    dims?: number;
    scale?: number;
    meanCentered?: boolean;
    retrofitBeta?: number;
    /** Stem -> base64 int8 vector. */
    packed?: Record<string, string>;
    /** Stem -> the surface word it was built from. */
    surfaces?: Record<string, string>;
}

/** The runtime asset written to src/assets/semantic-vectors.json. */
interface LexiconAsset {
    version: 2;
    generator: string;
    source: EmbeddingsSource | undefined;
    dims: number | undefined;
    scale: number | undefined;
    meanCentered: boolean;
    retrofitBeta: number;
    packed: Record<string, string>;
    surfaces: Record<string, string>;
    searchGroups: SearchGroup[];
    concreteAxis?: number[];
}

const ROOT = path.join(__dirname, '..');
const EMBEDDINGS_PATH = path.join(__dirname, 'lexicon-embeddings.json');
const EMBEDDINGS_SHA_PATH = path.join(__dirname, 'lexicon-embeddings.sha256');
const CONCEPTS_PATH = path.join(__dirname, 'lexicon-concepts.json');
const OUT_ASSET = path.join(ROOT, 'src', 'assets', 'semantic-vectors.json');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIST_NAME = 'semantic-vectors.json';

// Six decimals is far below int8 vector precision and keeps the asset
// byte-identical across runs (no float-formatting drift in the last digits).
const AXIS_DECIMALS = 6;

/**
 * Derive the concreteness axis (see concreteness() in
 * src/js/services/semantic/lexicon.ts) from the `concreteness` block of the
 * concepts file: unit(mean(concrete words) - mean(abstract anchors)).
 *
 * No block -> no axis, and the runtime reads that as "no opinion" everywhere.
 * An anchor with no vector is reported as missing (fatal, like an authored
 * word); an anchor that is ALSO an authored concept word is a collision (fatal)
 * — it would sit on both poles at once.
 *
 * @param asset - the asset
 *   being assembled (its vectors are what the axis must be measured against)
 * @param authored - surface word -> owning concept
 */
const buildConcreteAxis = (
    { packed, dims, scale }: Pick<LexiconAsset, 'packed' | 'dims' | 'scale'>,
    concepts: ConceptsConfig,
    authored: Map<string, string>,
): { axis: Array<number> | undefined; missing: Array<string>; collisions: Array<string> } => {
    const config = concepts && concepts.concreteness;
    const missing: string[] = [];
    const collisions: string[] = [];
    if (!config) return { axis: undefined, missing, collisions };

    const anchors = (config.abstractAnchors || []).map((w) => String(w).toLowerCase());
    for (const anchor of anchors) {
        if (authored.has(anchor)) collisions.push(`${anchor} (abstract anchor is also a ${authored.get(anchor)} word)`);
        const key = stem(anchor);
        if (!Object.prototype.hasOwnProperty.call(packed, key)) {
            missing.push(`${anchor} (stem "${key}", abstractAnchors)`);
        }
    }

    const excluded = new Set(config.excludeParents || []);
    const concrete = (concepts.concepts || []).filter((c) => !excluded.has(c.parent)).flatMap((c) => c.words || []);
    const table = buildTable({ version: 2, dims, scale, packed });
    const pos = embedIn(table, concrete);
    const neg = embedIn(table, anchors);
    if (!pos || !neg) return { axis: undefined, missing, collisions };

    const diff = pos.map((v, i) => v - neg[i]);
    const norm = Math.sqrt(diff.reduce((acc, v) => acc + v * v, 0)) || 1;
    const axis = Array.from(diff, (v) => Number((v / norm).toFixed(AXIS_DECIMALS)));
    return { axis, missing, collisions };
};

/**
 * Validate the authored vocabulary against the intermediate and assemble the
 * runtime asset object. Pure — no fs, no process.exit — so the fatal paths are
 * unit-testable against small fixtures.
 *
 * @param intermediate - parsed scripts/lexicon-embeddings.json
 * @param concepts - parsed scripts/lexicon-concepts.json
 */
const buildAsset = (
    intermediate: Intermediate | null,
    concepts: ConceptsConfig,
): { output: LexiconAsset; missing: Array<string>; collisions: Array<string> } => {
    const packed = (intermediate && intermediate.packed) || {};
    const { bySurface, collisions } = collectAuthoredWords(concepts);
    const missing: string[] = [];
    for (const [surface, owner] of bySurface) {
        const key = stem(surface);
        if (!key || key.length < 2) continue;
        if (!Object.prototype.hasOwnProperty.call(packed, key)) {
            missing.push(`${surface} (stem "${key}", ${owner})`);
        }
    }

    const output: LexiconAsset = {
        version: 2,
        generator: 'build-lexicon.ts',
        source: intermediate ? intermediate.source : undefined,
        dims: intermediate ? intermediate.dims : undefined,
        scale: intermediate ? intermediate.scale : undefined,
        meanCentered: intermediate ? Boolean(intermediate.meanCentered) : false,
        // Number.isFinite proves retrofitBeta a number but is not a type guard.
        retrofitBeta:
            intermediate && Number.isFinite(intermediate.retrofitBeta) ? (intermediate.retrofitBeta as number) : 0,
        packed,
        surfaces: intermediate?.surfaces || {},
        searchGroups: concepts.concepts.map((concept) => ({
            triggers: concept.words,
            words: concept.searchWords || concept.words,
        })),
    };
    const axis = buildConcreteAxis(output, concepts, bySurface);
    if (axis.axis) output.concreteAxis = axis.axis;
    missing.push(...axis.missing);
    return { output, missing, collisions: [...collisions, ...axis.collisions] };
};

/**
 * CLI entry. Paths default to the committed files; tests point them at
 * os.tmpdir() fixtures so the committed assets are never touched.
 */
const main = ({
    embeddingsPath = EMBEDDINGS_PATH,
    embeddingsShaPath = EMBEDDINGS_SHA_PATH,
    conceptsPath = CONCEPTS_PATH,
    outAsset = OUT_ASSET,
    distDir = DIST_DIR,
}: {
    embeddingsPath?: string;
    embeddingsShaPath?: string;
    conceptsPath?: string;
    outAsset?: string;
    distDir?: string;
} = {}) => {
    if (!fs.existsSync(embeddingsPath)) {
        console.error(
            '❌ scripts/lexicon-embeddings.json is missing — run `pnpm fetch:embeddings` first (network, one-time).',
        );
        process.exit(1);
    }
    // Committed, generated files (the intermediate is hash-checked below), so
    // they are typed as their writers produce them rather than re-validated.
    const intermediate = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8')) as Intermediate;
    const concepts = JSON.parse(fs.readFileSync(conceptsPath, 'utf8')) as ConceptsConfig;

    // Tamper check: the intermediate is a multi-MB base64 blob nobody can
    // review line-by-line, so its payload hash lives in a one-line sidecar
    // file that IS reviewable. A payload edit that doesn't update the sidecar
    // (or vice versa) fails here instead of shipping.
    const expectedSha = fs.readFileSync(embeddingsShaPath, 'utf8').trim();
    const actualSha = sha256OfString(
        JSON.stringify({ packed: intermediate.packed, surfaces: intermediate.surfaces || {} }),
    );
    if (actualSha !== expectedSha) {
        console.error('❌ scripts/lexicon-embeddings.json does not match scripts/lexicon-embeddings.sha256:');
        console.error(`   sidecar  ${expectedSha}`);
        console.error(`   payload  ${actualSha}`);
        console.error(
            '   The committed intermediate was modified without regenerating it. Re-run\n' +
                '   `pnpm fetch:embeddings` (which rewrites both files) — never hand-edit either one.',
        );
        process.exit(1);
    }

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
    fs.writeFileSync(outAsset, json);
    let copied = '';
    if (fs.existsSync(distDir)) {
        fs.writeFileSync(path.join(distDir, OUT_DIST_NAME), json);
        copied = ` (+ dist copy)`;
    }
    const bytes = fs.statSync(outAsset).size;
    console.log(
        `✅ Lexicon: ${Object.keys(output.packed).length} word-stems, ${output.dims}d, ` +
            `${(bytes / 1024 / 1024).toFixed(2)} MB → src/assets/semantic-vectors.json${copied}`,
    );
};

export { buildAsset, buildConcreteAxis, main };

runIfMain(require.main, module, main);
