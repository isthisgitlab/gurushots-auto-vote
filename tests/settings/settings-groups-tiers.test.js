/**
 * Guards the SETTINGS_SCHEMA -> SETTINGS_GROUPS -> SETTINGS_TIERS contract that
 * drives the settings modals' section list.
 *
 * tierSchemaEntries deliberately fails OPEN: a group whose `tier` matches no
 * tier still renders, in a trailing unlabelled band, because dropping it would
 * hide settings from the user. That safety net means a typo (`tier: 'overide'`)
 * or a forgotten `tier` on a new group produces no crash and no warning — it
 * just quietly ships an unheaded band at the bottom of the modal, which only an
 * eyeball on the UI would catch. These tests are that missing signal, at CI
 * time rather than at runtime.
 */
const { SETTINGS_SCHEMA, SETTINGS_GROUPS, SETTINGS_TIERS } = require('../../src/js/settings/schema');
const english = require('../../src/js/translations/english');

/** Resolve an 'app.foo' translation key against english.js. */
const resolveLabel = (key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), english);

describe('settings group/tier contract', () => {
    test('every group declares a tier that exists in SETTINGS_TIERS', () => {
        const tierIds = new Set(SETTINGS_TIERS.map((tier) => tier.id));
        const orphans = SETTINGS_GROUPS.filter((group) => !tierIds.has(group.tier)).map((group) => ({
            group: group.id,
            tier: group.tier,
        }));

        // Named rather than counted so a failure says which group and which bad
        // tier, instead of just "expected 0".
        expect(orphans).toEqual([]);
    });

    test('group ids and tier ids are each unique', () => {
        const groupIds = SETTINGS_GROUPS.map((group) => group.id);
        const tierIds = SETTINGS_TIERS.map((tier) => tier.id);
        expect(groupIds).toHaveLength(new Set(groupIds).size);
        expect(tierIds).toHaveLength(new Set(tierIds).size);
    });

    test('every schema entry with a group points at a real group', () => {
        const groupIds = new Set(SETTINGS_GROUPS.map((group) => group.id));
        const dangling = Object.entries(SETTINGS_SCHEMA)
            .filter(([, config]) => config.group && !groupIds.has(config.group))
            .map(([key, config]) => ({ key, group: config.group }));

        expect(dangling).toEqual([]);
    });

    // An empty group renders no section at all (groupSchemaEntries filters it
    // out), so a group left behind by a settings removal would be invisible
    // dead config rather than an obvious break.
    test('every group owns at least one schema entry', () => {
        const used = new Set(Object.values(SETTINGS_SCHEMA).map((config) => config.group));
        const empty = SETTINGS_GROUPS.filter((group) => !used.has(group.id)).map((group) => group.id);

        expect(empty).toEqual([]);
    });

    // A mistyped label key does not throw — t() echoes the key back, so the UI
    // would show a literal "app.groupDisplay" as the heading.
    test('every group and tier label resolves in english.js', () => {
        const unresolved = [...SETTINGS_GROUPS, ...SETTINGS_TIERS]
            .filter((entry) => typeof resolveLabel(entry.label) !== 'string')
            .map((entry) => ({ id: entry.id, label: entry.label }));

        expect(unresolved).toEqual([]);
    });

    // The sub-line the overrides band renders is keyed off the tier id, so the
    // two must not drift apart silently (see ui/SettingsTierHeading.jsx).
    test('the overrides tier exists and its description key resolves', () => {
        expect(SETTINGS_TIERS.map((tier) => tier.id)).toContain('overrides');
        expect(typeof resolveLabel('app.tierOverridesDesc')).toBe('string');
    });
});
