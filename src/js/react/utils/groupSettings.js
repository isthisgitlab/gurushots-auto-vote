/**
 * Setting types whose editor is a multi-row list or a wide control row, so it
 * needs two grid columns to avoid wrapping into a ragged stack. Everything
 * else (toggle, number, tags, text) fits one column comfortably.
 */
const WIDE_SETTING_TYPES = new Set(['schedule', 'timeOfDayList', 'timeList']);

/**
 * Responsive grid for a settings section. One column on phones (Capacitor)
 * and narrow windows, two once the modal is wide enough for a full
 * hours/minutes control row (~430px per column), three on very wide desktops.
 * `items-start` keeps a short setting from stretching to its neighbour's
 * height.
 */
export const SETTINGS_GRID_CLASS = 'grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-x-5 gap-y-4 items-start';

/**
 * Chrome for one setting cell inside SETTINGS_GRID_CLASS. The border is what
 * makes a multi-column grid readable — without it, neighbouring settings of
 * different heights blur into one another. The _WIDE variant spans two
 * columns; the hand-written (non-schema-driven) cells in SettingsModal pick
 * between these two directly, while schema-driven ones go through
 * settingCellClass below.
 */
export const SETTING_CELL_CLASS = 'form-control rounded-box border border-base-300 p-3';
export const SETTING_CELL_CLASS_WIDE = `${SETTING_CELL_CLASS} lg:col-span-2`;

/**
 * Pick the cell chrome for a schema-driven setting by its editor type.
 *
 * @param {Object} config - serialized schema config for the setting
 * @returns {string}
 */
export function settingCellClass(config) {
    return WIDE_SETTING_TYPES.has(config?.type) ? SETTING_CELL_CLASS_WIDE : SETTING_CELL_CLASS;
}

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
