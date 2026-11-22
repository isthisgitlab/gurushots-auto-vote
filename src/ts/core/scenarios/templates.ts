/**
 * Example scenarios users can copy and adapt (`scenario-template <id>`, and
 * "New from template" in the GUI). Examples, not built-ins: nothing here is
 * seeded into storage, and every value is meant to be tuned — the thresholds
 * are starting points, not recommendations.
 *
 * Dependency-free so the renderer can list them. Every template must pass
 * validateScenario (tests/scenarios/templates.test.ts). The remote link's frozen contract
 * (remote/contract/v3/channelsScenarioLibrary.ts) embeds the shape of this list: a template
 * added or changed here is added there in the same change.
 */

// A function, so each phase owns its settings object: an in-place edit of one
// phase cannot reach another phase.
const loweredExposureSettings = () => ({
    exposure: 10,
    exposureTarget: 12,
    // Off here, so a final-window trigger above 10% in the
    // global defaults cannot conflict with the lowered exposure.
    useFinalWindowExposure: false,
    autoSubmit: false,
    autoBoost: false,
});

const SCENARIO_TEMPLATES = [
    {
        id: 'exhibitionDoubleDip',
        scenario: {
            name: 'Exhibition double-dip',
            version: 1,
            description:
                'From 5 days before the end, enter one photo each morning and keep exposure topped up. If a photo breaks out (twice the votes per hour of the others over 6 h, and 30+ votes), hold it out of the challenge and swap it back in on the last morning, boost it, then swap it out and back once it reaches #1. With no breakout, just boost the best entry on the last morning.',
            start: 'buildup',
            phases: {
                buildup: {
                    settings: loweredExposureSettings(),
                    rules: [
                        {
                            id: 'daily-entry',
                            label: 'One new photo each morning',
                            repeat: 'oncePerDay',
                            if: [
                                { type: 'dailyWindow', from: '06:00', to: '08:00' },
                                { type: 'beforeEnd', max: '5d' },
                                { type: 'entries', op: '<', value: 3 },
                                { type: 'freeSlots', op: '>', value: 1 },
                            ],
                            do: [{ type: 'enterPhoto', photo: 'best' }],
                        },
                        {
                            id: 'breakout',
                            label: 'A photo broke out: hold it back',
                            if: [
                                { type: 'beforeEnd', min: '1d' },
                                {
                                    type: 'entry',
                                    select: { by: 'fastest', window: '6h' },
                                    field: 'speedRatio',
                                    window: '6h',
                                    op: '>=',
                                    value: 2,
                                },
                                {
                                    type: 'entry',
                                    select: { by: 'fastest', window: '6h' },
                                    field: 'votes',
                                    op: '>=',
                                    value: 30,
                                },
                            ],
                            do: [
                                {
                                    type: 'swap',
                                    entry: { by: 'fastest', window: '6h' },
                                    with: 'best',
                                    rememberRemoved: 'held',
                                    rememberAdded: 'filler',
                                },
                                { type: 'goto', phase: 'holding' },
                            ],
                        },
                        {
                            id: 'plain-boost',
                            label: 'No breakout: boost the best entry on the last morning',
                            repeat: 'once',
                            if: [
                                { type: 'dailyWindow', from: '06:00', to: '08:00' },
                                { type: 'beforeEnd', max: '1d' },
                                { type: 'boostState', in: ['AVAILABLE', 'AVAILABLE_KEY'] },
                            ],
                            do: [
                                { type: 'boost', entry: { by: 'bestRank' } },
                                { type: 'goto', phase: 'done' },
                            ],
                        },
                    ],
                },
                holding: {
                    settings: loweredExposureSettings(),
                    rules: [
                        {
                            id: 'comeback',
                            label: 'Last morning: swap the held photo back in and boost it',
                            repeat: 'once',
                            if: [
                                { type: 'dailyWindow', from: '06:00', to: '08:00' },
                                { type: 'beforeEnd', max: '1d' },
                            ],
                            do: [
                                { type: 'swap', entry: { by: 'memory', slot: 'filler' }, with: { memory: 'held' } },
                                { type: 'boost', entry: { by: 'memory', slot: 'held' } },
                                { type: 'goto', phase: 'pulse' },
                            ],
                        },
                    ],
                },
                pulse: {
                    settings: { autoSubmit: false, autoBoost: false },
                    rules: [
                        {
                            id: 'pulse-out',
                            label: 'At #1: swap it out',
                            if: [
                                {
                                    type: 'entry',
                                    select: { by: 'memory', slot: 'held' },
                                    field: 'rank',
                                    op: '<=',
                                    value: 1,
                                },
                            ],
                            do: [
                                {
                                    type: 'swap',
                                    entry: { by: 'memory', slot: 'held' },
                                    with: 'best',
                                    rememberAdded: 'filler',
                                },
                                { type: 'goto', phase: 'pulseWait' },
                            ],
                        },
                    ],
                },
                pulseWait: {
                    settings: { autoSubmit: false, autoBoost: false },
                    rules: [
                        {
                            id: 'pulse-back',
                            label: 'After 4 minutes: swap it back in',
                            if: [{ type: 'inPhaseFor', min: '4m' }],
                            do: [
                                { type: 'swap', entry: { by: 'memory', slot: 'filler' }, with: { memory: 'held' } },
                                { type: 'goto', phase: 'done' },
                            ],
                        },
                    ],
                },
                done: {},
            },
        },
    },
    {
        id: 'eveningBoost',
        scenario: {
            name: 'Evening boost before the last day',
            version: 1,
            description: 'Boost the best-ranked entry at 20:00 on the second-to-last day.',
            start: 'main',
            phases: {
                main: {
                    settings: { autoBoost: false },
                    rules: [
                        {
                            id: 'evening-boost',
                            repeat: 'once',
                            if: [
                                { type: 'dailyWindow', from: '20:00', to: '21:00' },
                                { type: 'beforeEnd', min: '1d', max: '2d' },
                                { type: 'boostState', in: ['AVAILABLE', 'AVAILABLE_KEY'] },
                            ],
                            do: [{ type: 'boost', entry: { by: 'bestRank' } }],
                        },
                    ],
                },
            },
        },
    },
    {
        id: 'morningSwap',
        scenario: {
            name: 'Morning swap of the weakest entry',
            version: 1,
            description: 'From day 3 on, swap the entry with the fewest votes for the best fresh photo every morning.',
            start: 'main',
            limits: { swaps: 10 },
            phases: {
                main: {
                    rules: [
                        {
                            id: 'morning-swap',
                            repeat: 'oncePerDay',
                            if: [
                                { type: 'afterStart', min: '3d' },
                                { type: 'dailyWindow', from: '07:00', to: '09:00' },
                                { type: 'balance', currency: 'swaps', op: '>', value: 0 },
                            ],
                            do: [{ type: 'swap', entry: { by: 'fewestVotes', skipProtected: true }, with: 'best' }],
                        },
                    ],
                },
            },
        },
    },
    {
        id: 'topTenTurbo',
        scenario: {
            name: 'Turbo in the top 10',
            version: 1,
            description: 'Apply a won turbo to the best-ranked entry once it is in the top 10.',
            start: 'main',
            phases: {
                main: {
                    settings: { useTurbo: false },
                    rules: [
                        {
                            id: 'turbo-top-ten',
                            repeat: 'once',
                            if: [
                                { type: 'turboState', in: ['WON'] },
                                { type: 'entry', select: { by: 'bestRank' }, field: 'rank', op: '<=', value: 10 },
                                { type: 'entry', select: { by: 'bestRank' }, field: 'turbo', op: '=', value: false },
                            ],
                            do: [{ type: 'turbo', entry: { by: 'bestRank' } }],
                        },
                    ],
                },
            },
        },
    },
    {
        id: 'dynamicSubmission',
        scenario: {
            name: 'Submit photos on a dynamic schedule',
            version: 1,
            description:
                'Photo 1 comes from joining. Photo 2 goes in 10 h before the end, or 1 h before the free Boost expires if that is earlier. Photo 3 goes in 9 h before the end and photo 4 8 h before it. A photo already in counts for its row. Auto-Submit must be on.',
            start: 'push',
            phases: {
                push: {
                    settings: { autoSubmit: true },
                    schedules: {
                        submit: {
                            alignment: 'end',
                            rows: [
                                {
                                    count: 2,
                                    at: {
                                        kind: 'earlier',
                                        of: [
                                            {
                                                kind: 'offset',
                                                from: { kind: 'fact', name: 'challenge.end' },
                                                by: { kind: 'literal', value: 10, quantity: 'duration', unit: 'hours' },
                                                direction: 'before',
                                            },
                                            {
                                                kind: 'offset',
                                                from: { kind: 'fact', name: 'boost.freeExpiry' },
                                                by: { kind: 'literal', value: 1, quantity: 'duration', unit: 'hours' },
                                                direction: 'before',
                                            },
                                        ],
                                    },
                                },
                                {
                                    count: 3,
                                    at: {
                                        kind: 'offset',
                                        from: { kind: 'fact', name: 'challenge.end' },
                                        by: { kind: 'literal', value: 9, quantity: 'duration', unit: 'hours' },
                                        direction: 'before',
                                    },
                                },
                                {
                                    count: 4,
                                    at: {
                                        kind: 'offset',
                                        from: { kind: 'fact', name: 'challenge.end' },
                                        by: { kind: 'literal', value: 8, quantity: 'duration', unit: 'hours' },
                                        direction: 'before',
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        },
    },
    {
        id: 'candidateJoin',
        scenario: {
            name: 'Join cheap challenges when photos are ready',
            version: 1,
            description:
                'Before joining, join a challenge that costs 50 coins or less when at least 3 of your photos can enter it. The join never spends more than 50 coins.',
            start: 'candidate',
            phases: {
                candidate: {
                    rules: [
                        {
                            id: 'join-cheap',
                            label: 'Join when cheap and photos are ready',
                            repeat: 'once',
                            stages: ['preJoin'],
                            if: [
                                {
                                    type: 'compare',
                                    left: { kind: 'fact', name: 'challenge.joinPrice' },
                                    op: '<=',
                                    right: { kind: 'literal', value: 50, quantity: 'coins' },
                                },
                                {
                                    type: 'compare',
                                    left: { kind: 'fact', name: 'photos.eligibleCount' },
                                    op: '>=',
                                    right: { kind: 'literal', value: 3, quantity: 'count' },
                                },
                            ],
                            do: [{ type: 'join', maxCoins: { kind: 'literal', value: 50, quantity: 'coins' } }],
                        },
                    ],
                },
            },
        },
    },
    {
        id: 'photoQueue',
        scenario: {
            name: 'Photo queue with a Boost pin',
            version: 1,
            description:
                'Enter photos from the photo pool "Morning queue" in order, using only those photos. Create that pool first, or change the name. Turbo stays unpinned here. In the last 2 days, pin Boost to the best-ranked entry.',
            start: 'queue',
            phases: {
                queue: {
                    photoPool: { name: 'Morning queue', only: true, inOrder: true },
                    pins: { turbo: null },
                    rules: [
                        {
                            id: 'pin-boost',
                            label: 'Pin Boost to the best-ranked entry',
                            repeat: 'once',
                            if: [{ type: 'beforeEnd', max: '2d' }],
                            do: [{ type: 'setPin', power: 'boost', entry: { by: 'bestRank' } }],
                        },
                    ],
                },
            },
        },
    },
    {
        id: 'installationPolicy',
        scenario: {
            name: 'Missions and currency for this installation',
            version: 1,
            description:
                'For the whole installation: keep 1 key, 2 swaps and 2 fills in reserve, spend at most 100 coins on joins per cycle, claim prizes and do the missions that save Turbos and join early. Tells you when keys run out.',
            scope: 'installation',
            start: 'policy',
            phases: {
                policy: {
                    settings: {
                        currencyReserveKeys: 1,
                        currencyReserveSwaps: 2,
                        currencyReserveFills: 2,
                        autoJoinCycleCoinBudget: 100,
                        autoClaimPrizes: true,
                        missionSaveTurbos: true,
                        missionJoinEarly: true,
                    },
                    rules: [
                        {
                            id: 'keys-out',
                            label: 'Keys ran out',
                            repeat: 'once',
                            if: [{ type: 'balance', currency: 'keys', op: '<', value: 1 }],
                            do: [{ type: 'notify', message: 'You are out of keys.' }],
                        },
                    ],
                },
            },
        },
    },
];

export { SCENARIO_TEMPLATES };
