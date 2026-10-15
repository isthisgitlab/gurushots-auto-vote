/**
 * The shape of an equivalence fixture, and the environment the hand-written ones share: the active-challenge list
 * every blob is read against (ids 101 to 105), the un-joined candidates, and the clock all times are anchored to.
 */

import type { V1Oracle } from '../../../helpers/v1Oracle';
import type { MatchTarget } from '../../../helpers/v1Oracle/ruleMatching';

type Values = Record<string, unknown>;

/** One 1.x `settings.json` and what it is read against. */
type Fixture = {
    name: string;
    /** The file: an object (written as JSON) or the text itself, for names JSON.stringify would not write. */
    blob: Values | string;
    /** The active-challenge list; the shared one when absent. */
    challenges?: MatchTarget[];
    /** Ids read as challenges although the active list does not hold them (a pin, a rotated-out challenge). */
    offList?: string[];
    /** Challenges not joined yet, read through the join resolution; the shared ones when absent. */
    candidates?: MatchTarget[];
    /** Left out of the golden output (the answer depends on the machine, not on the file). */
    golden?: false;
    /** What the fixture is meant to exercise, asserted on the oracle so a mistyped key cannot make it vacuous. */
    check?: (oracle: V1Oracle) => void;
};

/** 2026-10-15T00:00:00Z: close times below read 12:00 UTC, 15:00 in Riga, 08:00 in New York, 17:30 in Kolkata. */
const NOW = 1_792_022_400;
const HOUR = 3600;
const at = (hours: number, minutes = 0): number => NOW + hours * HOUR + minutes * 60;

const CHALLENGES: MatchTarget[] = [
    {
        id: '101',
        title: 'Macro World',
        tags: ['Exhibition', 'Comm'],
        type: 'default',
        max_photo_submits: 4,
        start_time: at(-12),
        close_time: at(12),
    },
    {
        id: '102',
        title: 'Night Sky',
        tags: ['No comm'],
        type: 'flash',
        max_photo_submits: 2,
        start_time: at(4),
        close_time: at(6),
    },
    {
        id: '103',
        title: 'Portrait Study',
        tags: [],
        type: 'default',
        max_photo_submits: 4,
        start_time: at(-60),
        close_time: at(12),
    },
    {
        id: 104,
        title: '  Street Life  ',
        tags: ['Exhibition'],
        type: 'special',
        max_photo_submits: 1,
        start_time: at(-1),
        close_time: at(12, 30),
    },
    { id: '105', title: null, tags: 'junk', type: 5, max_photo_submits: 'x' },
];

const CANDIDATES: MatchTarget[] = [
    {
        id: '901',
        title: 'Macro World',
        tags: ['Exhibition'],
        type: 'default',
        max_photo_submits: 4,
        start_time: at(-1),
        close_time: at(12),
    },
    {
        id: '902',
        title: 'Brand New Theme',
        tags: ['Comm'],
        type: 'flash',
        max_photo_submits: 2,
        start_time: at(-1),
        close_time: at(3),
    },
    { id: '903', title: 'night sky', type: 'flash', max_photo_submits: 2, close_time: at(6) },
    { title: 'Anonymous' },
];

/** The one-time flags a file that is already migrated carries; a fixture without them is migrated on load. */
const MODERN = {
    _timeUnitMigratedV1: true,
    _emergencyFillTimeMigratedV1: true,
    _autoFillScheduleMigratedV1: true,
    _autoFillScheduleBoundsV1: true,
    _scheduledFillListsMigratedV1: true,
    _scheduledFillListBoundsV1: true,
    _finalWindowExposureRenamedV1: true,
    _challengeRulesOrderedV1: true,
};

/** Two valid scenarios: Plan A moves a challenge through three phases, Plan B holds one. */
const PLAN_A = {
    name: 'Plan A',
    version: 1,
    start: 'warmup',
    phases: {
        warmup: { settings: { exposure: 40, exposureTarget: 60, autoFill: true, boostTime: 1800 } },
        push: {
            settings: { exposure: 90, exposureTarget: 95, mustIncludeTags: ['sky'], chosenPhotos: [] },
            rules: [{ do: [{ type: 'notify', message: 'Pushing' }] }],
        },
        idle: {},
    },
};
const PLAN_B = {
    name: 'Plan B',
    version: 1,
    start: 'only',
    phases: { only: { settings: { onlyBoost: true, autoJoin: true, emergencyFill: 0 } } },
};

export { CANDIDATES, CHALLENGES, HOUR, MODERN, NOW, PLAN_A, PLAN_B, at };
export type { Fixture, Values };
