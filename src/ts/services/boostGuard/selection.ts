/**
 * The main process does not poll the API itself; it remembers the last
 * challenge list the renderer fetched through `get-active-challenges` (the
 * cadence chain and the list view both refresh through it). Window expiry is
 * checked against the wall clock at quit time; a boost applied since the last
 * fetch can prompt once more, which is the cheap side to err on.
 */

import { openBoostWindows } from '../../voting/boostWindow';

import type { Challenge } from '../../types/gurushots';
import type { EntryAgeLedger } from '../../types/stores';

/**
 * describeDeadlineActions' shape, as far as the guard reads it.
 */
type DescribeDeadlineActions = (
    challenge: Challenge,
    now: number,
    entryAges: EntryAgeLedger | null,
) => { actions?: Array<{ action: string; dueAt: number | null }> } | null | undefined;

const QUIT_WARN_HORIZON_SEC = 60 * 60;
// Narrower than the quit prompt's: a sleep (even a 2-minute lid close) spends a
// boost this much earlier than Boost Time, so only boosts due within 30 min go.
const SUSPEND_BOOST_HORIZON_SEC = 30 * 60;

// Last successful challenge list from get-active-challenges, and the mock flag
// it was fetched under (null until one has been).
let lastChallenges: readonly Challenge[] = [];
let lastChallengesMock: boolean | null = null;

/**
 * @param challenges - the get-active-challenges list (ignored unless an array)
 * @param mock - the `mock` setting the list was fetched under
 */
const rememberChallenges = (challenges: readonly Challenge[] | null | undefined, mock: boolean) => {
    if (!Array.isArray(challenges)) return;
    lastChallenges = challenges;
    lastChallengesMock = mock;
};

/** The `mock` setting the remembered list was fetched under; null when there is none. */
const rememberedChallengesMock = (): boolean | null => lastChallengesMock;

/** Mark the remembered challenge's boost as used, so it no longer counts as pending; a fresh `rememberChallenges` list replaces the mark. */
const markBoostApplied = (id: Challenge['id']) => {
    const boost = lastChallenges.find((c) => c.id === id)?.member?.boost;
    if (boost) boost.state = 'USED';
};

/** Clear the remembered list and its mock flag — the values `resetQuitGuard` resets with the rest of the guard's state. */
const resetBoostSelection = () => {
    lastChallenges = [];
    lastChallengesMock = null;
};

/**
 * Open boost windows whose boost auto-vote would apply within the horizon,
 * soonest first.
 *
 * @param now - Unix seconds
 * @param horizonSec - only boosts due within this many seconds
 * @param entryAges - the ledger describeDeadlineActions honours the Boost-pinned-submit
 *   latch against; threaded so the guard reads the same ledger the runner writes
 */
const imminentBoostChallenges = (
    now: number,
    describe: DescribeDeadlineActions,
    horizonSec: number,
    entryAges: EntryAgeLedger | null,
): Array<{ challenge: Challenge; dueAt: number }> => {
    const open = new Set(openBoostWindows(lastChallenges, now).map((w) => w.id));
    return lastChallenges
        .filter((c) => open.has(c.id))
        .map((challenge) => ({
            challenge,
            dueAt: describe(challenge, now, entryAges)?.actions?.find((a) => a.action === 'boost')?.dueAt,
        }))
        .flatMap(({ challenge, dueAt }) =>
            typeof dueAt === 'number' && dueAt - now <= horizonSec ? [{ challenge, dueAt }] : [],
        )
        .sort((a, b) => a.dueAt - b.dueAt);
};

export {
    rememberChallenges,
    rememberedChallengesMock,
    markBoostApplied,
    resetBoostSelection,
    imminentBoostChallenges,
    QUIT_WARN_HORIZON_SEC,
    SUSPEND_BOOST_HORIZON_SEC,
};
export type { DescribeDeadlineActions };
