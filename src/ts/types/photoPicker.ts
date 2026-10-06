/**
 * Shapes the auto-fill photo picker (services/photoPicker/*), the semantic
 * matcher (services/semantic/*) and the auto-fill pipeline pass between each
 * other. Type-only: nothing here exists at runtime. Modules pull them in with
 * `import type { PickerPhoto } from '../../types/photoPicker'`.
 */

import type { Challenge, LibraryPhoto } from './gurushots';

/**
 * The challenge text the picker reads: a challenge, or a `{ title }` stand-in
 * built from one part of a title.
 */
export type ChallengeText = Partial<Pick<Challenge, 'id' | 'title' | 'url' | 'welcome_message'>>;

/** Title words the user asked the picker to ignore (the `ignoreTitleWords` setting). */
export type IgnoreWords = Iterable<string> | null;

/** What a challenge title says to leave out ("No Humans"). */
export interface Negation {
    positiveTitle: string;
    stems: readonly string[];
    active: boolean;
}

/**
 * What a challenge's title and description say about its theme (readChallengeTheme):
 * open (no subject to match), a subject the description confirms, or unconfirmed.
 */
export interface ChallengeTheme {
    kind: 'open' | 'subject' | 'unconfirmed';
    /** Title subject stems the description repeats; empty unless kind is 'subject'. */
    subjects: readonly string[];
}

/** A negated subject in the shape the exclusion filter reads. */
export interface ExcludedSubject {
    stems: readonly string[];
    /** The spelled-out people concept, when the negated subject is people. */
    concept: Set<string> | null;
}

/**
 * A library photo as the picker ranks it: get_photos_private's item, plus the
 * popularity fields services/photoStats.ts merges on once it resolved them.
 */
export interface PickerPhoto extends LibraryPhoto {
    /** The owner's member id; library rows usually carry it, and a photo URL needs it. */
    member_id?: string;
    /** True only when photoStats.ts resolved this photo's real numbers. */
    statsKnown?: boolean;
    /** The achievements count photoStats.ts stores instead of the array. */
    achievementCount?: number;
    /** A raw achievements array (mocks, tests, a payload that inlines it). */
    achievements?: unknown[];
}

/** One photo's semantic match: best-label similarity (0..1) and on-theme label count. */
export interface SemanticScore {
    score: number;
    support: number;
}

/** Photo id -> semantic match. A bare number is the pre-support shape: a score with no support. */
export type SemanticScoreMap = Map<string, SemanticScore | number>;

/** What onFallback receives when a hard filter eliminated every photo and the picker relaxed. */
export interface PickFallbackInfo {
    letterPrefix: string | null;
    mustStems: readonly string[];
    excludedStems: readonly string[];
}

/** The per-challenge tag settings a fill reads: Must/Should Include Tags and the ignore-words list. */
export interface TagOptions {
    mustIncludeTags?: readonly string[] | null;
    shouldIncludeTags?: readonly string[] | null;
    ignoreWords?: IgnoreWords;
}

/**
 * The user's chosen photos for one pick (the Chosen Photos settings, resolved).
 * The ids only FILTER the candidates the server already offered.
 */
export interface ChosenPick {
    /** Photo ids to rank first; an empty list means no preference. */
    ids: readonly string[];
    /** Pick only these: with none usable the pick is empty rather than topped up. */
    only: boolean;
    /** Ids already entered in this challenge, removed from the pool as a set. */
    excludeIds?: ReadonlySet<string> | null;
}

/** pickPhotosForChallenge / buildScoredCandidates options. */
export interface PickOptions extends TagOptions {
    fillWithoutTagMatch?: boolean;
    semanticScores?: SemanticScoreMap | null;
    onFallback?: ((info: PickFallbackInfo) => void) | null;
    /** Honoured by pickPhotosForChallenge and buildChosenCandidates; buildScoredCandidates ignores it. */
    chosen?: ChosenPick | null;
}

/** The scored pool split into the user's chosen photos and the rest (buildChosenCandidates). */
export interface ChosenCandidates {
    scored: ScoredCandidate[];
    /** Ids of the chosen block inside `scored`; null when no chosen photos were asked for. */
    chosenIds: ReadonlySet<string> | null;
}

/** One candidate's tier record from buildScoredCandidates. */
export interface ScoredCandidate {
    id: string;
    photo: PickerPhoto;
    shouldMatchCount: number;
    semantic: number;
    semanticSupport: number;
    score: number;
    statsKnown: boolean;
    achievementCount: number;
    votes: number;
    views: number;
    uploadDate: number;
}

/** The theme tiers of a candidate, all hasThemeMatch reads. */
export type ThemeTiers = Pick<ScoredCandidate, 'shouldMatchCount' | 'semantic' | 'semanticSupport' | 'score'>;
