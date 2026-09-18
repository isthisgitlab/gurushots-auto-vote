/**
 * Responsive grid for a settings section. One column on phones (Capacitor)
 * and narrow windows, two from `lg`.
 *
 * Two columns is the ceiling on purpose. The modal caps at max-w-6xl, so a
 * third column would make each one ~355px — narrower than the widest control
 * row (API retries + retry delay, ~435px) and too narrow for the paragraph
 * descriptions, which would grow taller by more than the extra column saves.
 * At two columns each cell is ~542px and every editor fits without wrapping,
 * so no setting needs to span.
 *
 * `items-start` keeps a short setting from stretching to its neighbour's
 * height.
 */
export const SETTINGS_GRID_CLASS = 'grid grid-cols-1 lg:grid-cols-2 gap-x-5 gap-y-4 items-start';

/**
 * Chrome for one setting cell inside SETTINGS_GRID_CLASS. The border is what
 * makes a multi-column grid readable — without it, neighbouring settings of
 * different heights blur into one another.
 */
export const SETTING_CELL_CLASS = 'form-control rounded-box border border-base-300 p-3';

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
