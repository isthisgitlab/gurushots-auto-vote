/**
 * Manual Only (stored as `manualPhotosOnly`): the per-challenge switch that stops the app doing anything on
 * a challenge by itself: no join or photo entry, swap, vote, boost, Turbo, key unlock, fill or scenario step.
 * The card's own buttons keep working. Dependency-free (types only) so the voting pass, fill paths, decisions,
 * currency automation, scheduler resolvers and scenario runner can all gate on it without an import cycle. The settings source is
 * a parameter: the fill paths pass their injected `deps.settings`, everything else the facade.
 */

import type * as SettingsModule from '../settings';

type ManualPhotosSource = Pick<typeof SettingsModule, 'getEffectiveSetting'>;

/** Whether the app may not run anything on this challenge on its own. */
const isManualPhotosOnly = (settings: ManualPhotosSource, challengeId: string | number | null | undefined): boolean =>
    challengeId !== undefined &&
    challengeId !== null &&
    settings.getEffectiveSetting('manualPhotosOnly', String(challengeId)) === true;

export { isManualPhotosOnly };
