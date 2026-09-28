/**
 * Shapes of the auto-fill paths' injected dependencies and results
 * (services/autoFill/*). Type-only: nothing here exists at runtime.
 *
 * The endpoint signatures are the real api/* ones; the mock endpoints mirror
 * them. They are declared as methods, like types/votingPass.ts, so the real
 * and mock implementations both fit.
 */

import type * as LoggerModule from '../logger';
import type * as SettingsModule from '../settings';
import type { Challenge, ChallengeMember, MemberRanking, RankingEntry } from './gurushots';
import type { PickerPhoto, SemanticScoreMap } from './photoPicker';
import type {
    getEligiblePhotos as GetEligiblePhotos,
    getImageData as GetImageData,
    submitToChallenge as SubmitToChallenge,
} from '../api/submissions';
import type {
    getCurrentMemberProfile as GetCurrentMemberProfile,
    searchTagAutocomplete as SearchTagAutocomplete,
} from '../api/tags';
import type { getActiveChallenges as GetActiveChallenges } from '../strategies/real/activeChallenges';
import type { rankVisually as RankVisually } from '../services/visionVerifier';
import type { getSemanticScores as GetSemanticScores } from '../services/semantic';

/** The logger surface the fill paths use: the facade module, or a stand-in with the same two members. */
export type FillLogger = Pick<typeof LoggerModule, 'withCategory' | 'challengeTag'>;

/** The settings facade surface the fill paths read. */
export type FillSettings = Pick<typeof SettingsModule, 'getEffectiveSetting' | 'getEffectiveTagSetting'> &
    Partial<Pick<typeof SettingsModule, 'getEffectiveIgnoreTitleWords'>>;

/** The endpoints and seams the candidate fetch and ranking read. */
export interface RankDeps {
    /** Absent only in unit tests of failure paths; tag rules then degrade to "no filter". */
    settings?: FillSettings | null;
    logger: FillLogger;
    getEligiblePhotos(...args: Parameters<typeof GetEligiblePhotos>): ReturnType<typeof GetEligiblePhotos>;
    /** Without it, stat enrichment is skipped. */
    getImageData?(...args: Parameters<typeof GetImageData>): ReturnType<typeof GetImageData>;
    /** Enables the pre-submit live re-check; without it the fill proceeds on pass-start data. */
    getActiveChallenges?(...args: Parameters<typeof GetActiveChallenges>): ReturnType<typeof GetActiveChallenges>;
    /** Optional pair: without both, the themed photo search skips tag resolution. */
    searchTagAutocomplete?(...args: Parameters<typeof SearchTagAutocomplete>): ReturnType<typeof SearchTagAutocomplete>;
    getCurrentMemberProfile?(
        ...args: Parameters<typeof GetCurrentMemberProfile>
    ): ReturnType<typeof GetCurrentMemberProfile>;
    /** Test seams; default to the real modules. */
    rankVisually?: typeof RankVisually;
    getSemanticScores?: typeof GetSemanticScores;
}

/** A submitting fill's dependencies. */
export interface FillDeps extends RankDeps {
    submitToChallenge(...args: Parameters<typeof SubmitToChallenge>): ReturnType<typeof SubmitToChallenge>;
}

/** The dependencies of a fill path that reads its settings unconditionally (auto, emergency, fill-new). */
export interface SettingsFillDeps extends FillDeps {
    settings: FillSettings;
}

/** A member whose shape every later reader of the challenge can survive (see isAdoptableMember). */
export type AdoptableMember = ChallengeMember & {
    ranking: MemberRanking & { entries: RankingEntry[] };
};

/** The log prefix of a submitting fill path. */
type FillLabel = 'autoFill' | 'emergencyFill' | 'manualFill' | 'fillNew';

/** What onRefreshed may answer after the live re-check. */
interface RefreshVerdict {
    standDown?: boolean;
    picked?: string[];
}

/** The loaded candidate set a stand-down probe sees. */
interface LoadedCandidates {
    eligible: PickerPhoto[];
    semanticScores: SemanticScoreMap | null;
}

/** runFillAttempt's parameters. */
export interface FillAttemptParams {
    label: FillLabel;
    challenge: Challenge;
    token: string;
    deps: FillDeps;
    wantCount: number;
    mustIncludeTags: readonly string[] | null;
    shouldIncludeTags: readonly string[] | null;
    /** undefined → the picker's default (true). */
    fillWithoutTagMatch: boolean | undefined;
    probeStandDown?: ((loaded: LoadedCandidates) => boolean) | null;
    onEmptyPick?: ((eligible: PickerPhoto[]) => string) | null;
    onRefreshed?: ((picked: string[]) => RefreshVerdict | null) | null;
}

/** A failed eligible-photo fetch. */
export interface FetchErrorResult {
    status: 'fetch-error';
    error: unknown;
}

/** runFillAttempt's outcome. */
export type FillAttemptResult =
    | FetchErrorResult
    | { status: 'probe-stand-down' }
    | { status: 'no-pick'; detail: string | null }
    | { status: 'gone' }
    | { status: 'refresh-stand-down' }
    | { status: 'submitted'; picked: string[] }
    | { status: 'submit-rejected'; reason: string }
    | { status: 'submit-threw'; error: unknown };

/** What a caught value is read as: an Error, or anything else whose `message` reads undefined. */
export interface ErrorLike {
    message?: string;
}
