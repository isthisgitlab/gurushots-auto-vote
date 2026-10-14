/**
 * Manual Photos Only: the per-challenge switch that stops the app entering a photo by itself.
 * Dependency-free (types only) so the fill paths, decisions, currency automation, scheduler
 * resolvers and scenario runner can all gate on it without an import cycle. The settings source is
 * a parameter: the fill paths pass their injected `deps.settings`, everything else the facade.
 */

import type * as SettingsModule from '../settings';

type ManualPhotosSource = Pick<typeof SettingsModule, 'getEffectiveSetting'>;

/** Whether the app may not join, submit or swap a photo in this challenge on its own. */
const isManualPhotosOnly = (settings: ManualPhotosSource, challengeId: string | number | null | undefined): boolean =>
    challengeId !== undefined &&
    challengeId !== null &&
    settings.getEffectiveSetting('manualPhotosOnly', String(challengeId)) === true;

export { isManualPhotosOnly };
