import type { ChallengeValues } from './types/settings';

const EXPOSURE_KEYS = ['exposure', 'finalWindowExposure', 'exposureTarget', 'finalWindowExposureTarget'] as const;
type ExposureKey = (typeof EXPOSURE_KEYS)[number];

const isExposureKey = (key: string): key is ExposureKey => EXPOSURE_KEYS.some((exposureKey) => exposureKey === key);

const exposureDefaultsFrom = (read: (key: ExposureKey | 'useFinalWindowExposure') => unknown): ChallengeValues =>
    Object.fromEntries([...EXPOSURE_KEYS, 'useFinalWindowExposure' as const].map((key) => [key, read(key)]));

// Include transitive limits: final-window exposure cannot exceed the normal target, through normal exposure.
const limits: Record<ExposureKey, { min: readonly ExposureKey[]; max: readonly ExposureKey[] }> = {
    exposure: { min: ['finalWindowExposure'], max: ['exposureTarget'] },
    finalWindowExposure: { min: [], max: ['exposure', 'exposureTarget', 'finalWindowExposureTarget'] },
    exposureTarget: { min: ['exposure', 'finalWindowExposure'], max: [] },
    finalWindowExposureTarget: { min: ['finalWindowExposure'], max: [] },
};

const constrainExposure = (
    key: ExposureKey,
    value: number,
    chosen: Partial<Record<ExposureKey, number>>,
    finalWindow: boolean,
): number => {
    if (value === 0 || (!finalWindow && key.startsWith('finalWindow'))) return value;
    let adjusted = value;
    for (const earlier of limits[key].min) {
        if (!finalWindow && earlier === 'finalWindowExposure') continue;
        adjusted = Math.max(adjusted, chosen[earlier] ?? value);
    }
    for (const earlier of limits[key].max) {
        const ceiling = chosen[earlier];
        if (ceiling !== undefined && ceiling !== 0) adjusted = Math.min(adjusted, ceiling);
    }
    return adjusted;
};

/**
 * Resolve linked values from highest to lowest priority. The field order breaks ties within a layer.
 * Each value is constrained by the earlier values, so a subsequent change cannot undo a higher priority choice.
 * A target of zero follows its trigger and contributes no limit of its own.
 */
const resolveLinkedExposure = (layers: readonly ChallengeValues[]): Partial<Record<ExposureKey, number>> => {
    const values: Partial<Record<ExposureKey, number>> = {};
    const finalWindow =
        layers.find((layer) => Object.hasOwn(layer, 'useFinalWindowExposure'))?.useFinalWindowExposure === true;
    for (const layer of layers) {
        for (const key of EXPOSURE_KEYS) {
            const value = layer[key];
            if (Object.hasOwn(values, key) || typeof value !== 'number') continue;
            values[key] = constrainExposure(key, value, values, finalWindow);
        }
    }
    return values;
};

/** An editor commit gives the edited field priority within its own layer. */
const editLinkedExposure = (
    draft: ChallengeValues,
    key: ExposureKey,
    value: unknown,
    inherited: readonly ChallengeValues[],
): ChallengeValues => {
    const next = { ...draft, [key]: value };
    const resolved = resolveLinkedExposure([{ [key]: value }, next, ...inherited]);
    for (const related of EXPOSURE_KEYS) {
        if (typeof next[related] === 'number') next[related] = resolved[related];
    }
    return next;
};

export { EXPOSURE_KEYS, isExposureKey, exposureDefaultsFrom, resolveLinkedExposure, editLinkedExposure };
