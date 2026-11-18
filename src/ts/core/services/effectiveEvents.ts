/**
 * The effective projections of the installation's settings and the events that announce them.
 *
 * What applies to the installation now is the saved value with the installation scenario's published phase over it
 * (settings facade `readInstallationSetting`). Two projections are made of it and never carry anything but values: the
 * complete one (`get-effective-installation-settings`, `effective-settings-changed`: every installation-owned key with its
 * source and availability, the generation, a revision) and the presentation-only one (`get-effective-presentation`,
 * `effective-presentation-changed`: theme, language, availability, a revision), which is all the Login and Logs windows may
 * know. No token, header or pairing key is in either: only keys the capability catalogue lets an installation phase write.
 *
 * `revision` rises by one whenever either projection changes, so a client ignores an event older than what it holds. It starts
 * from the clock when the host starts, so a client that held a revision of an earlier run still finds a newer one. A change is
 * announced when something that can change the projection happened (a publication, a withdrawal, a pause, a clear, a Stop,
 * a saved setting): `announceEffectiveChange` works out the projections again, and says only what differs from the last one told.
 * A read that finds a change nobody announced says it too, so no window stays behind.
 */

import * as settings from '../settings';
import * as logger from '../logger';
import { platform } from '../platform/port';

import type { EffectiveEventChannel } from '../platform/port';
import type { ExprValue } from '../scenarios/expressions';

/** One installation setting as it applies now: its value and where it comes from, or why it cannot be read. */
export type EffectiveValue =
    | { available: true; source: 'saved' | 'scenario'; value: ExprValue }
    | { available: false; reason: string };

/** The complete projection (the `effective-settings-changed` payload). */
export type EffectiveSettings = {
    revision: number;
    subject: 'installation';
    /** The installation assignment's generation (null: it cannot be read). */
    generation: number | null;
    values: Record<string, EffectiveValue>;
};

/** The presentation-only projection (the `effective-presentation-changed` payload). */
export type EffectivePresentation = {
    revision: number;
    /** Both theme and language can be read. */
    available: boolean;
    theme: string | null;
    language: string | null;
    /** Why one cannot be read; null when both can. */
    reason: string | null;
};

type Projections = { settings: EffectiveSettings; presentation: EffectivePresentation };

const log = () => logger.withCategory('scenario');

let revision = Date.now();
let lastSettings: string | null = null;
let lastPresentation: string | null = null;

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The installation-owned values as they apply now. */
const readValues = (): Record<string, EffectiveValue> => {
    const base = settings.getScenarioBaseSettings(null);
    const values: Record<string, EffectiveValue> = {};
    for (const row of settings.getScenarioCapabilities().settings) {
        if (row.read !== 'value' || !row.phaseWrite.includes('installation')) continue;
        const effective = settings.readInstallationSetting(row.key);
        if (effective.state !== 'known') {
            values[row.key] = { available: false, reason: effective.reason };
            continue;
        }
        const saved = base[row.key];
        values[row.key] = {
            available: true,
            source: saved?.state === 'known' && sameValue(saved.value, effective.value) ? 'saved' : 'scenario',
            value: effective.value,
        };
    }
    return values;
};

/** One presentation key as a string, or why it cannot be had. */
const presentationOf = (values: Record<string, EffectiveValue>, key: 'theme' | 'language') => {
    const found = values[key];
    if (found?.available === true && found.value.kind === 'string') return { value: found.value.value, reason: null };
    return { value: null, reason: found?.available === false ? found.reason : `${key}-unavailable` };
};

const presentationFrom = (values: Record<string, EffectiveValue>) => {
    const theme = presentationOf(values, 'theme');
    const language = presentationOf(values, 'language');
    return {
        available: theme.value !== null && language.value !== null,
        theme: theme.value,
        language: language.value,
        reason: theme.reason ?? language.reason,
    };
};

const emit = (channel: EffectiveEventChannel, payload: unknown) => {
    try {
        platform().windows.broadcastEvent(channel, payload);
    } catch (error) {
        // A window closing mid-event must not fail what changed the projection.
        log().warning(
            `The ${channel} event could not be sent: ${error instanceof Error ? error.message : 'unknown'}`,
            null,
        );
    }
};

/**
 * The projections as they apply now. A change since the last one told raises the revision and is told to the windows
 * (each projection only when it differs).
 */
const refresh = (): Projections => {
    const values = readValues();
    const generation = settings.installationGeneration();
    const presentation = presentationFrom(values);
    const settingsKey = JSON.stringify({ generation, values });
    const presentationKey = JSON.stringify(presentation);
    const settingsChanged = settingsKey !== lastSettings;
    const presentationChanged = presentationKey !== lastPresentation;
    if (settingsChanged || presentationChanged) revision += 1;
    lastSettings = settingsKey;
    lastPresentation = presentationKey;
    const projections: Projections = {
        settings: { revision, subject: 'installation', generation, values },
        presentation: { revision, ...presentation },
    };
    if (settingsChanged) emit('effective-settings-changed', projections.settings);
    if (presentationChanged) emit('effective-presentation-changed', projections.presentation);
    return projections;
};

/** The current projections, for a client that mounted or missed an event. May throw: the caller answers a failure. */
const readEffective = (): Projections => refresh();

/**
 * Says what changed after something that can change the projections happened. Never throws: what happened has landed, and a
 * projection that cannot be worked out now is worked out at the next read.
 */
const announceEffectiveChange = (): void => {
    try {
        refresh();
    } catch (error) {
        log().warning(
            `The effective settings could not be worked out: ${error instanceof Error ? error.message : 'unknown'}`,
            null,
        );
    }
};

export { readEffective, announceEffectiveChange };
