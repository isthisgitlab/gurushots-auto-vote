/**
 * Shapes of the voting pass's injected dependencies (services/votingOrchestrator.ts
 * runVotingPass, shared by strategies/real and mock/strategy.ts) and of the
 * per-challenge scenario step (services/scenarioRunner.ts). Type-only: nothing
 * here exists at runtime.
 *
 * The endpoint signatures are the real api/* and strategies/real ones; the mock
 * endpoints mirror them. They are declared as methods so the real and mock
 * implementations both fit (method parameters are checked bivariantly).
 */

import type { Challenge } from './gurushots';
import type { getActiveChallenges as GetActiveChallenges } from '../strategies/real/activeChallenges';
import type { applyBoost as ApplyBoost } from '../strategies/real/applyBoost';
import type { runTurboMiniGame as RunTurboMiniGame } from '../strategies/real';
import type { getVoteImages as GetVoteImages, submitVotes as SubmitVotes } from '../api/voting';
import type { applyBoostToEntry as ApplyBoostToEntry } from '../api/boost';
import type { applyTurbo as ApplyTurbo } from '../api/turbo';
import type {
    getEligiblePhotos as GetEligiblePhotos,
    getImageData as GetImageData,
    submitToChallenge as SubmitToChallenge,
} from '../api/submissions';
import type {
    getCurrentMemberProfile as GetCurrentMemberProfile,
    searchTagAutocomplete as SearchTagAutocomplete,
} from '../api/tags';
import type { CurrencyPassDeps } from '../services/currencyAuto';
import type { createStateLedger as CreateScenarioStateLedger } from '../scenarioStateStore';
import type { EntryTracker } from '../services/newEntryTracker';
import type { EntryAgeLedger } from './stores';
import type { MissionNeeds } from '../services/missions';

/** The endpoint set runVotingPass reads off `deps.api`. */
export interface VotingPassApi {
    getActiveChallenges(...args: Parameters<typeof GetActiveChallenges>): ReturnType<typeof GetActiveChallenges>;
    getVoteImages(...args: Parameters<typeof GetVoteImages>): ReturnType<typeof GetVoteImages>;
    submitVotes(...args: Parameters<typeof SubmitVotes>): ReturnType<typeof SubmitVotes>;
    applyBoost(...args: Parameters<typeof ApplyBoost>): ReturnType<typeof ApplyBoost>;
    applyBoostToEntry(...args: Parameters<typeof ApplyBoostToEntry>): ReturnType<typeof ApplyBoostToEntry>;
    applyTurbo(...args: Parameters<typeof ApplyTurbo>): ReturnType<typeof ApplyTurbo>;
    getEligiblePhotos(...args: Parameters<typeof GetEligiblePhotos>): ReturnType<typeof GetEligiblePhotos>;
    getImageData(...args: Parameters<typeof GetImageData>): ReturnType<typeof GetImageData>;
    submitToChallenge(...args: Parameters<typeof SubmitToChallenge>): ReturnType<typeof SubmitToChallenge>;
    runTurboMiniGame(...args: Parameters<typeof RunTurboMiniGame>): ReturnType<typeof RunTurboMiniGame>;
    /** Optional: without the pair the themed photo search skips tag resolution. */
    getCurrentMemberProfile?(
        ...args: Parameters<typeof GetCurrentMemberProfile>
    ): ReturnType<typeof GetCurrentMemberProfile>;
    searchTagAutocomplete?(...args: Parameters<typeof SearchTagAutocomplete>): ReturnType<typeof SearchTagAutocomplete>;
}

export type ScenarioStateLedger = ReturnType<typeof CreateScenarioStateLedger>;

/** `deps.scenarios`: backs the user-defined scenarios. */
export interface ScenarioDeps {
    ledger: ScenarioStateLedger;
    /** False while another loop (the Android background service) owns scenarios. */
    enabled?: () => boolean;
}

/** runVotingPass's injected, strategy-specific behavior. */
export interface VotingPassDeps {
    api: VotingPassApi;
    /** Real mode prunes stale per-challenge metadata; mock passes null. */
    cleanupStaleMetadata: ((activeChallengeIds: string[]) => boolean) | null;
    /** ms to wait between challenges. */
    interChallengeDelay: () => number;
    entryTracker?: EntryTracker | null;
    /** When each entry entered its challenge (the boost fresh-entry wait); omitted = never hold. */
    entryAges?: EntryAgeLedger | null;
    /** Backs the automatic key / swap / fill spends (services/currencyAuto.ts). */
    currency?: CurrencyPassDeps | null;
    scenarios?: ScenarioDeps | null;
    /** What the active missions still need (services/missions.ts); counted down as the pass lands them. */
    missions?: MissionNeeds | null;
    /** Headless Android refreshes server progress before spending a saved Turbo. */
    refreshMissionNeeds?: (() => Promise<MissionNeeds | null>) | null;
}

/** What a voting pass resolves with. `challenges` is the full active list this cycle fetched. */
export interface VotingPassResult {
    success: boolean;
    message?: string;
    error?: string;
    challenges?: Challenge[];
}
