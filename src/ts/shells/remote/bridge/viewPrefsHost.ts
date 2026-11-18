/**
 * The host's effective projections as the phone takes them: the complete installation settings and the presentation-only one,
 * each carried by an event with a rising `revision`. An event no newer than the last one seen is stale and dropped. The
 * phone's own theme, language and two compact choices (viewPrefsStore.ts) stay in place in what the phone's listeners hear:
 * the host's values for those four keys never reach them, whatever the host's scenario publishes. The host's own presentation
 * is kept apart, in memory, for a panel that shows what the computer paints. Loaded only by the remote renderer entries, so
 * it stays free of Node-side modules.
 */

import { isPlainObject } from '../../../core/plainObject';
import { isInteger } from '../../../core/numbers';

import type { Stored } from './viewPrefsStore';

/** What the computer paints now: the last presentation projection a host event carried. */
type HostPresentation = {
    revision: number;
    available: boolean;
    theme: string | null;
    language: string | null;
};

export type HostProjections = {
    /**
     * Takes one host event: the payload the phone's listeners get (the phone's own four preferences over the host's), or null
     * when the event is stale or is not a projection at all.
     */
    ingest: (channel: 'effective-settings-changed' | 'effective-presentation-changed', payload: unknown) => unknown;
    /** The host's own presentation (never the phone's), or null before one arrived. */
    hostPresentation: () => HostPresentation | null;
};

export const createHostProjections = (stored: Stored): HostProjections => {
    const revisions = { settings: -1, presentation: -1 };
    let host: HostPresentation | null = null;

    const settingsEvent = (payload: Record<string, unknown>): unknown => {
        if (!isPlainObject(payload.values)) return null;
        const values: Record<string, unknown> = { ...payload.values };
        const own: Record<string, { kind: 'string'; value: string } | { kind: 'boolean'; value: boolean } | undefined> =
            {
                theme: stored.theme === undefined ? undefined : { kind: 'string', value: stored.theme },
                language: stored.language === undefined ? undefined : { kind: 'string', value: stored.language },
                compactCards:
                    stored.compactCards === undefined ? undefined : { kind: 'boolean', value: stored.compactCards },
                compactCardActions:
                    stored.compactCardActions === undefined
                        ? undefined
                        : { kind: 'boolean', value: stored.compactCardActions },
            };
        for (const [key, value] of Object.entries(own)) {
            if (value !== undefined && Object.hasOwn(values, key))
                values[key] = { available: true, source: 'saved', value };
        }
        return { ...payload, values };
    };

    const presentationEvent = (payload: Record<string, unknown>, revision: number): unknown => {
        const theme = typeof payload.theme === 'string' ? payload.theme : null;
        const language = typeof payload.language === 'string' ? payload.language : null;
        host = { revision, available: payload.available === true, theme, language };
        return { ...payload, theme: stored.theme ?? theme, language: stored.language ?? language };
    };

    const ingest: HostProjections['ingest'] = (channel, payload) => {
        if (!isPlainObject(payload) || !isInteger(payload.revision) || payload.revision < 0) return null;
        const kind = channel === 'effective-settings-changed' ? 'settings' : 'presentation';
        if (payload.revision <= revisions[kind]) return null;
        const heard = kind === 'settings' ? settingsEvent(payload) : presentationEvent(payload, payload.revision);
        if (heard === null) return null;
        revisions[kind] = payload.revision;
        return heard;
    };

    return { ingest, hostPresentation: () => host };
};
