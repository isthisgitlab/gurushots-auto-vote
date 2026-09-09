/**
 * Unit tests for groupSchemaEntries — the pure helper that buckets settings
 * schema entries into ordered UI sections for both settings modals.
 */
import { groupSchemaEntries } from '@/utils/groupSettings';

const groups = [
    { id: 'general', label: 'app.groupGeneral' },
    { id: 'boost', label: 'app.groupBoost' },
    { id: 'empty', label: 'app.groupEmpty' },
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
