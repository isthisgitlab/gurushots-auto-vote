import * as settings from '../../settings';
import * as newEntryTracker from '../newEntryTracker';

import type { Challenge } from '../../types/gurushots';
import type { EntryTracker } from '../newEntryTracker';
import type { AutoVoteDecision } from '../decisions/voteDecisions';

/**
 * New-entry detection (voteOnNewEntry) state for one challenge.
 *
 * The setting is read HERE and nowhere else — VotingLogic takes the
 * already-gated boolean. Gating the whole block (not just the decision) keeps
 * the feature genuinely opt-in: metadata.json is a synchronous whole-file
 * read/write, and a user who never enables this should pay none of it.
 */
export const detectNewEntry = (challenge: Challenge, entryTracker: EntryTracker | null) => {
    const challengeId = challenge.id.toString();
    const tracking =
        entryTracker && settings.getEffectiveSetting('voteOnNewEntry', challengeId) === true
            ? newEntryTracker.readEntryIds(challenge)
            : null;
    // `tracking` is only set when entryTracker is.
    const previousIds = tracking ? (entryTracker as EntryTracker).get(challengeId) : null;
    const hasNewEntry = tracking ? newEntryTracker.hasNewEntries(previousIds, tracking) : false;
    return { challengeId, tracking, previousIds, hasNewEntry };
};

/**
 * How a detected new entry played out in the vote decision. Logged AFTER the
 * decision so the line matches the outcome: the voting pause holds the trigger
 * armed, so claiming "forcing a vote this cycle" off `hasNewEntry` alone would
 * repeat every cycle for the whole pause, directly above a "Skipping voting -
 * voting paused" line saying the opposite.
 */
export const describeNewEntryOutcome = (
    { forcedByNewEntry, preservesNewEntryTrigger, shouldVote }: AutoVoteDecision,
    missionVote: boolean,
) => {
    if (missionVote) return 'voting for the vote mission';
    if (forcedByNewEntry) return 'forcing a vote this cycle';
    if (preservesNewEntryTrigger) return 'vote deferred until the pause ends — trigger stays armed';
    return shouldVote ? 'already eligible on its own' : 'not voting this cycle';
};

/**
 * Record the entry snapshot, which disarms the trigger. Called after the vote,
 * and additionally from the post-submit cancellation return — that one bails
 * out of the whole pass after the vote already landed, so skipping the record
 * there would re-force the identical vote next pass. The two earlier
 * cancellation returns deliberately do NOT record: no vote went out yet, so the
 * trigger must stay armed.
 *
 * Skipped only when a vote this trigger FORCED threw, so the next cycle retries
 * it — that is the whole retry contract. Deliberately NOT skipped for:
 *   - "no vote images available", which is not a throw; treating it as a
 *     failure would force a getVoteImages call every cycle forever on a
 *     challenge that never has any.
 *   - a blocked decision (onlyBoost / vote-only-in-last-minute /
 *     scheduled-fill-only / not started), which consumes the trigger. Every
 *     block that can later lift, lifts into a rule that already votes to 100%
 *     or re-reads exposure from scratch, so nothing is lost.
 *
 * The exception to that last point is a block that sets
 * `preservesNewEntryTrigger` — today only the voting pause. It lifts into the
 * NORMAL threshold rule, which votes only while exposure is below the trigger,
 * so consuming the trigger here would drop the new entry's vote entirely
 * instead of deferring it past the pause.
 */
export const recordEntrySnapshot = (
    entryTracker: EntryTracker | null,
    entry: ReturnType<typeof detectNewEntry>,
    decision: AutoVoteDecision,
    voteThrew: boolean,
) => {
    if (!entry.tracking || (decision.forcedByNewEntry && voteThrew)) return;
    if (decision.preservesNewEntryTrigger && entry.hasNewEntry) return;
    if (!newEntryTracker.shouldRecordSnapshot(entry.previousIds, entry.tracking)) return;
    // `entry.tracking` is only set when entryTracker is.
    (entryTracker as EntryTracker).set(entry.challengeId, entry.tracking);
};
