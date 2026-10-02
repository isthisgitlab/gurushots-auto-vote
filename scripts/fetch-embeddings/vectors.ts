import { stem } from '../../src/ts/services/photoPicker';

import type { ConceptsConfig } from '../build-lexicon';

/** One parsed GloVe line. */
export interface GloveRow {
    token: string;
    vec: Float64Array;
}

/** A GloVe row kept by the scan, tagged with where its word came from. */
export interface VocabRow extends GloveRow {
    isAuthored: boolean;
}

/** A kept row plus whether it belongs to the mean-centering baseline. */
export interface ScanRow extends VocabRow {
    centerBaseline: boolean;
}

/**
 * Authored vocabulary: surface word -> owning concept id (or 'extraWords'),
 * plus any cross-cluster stem collisions (an authoring mistake the caller
 * treats as fatal, mirroring build-lexicon.ts). Pure — takes the parsed
 * concepts config, exits nowhere.
 *
 * @param concepts - parsed lexicon-concepts.json
 */
export const collectAuthoredWords = (
    concepts: ConceptsConfig | null,
): { bySurface: Map<string, string>; collisions: Array<string> } => {
    const bySurface = new Map<string, string>();
    const stemOwner = new Map<string, string>();
    const collisions: Array<string> = [];
    const claim = (word: string, owner: string) => {
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
export const parseGloveLine = (line: string, dims: number): GloveRow | null => {
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

export const normalize = (vec: Float64Array): void => {
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
};

export const cosineOf = (a: Float64Array, b: Float64Array): number => {
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
 * @param authored - surface word -> owner id
 * @param beta - blend strength in [0, 1]
 * @returns how many vectors were adjusted
 */
export const retrofit = (rows: Array<VocabRow>, authored: Map<string, string>, beta: number): number => {
    if (!(beta > 0)) return 0;
    const clusters = new Map<string, Array<Float64Array>>();
    for (const row of rows) {
        if (!row.isAuthored) continue;
        const owner = authored.get(row.token);
        if (!owner || owner === 'extraWords') continue;
        if (!clusters.has(owner)) clusters.set(owner, []);
        // Set on the line above when absent.
        clusters.get(owner)!.push(row.vec);
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
 */
export const assignStems = (
    rows: Array<VocabRow>,
    badCosine: number,
): { stems: Map<string, VocabRow>; merges: number; badMerges: number; badSamples: Array<string> } => {
    const stems = new Map<string, VocabRow>();
    const badSamples: Array<string> = [];
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
 */
export const quantizePack = (
    stems: Map<string, { vec: Float64Array }>,
    dims: number,
): { scale: number; packed: Record<string, string> } => {
    let maxAbs = 0;
    for (const { vec } of stems.values()) for (const x of vec) maxAbs = Math.max(maxAbs, Math.abs(x));
    const scale = maxAbs / 127 || 1 / 127;
    const packed = Object.create(null) as Record<string, string>;
    for (const [key, { vec }] of stems) {
        const q = new Int8Array(dims);
        for (let i = 0; i < dims; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
        packed[key] = Buffer.from(q.buffer, q.byteOffset, q.byteLength).toString('base64');
    }
    return { scale, packed };
};
