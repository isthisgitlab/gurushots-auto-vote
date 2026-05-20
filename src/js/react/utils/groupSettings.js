/**
 * Bucket schema entries into ordered UI sections for the settings modals.
 * Shared by SettingsModal (global) and ChallengeSettingsModal (per-challenge)
 * so both render the same grouping from a single source.
 *
 * - Sections follow the order of `groups` (the SETTINGS_GROUPS list).
 * - Within a section, entries keep schema declaration order.
 * - Empty sections are skipped (e.g. a group with only global-only settings
 *   when perChallengeOnly is set).
 * - Entries whose `group` matches no section (e.g. the internal
 *   autovoteRunning flag) are intentionally dropped.
 *
 * @param {Object|null} schema - serialized schema (key -> config with `group`)
 * @param {Array|null} groups - ordered [{ id, label }]
 * @param {{ perChallengeOnly?: boolean }} [options]
 * @returns {Array<{ id: string, label: string, entries: Array<[string, Object]> }>}
 */
export function groupSchemaEntries(schema, groups, { perChallengeOnly = false } = {}) {
    if (!schema || !groups) return [];
    return groups
        .map(({ id, label }) => ({
            id,
            label,
            entries: Object.entries(schema).filter(
                ([, config]) => config.group === id && (!perChallengeOnly || config.perChallenge),
            ),
        }))
        .filter((group) => group.entries.length > 0);
}
