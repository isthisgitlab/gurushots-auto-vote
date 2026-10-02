import type { SerializableSchemaEntry } from '../../ipc/settings.handlers';

/**
 * One settings group as the modals receive it (SETTINGS_GROUPS entry).
 */
export type SettingsGroupDef = { id: string; label: string; tier?: string };

/**
 * One settings tier as the modals receive it (SETTINGS_TIERS entry).
 */
export type SettingsTierDef = { id: string; label: string };

/**
 * A rendered settings section: a group and its schema entries.
 */
export type SettingsSection = {
    id: string;
    label: string;
    tier?: string;
    entries: Array<[string, SerializableSchemaEntry]>;
};

/**
 * A rendered tier band; `id`/`label` are null for the trailing untitled band.
 */
export type SettingsBand = { id: string | null; label: string | null; groups: SettingsSection[] };

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
export const SETTING_CELL_CLASS = 'flex flex-col rounded-box border border-base-300 p-3';

/**
 * Bucket schema entries into ordered UI sections for the settings modals.
 *
 * No component calls this directly — both modals go through
 * `tierSchemaEntries`, which bands this function's output under SETTINGS_TIERS.
 * It is exported as that function's building block and as the pure unit
 * under direct test, so a grep for call sites finding none is expected, not a
 * sign it is dead.
 *
 * - Sections follow the order of `groups` (the SETTINGS_GROUPS list).
 * - Within a section, entries keep schema declaration order.
 * - Empty sections are skipped (e.g. a group with only global-only settings
 *   when perChallengeOnly is set).
 * - Entries whose `group` matches no section (e.g. the internal
 *   autovoteRunning flag) are intentionally dropped.
 * - challengeOnly entries have no global value, so the global view (without
 *   perChallengeOnly) drops them; the per-challenge view keeps them.
 *
 * @param schema - serialized schema (key -> config with `group`)
 * @param groups - ordered [{ id, label }]
 */
export function groupSchemaEntries(
    schema: Record<string, SerializableSchemaEntry> | null | undefined,
    groups: readonly SettingsGroupDef[] | null | undefined,
    { perChallengeOnly = false }: { perChallengeOnly?: boolean } = {},
): SettingsSection[] {
    if (!schema || !groups) return [];
    return groups
        .map(({ id, label, tier }) => ({
            id,
            label,
            tier,
            entries: Object.entries(schema).filter(
                ([, config]) => config.group === id && (perChallengeOnly ? config.perChallenge : !config.challengeOnly),
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
 * a main process that sends no `tiers` IPC field — puts every group
 * in that one band, which degrades to a flat list.
 *
 * @param schema - serialized schema (key -> config with `group`)
 * @param groups - ordered [{ id, label, tier }]
 * @param tiers - ordered [{ id, label }]
 */
export function tierSchemaEntries(
    schema: Record<string, SerializableSchemaEntry> | null | undefined,
    groups: readonly SettingsGroupDef[] | null | undefined,
    tiers: readonly SettingsTierDef[] | null | undefined,
    { perChallengeOnly = false }: { perChallengeOnly?: boolean } = {},
): SettingsBand[] {
    const rendered = groupSchemaEntries(schema, groups, { perChallengeOnly });
    if (!rendered.length) return [];

    const order = Array.isArray(tiers) ? tiers : [];
    const known: Set<string | undefined> = new Set(order.map((tier) => tier.id));
    const banded = order
        .map(({ id, label }) => ({ id, label, groups: rendered.filter((group) => group.tier === id) }))
        .filter((band) => band.groups.length > 0);

    const orphans = rendered.filter((group) => !known.has(group.tier));
    return orphans.length ? [...banded, { id: null, label: null, groups: orphans }] : banded;
}
