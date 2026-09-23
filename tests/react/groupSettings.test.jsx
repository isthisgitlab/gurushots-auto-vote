/**
 * Unit tests for groupSchemaEntries — the pure helper that buckets settings
 * schema entries into ordered UI sections for both settings modals.
 */
import { groupSchemaEntries, tierSchemaEntries } from '@/utils/groupSettings';

const groups = [
    { id: 'general', label: 'app.groupGeneral', tier: 'core' },
    { id: 'boost', label: 'app.groupBoost', tier: 'core' },
    { id: 'empty', label: 'app.groupEmpty', tier: 'core' },
];

const tiers = [
    { id: 'core', label: 'app.tierCore' },
    { id: 'overrides', label: 'app.tierOverrides' },
];

// boostTime is declared first on purpose, even though `general` comes first in
// `groups` — proving section order follows `groups`, not schema declaration.
const schema = {
    boostTime: { perChallenge: true, group: 'boost' },
    exposure: { perChallenge: true, group: 'general' },
    onlyBoost: { perChallenge: true, group: 'general' },
    lastMinuteCheckFrequency: { perChallenge: false, group: 'general' },
    autovoteRunning: { perChallenge: false }, // no group → dropped
    orphan: { perChallenge: true, group: 'nonexistent' }, // unknown group → dropped
};

const keysOf = (section) => section.entries.map(([key]) => key);

describe('groupSchemaEntries', () => {
    test('returns sections in groups order, carrying labels', () => {
        const result = groupSchemaEntries(schema, groups);
        expect(result.map((s) => s.id)).toEqual(['general', 'boost']);
        expect(result[0].label).toBe('app.groupGeneral');
        expect(result[1].label).toBe('app.groupBoost');
    });

    test('keeps schema declaration order within a section', () => {
        const [general] = groupSchemaEntries(schema, groups);
        expect(keysOf(general)).toEqual(['exposure', 'onlyBoost', 'lastMinuteCheckFrequency']);
    });

    test('challengeOnly entries are dropped from the global view and kept per challenge', () => {
        const withChallengeOnly = { ...schema, autoSwap: { perChallenge: true, challengeOnly: true, group: 'boost' } };
        const global = groupSchemaEntries(withChallengeOnly, groups);
        expect(global.find((g) => g.id === 'boost').entries.map(([key]) => key)).toEqual(['boostTime']);
        const perChallenge = groupSchemaEntries(withChallengeOnly, groups, { perChallengeOnly: true });
        expect(perChallenge.find((g) => g.id === 'boost').entries.map(([key]) => key)).toEqual([
            'boostTime',
            'autoSwap',
        ]);
    });

    test('perChallengeOnly drops perChallenge:false entries', () => {
        const result = groupSchemaEntries(schema, groups, { perChallengeOnly: true });
        const general = result.find((s) => s.id === 'general');
        expect(keysOf(general)).toEqual(['exposure', 'onlyBoost']);
    });

    test('skips groups with no matching entries', () => {
        const result = groupSchemaEntries(schema, groups);
        expect(result.some((s) => s.id === 'empty')).toBe(false);
    });

    test('drops entries with no group or an unknown group', () => {
        const all = groupSchemaEntries(schema, groups).flatMap(keysOf);
        expect(all).not.toContain('autovoteRunning');
        expect(all).not.toContain('orphan');
    });

    test('returns [] when schema or groups is missing', () => {
        expect(groupSchemaEntries(null, groups)).toEqual([]);
        expect(groupSchemaEntries(schema, null)).toEqual([]);
        expect(groupSchemaEntries(undefined, undefined)).toEqual([]);
    });

    // An ENTIRELY-global group (every entry perChallenge:false) — the shape of
    // the new `notifications` group. It must render in the global modal (no
    // filter) and vanish completely from the per-challenge modal, rather than
    // rendering an empty section header there.
    test('an all-global group renders globally and is dropped under perChallengeOnly', () => {
        const groupsWithNotif = [...groups, { id: 'notifications', label: 'app.groupNotifications' }];
        const schemaWithNotif = {
            ...schema,
            notifyOnBoost: { perChallenge: false, group: 'notifications' },
            notifyLeadTime: { perChallenge: false, group: 'notifications' },
        };

        const global = groupSchemaEntries(schemaWithNotif, groupsWithNotif);
        const notif = global.find((s) => s.id === 'notifications');
        expect(keysOf(notif)).toEqual(['notifyOnBoost', 'notifyLeadTime']);

        const perChallenge = groupSchemaEntries(schemaWithNotif, groupsWithNotif, { perChallengeOnly: true });
        expect(perChallenge.some((s) => s.id === 'notifications')).toBe(false);
    });
});

describe('tierSchemaEntries', () => {
    const bandIds = (bands) => bands.map((b) => b.id);
    const groupIdsIn = (band) => band.groups.map((g) => g.id);

    test('bands groups under their tier, in tiers order', () => {
        const withOverride = [...groups, { id: 'lastMinute', label: 'app.groupLastMinute', tier: 'overrides' }];
        const withEntry = { ...schema, voteOnlyInLastMinute: { perChallenge: true, group: 'lastMinute' } };

        const bands = tierSchemaEntries(withEntry, withOverride, tiers);
        expect(bandIds(bands)).toEqual(['core', 'overrides']);
        expect(bands[0].label).toBe('app.tierCore');
        expect(groupIdsIn(bands[0])).toEqual(['general', 'boost']);
        expect(groupIdsIn(bands[1])).toEqual(['lastMinute']);
    });

    // A tier whose every group filtered out must not render a bare heading.
    test('skips a tier left with no groups', () => {
        const bands = tierSchemaEntries(schema, groups, tiers);
        expect(bandIds(bands)).toEqual(['core']);
    });

    // Losing a section would HIDE settings, so an unmatched tier degrades to a
    // trailing unlabelled band instead of being dropped.
    test('collects groups with an unknown tier into a trailing unlabelled band', () => {
        const stray = [...groups, { id: 'display', label: 'app.groupDisplay', tier: 'nope' }];
        const withEntry = { ...schema, compactCards: { perChallenge: true, group: 'display' } };

        const bands = tierSchemaEntries(withEntry, stray, tiers);
        expect(bandIds(bands)).toEqual(['core', null]);
        const trailing = bands[bands.length - 1];
        expect(trailing.label).toBeNull();
        expect(groupIdsIn(trailing)).toEqual(['display']);
    });

    // An older main process that predates the `tiers` IPC field sends none —
    // everything must still render, as one flat unlabelled band.
    test('falls back to a single unlabelled band when tiers is missing', () => {
        for (const missing of [null, undefined]) {
            const bands = tierSchemaEntries(schema, groups, missing);
            expect(bands).toHaveLength(1);
            expect(bands[0].label).toBeNull();
            expect(groupIdsIn(bands[0])).toEqual(['general', 'boost']);
        }
    });

    test('forwards perChallengeOnly to the group filter', () => {
        const bands = tierSchemaEntries(schema, groups, tiers, { perChallengeOnly: true });
        const general = bands[0].groups.find((g) => g.id === 'general');
        expect(general.entries.map(([key]) => key)).toEqual(['exposure', 'onlyBoost']);
    });

    test('returns [] when schema or groups is missing', () => {
        expect(tierSchemaEntries(null, groups, tiers)).toEqual([]);
        expect(tierSchemaEntries(schema, null, tiers)).toEqual([]);
    });
});
