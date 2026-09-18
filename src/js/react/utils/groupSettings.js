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
        .map(({ id, label, tier }) => ({
            id,
            label,
            tier,
            entries: Object.entries(schema).filter(
                ([, config]) => config.group === id && (!perChallengeOnly || config.perChallenge),
            ),
        }))
        .filter((group) => group.entries.length > 0);
}

/**
 * Band the output of groupSchemaEntries into the ordered tiers the settings
 * modals render as headings. Same contract as groupSchemaEntries — empty tiers
 * are skipped, so a per-challenge modal that filters every group out of a tier
 * never renders its heading.
 *
 * Groups whose `tier` matches no entry in `tiers` are appended as a single
 * trailing untitled band (`{ id: null, label: null }`) rather than dropped:
 * losing a section entirely would hide settings, whereas an unlabelled band is
 * merely ugly and self-evidently wrong in review. `tiers` being null/absent —
 * an older main process that predates the `tiers` IPC field — puts every group
 * in that one band, which degrades to exactly the flat list this replaced.
 *
 * @param {Object|null} schema - serialized schema (key -> config with `group`)
 * @param {Array|null} groups - ordered [{ id, label, tier }]
 * @param {Array|null} tiers - ordered [{ id, label }]
 * @param {{ perChallengeOnly?: boolean }} [options]
 * @returns {Array<{ id: string|null, label: string|null, groups: Array }>}
 */
export function tierSchemaEntries(schema, groups, tiers, { perChallengeOnly = false } = {}) {
    const rendered = groupSchemaEntries(schema, groups, { perChallengeOnly });
    if (!rendered.length) return [];

    const order = Array.isArray(tiers) ? tiers : [];
    const known = new Set(order.map((tier) => tier.id));
    const banded = order
        .map(({ id, label }) => ({ id, label, groups: rendered.filter((group) => group.tier === id) }))
        .filter((band) => band.groups.length > 0);

    const orphans = rendered.filter((group) => !known.has(group.tier));
    return orphans.length ? [...banded, { id: null, label: null, groups: orphans }] : banded;
}
