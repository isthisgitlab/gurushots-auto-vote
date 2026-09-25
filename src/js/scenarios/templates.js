/**
 * Example scenarios users can copy and adapt (`scenario-template <id>`, and
 * "New from template" in the GUI). Examples, not built-ins: nothing here is
 * seeded into storage, and every value is meant to be tuned — the thresholds
 * are starting points, not recommendations.
 *
 * Dependency-free so the renderer can list them. Every template must pass
 * validateScenario (tests/scenarios/templates.test.js).
 */

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
                    settings: { exposure: 10, exposureTarget: 12, autoFill: false, autoBoost: false },
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
                    settings: { exposure: 10, exposureTarget: 12, autoFill: false, autoBoost: false },
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
                    settings: { autoFill: false, autoBoost: false },
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
                    settings: { autoFill: false, autoBoost: false },
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
];

module.exports = { SCENARIO_TEMPLATES };
