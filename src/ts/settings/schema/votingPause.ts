/**
 * The `votingPause` group, the inverse of scheduled fill: windows in which
 * automatic voting is REFUSED rather than forced. Motivated by the overnight
 * gap between match rounds — exposure filled at 03:00 buys almost no votes, so
 * the votes are better spent after the morning round opens.
 *
 * Same two trigger forms, same lists-of-entries shape, same validators and
 * same entry cap as scheduled fill, with votingPauseDurationMinutes playing
 * the scheduledFillWindowMinutes role. The decision-side consumer is
 * getVotingPauseState in services/decisions/triggerWindows.ts.
 *
 * Deliberately NOT a cadence input: the pass still runs on its normal
 * schedule during a pause and each paused challenge is skipped with a
 * reason. Suppressing the wake instead would have to out-rank every other
 * scheduling boundary (boost timers, last-minute cadence), which is the
 * one thing the scheduler's "never sleep past a boundary" invariant
 * forbids.
 */

import { z } from 'zod';
import { MAX_VOTING_PAUSE_MINUTES } from '../limits';
import { beforeEndList, timeOfDayList } from './scheduledFill';
import { zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

// The pause reuses scheduled fill's two trigger validators (daily 'HH:MM' +
// seconds-before-close, sharing MAX_SCHEDULED_FILL_ENTRIES), and its duration
// has the same 5m..12h bounds as a fill window. The ONLY difference is what the
// window does — scheduled fill votes inside it, the pause refuses to. Keep
// them sharing validators so the two features can never drift on bounds or
// messages. The duration is bound to the shared constant the decision path
// clamps against, so the validator and the runtime ceiling can't drift apart.
const pauseDurationMinutes = z.number().int().min(5).max(MAX_VOTING_PAUSE_MINUTES);

export const votingPauseSettings = {
    useVotingPause: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'votingPause',
        label: 'app.useVotingPause',
        description: 'app.useVotingPauseDesc',
    },
    votingPauseTime: {
        type: 'timeOfDayList',
        default: [], // [] = this form off
        perChallenge: true,
        validation: timeOfDayList,
        validationOrder: 1,
        group: 'votingPause',
        label: 'app.votingPauseTime',
        description: 'app.votingPauseTimeDesc',
    },
    votingPauseBeforeEnd: {
        type: 'timeList', // rows of hours/minutes inputs, stored as seconds each
        default: [], // [] = this form off
        perChallenge: true,
        validation: beforeEndList,
        validationOrder: 1,
        group: 'votingPause',
        label: 'app.votingPauseBeforeEnd',
        description: 'app.votingPauseBeforeEndDesc',
    },
    votingPauseDurationMinutes: {
        type: 'number',
        default: 240,
        perChallenge: true,
        validation: pauseDurationMinutes,
        // 5 is the real floor (what saving enforces and what the CLI documents);
        // getVotingPauseState still honours a SMALLER hand-edited value, matching
        // scheduledFillWindowMinutes' escape hatch. The ceiling is NOT an escape
        // hatch though — getVotingPauseState clamps to it, because an oversized
        // pause window swallows every future cycle and stops voting for good.
        min: 5,
        max: MAX_VOTING_PAUSE_MINUTES,
        unit: 'app.unitMinutes',
        validationOrder: 1,
        group: 'votingPause',
        label: 'app.votingPauseDurationMinutes',
        description: 'app.votingPauseDurationMinutesDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
