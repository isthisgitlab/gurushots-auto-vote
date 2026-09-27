/**
 * Shapes of the word-vector lexicon (services/semantic/*). Type-only: nothing
 * here exists at runtime.
 */

/** An authored related-search group: a trigger word pulls in the group's words. */
export interface SearchGroup {
    triggers: string[];
    words: string[];
}

/**
 * The parsed src/assets/semantic-vectors.json (v2 packed format, written by
 * scripts/build-lexicon.ts). It is untrusted until buildTable checks it; the
 * fields are typed as buildTable reads them.
 */
export interface RawLexicon {
    version?: unknown;
    dims?: number;
    scale?: number;
    /** Stem -> base64 int8 vector. */
    packed?: Record<string, unknown>;
    /** Stem -> the surface word it was built from. */
    surfaces?: Record<string, string>;
    concreteAxis?: unknown;
    searchGroups?: SearchGroup[];
}

/** The loaded lexicon table. */
export interface LexiconTable {
    dims: number;
    words: Map<string, Float32Array>;
    surfaces: Record<string, string>;
    /** The concreteness direction, or null when the asset carries none that fits. */
    axis: Float64Array | null;
    searchGroups: SearchGroup[];
}

/** lexicon-diagnostics.json: counts of the words the scorer found no vector for. */
export interface LexiconDiagnosticsReport {
    version: 1;
    /** ISO timestamp the report was started. */
    since: string;
    /** ISO timestamp of the last recorded observation. */
    updatedAt: string | null;
    challenges: number;
    noThemeVector: number;
    noLabelVectors: number;
    noOnThemeScore: number;
    /** Word -> observation count (bounded). */
    themeWords: Record<string, number>;
    labelWords: Record<string, number>;
    /** YYYY-MM-DD the seenChallenges list belongs to. */
    seenDay: string | null;
    /** Challenge fingerprints already counted on seenDay. */
    seenChallenges: string[];
}

/** One challenge's scoring pass, as diagnostics.record receives it. */
export interface VocabularyObservation {
    themeWords?: string[];
    labelWords?: string[];
    noThemeVector?: boolean;
    noLabelVectors?: boolean;
    noOnThemeScore?: boolean;
}
