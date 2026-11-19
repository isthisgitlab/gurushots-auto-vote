import { useCallback, useEffect, useRef, useState } from 'react';
import { isInteger } from '../../core/numbers';
import { isPlainObject } from '../../core/plainObject';
import { readHostPresentation } from '../../core/remote/hostPresentation';
import { subscribeRemoteConnectionState } from '../../core/remote/connectionState';
import * as ipc from './ipc';

import type { HostPresentation } from '../../core/remote/hostPresentation';

/**
 * What applies to the installation now, as the host publishes it: the saved value, or a running scenario's published value
 * over it. A mounted client paints these and never writes them: the settings forms keep reading and saving the saved values.
 * Two projections, each fetched on mount, on window focus, on a saved setting and when a paired phone reconnects, and followed
 * through the host's event; one whose `revision` is not newer than what the client holds is ignored.
 *
 * - `useEffectivePresentation`: theme and language only (the one projection the Login and Logs windows may read).
 * - `useEffectiveSettings`: the values of the complete projection a mounted app window uses.
 *
 * A value that cannot be read keeps its last known value, with the reason beside it: the screen is not repainted from a guess.
 * A withdrawal (a Stop, a pause, a phase exit) is just the next projection, carrying the saved value again.
 */

/** The theme and language projection, with each field as last known. */
export type EffectivePresentation = {
    revision: number;
    /** Both can be read now. */
    available: boolean;
    theme: string | null;
    language: string | null;
    /** Why one cannot be read now; null when both can. */
    reason: string | null;
};

/** The installation keys a mounted window paints. */
const SETTING_KEYS = ['theme', 'language', 'customTimezones', 'compactCards', 'compactCardActions'] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

/** The complete projection as far as a window uses it, each value as last known (null: never known). */
export type EffectiveSettings = {
    revision: number;
    theme: string | null;
    language: string | null;
    customTimezones: string[] | null;
    compactCards: boolean | null;
    compactCardActions: boolean | null;
    /** Where each known value comes from now. */
    sources: Partial<Record<SettingKey, 'saved' | 'scenario'>>;
    /** Why a key cannot be read now (its value above is then the last known one). */
    unavailable: Partial<Record<SettingKey, string>>;
};

type Projection = { revision: number };

/** How one projection is read, followed and told apart from a payload that is not one. */
type Source<P extends Projection> = {
    read: () => Promise<unknown>;
    listen: (callback: (payload: unknown) => void) => (() => void) | undefined;
    parse: (raw: unknown) => P | null;
    /** What a value that cannot be read now keeps: the last one known. */
    merge: (previous: P | null, next: P) => P;
};

const entryOf = (values: Record<string, unknown>, key: SettingKey) => {
    const entry = values[key];
    return isPlainObject(entry) ? entry : null;
};

const textOf = (entry: Record<string, unknown> | null): string | null =>
    entry?.available === true && isPlainObject(entry.value) && typeof entry.value.value === 'string'
        ? entry.value.value
        : null;

const flagOf = (entry: Record<string, unknown> | null): boolean | null =>
    entry?.available === true && isPlainObject(entry.value) && typeof entry.value.value === 'boolean'
        ? entry.value.value
        : null;

const listOf = (entry: Record<string, unknown> | null): string[] | null =>
    entry?.available === true &&
    isPlainObject(entry.value) &&
    Array.isArray(entry.value.value) &&
    entry.value.value.every((item) => typeof item === 'string')
        ? (entry.value.value as string[])
        : null;

const parsePresentation = (raw: unknown): EffectivePresentation | null => {
    if (!isPlainObject(raw) || raw.success === false) return null;
    const { revision, available, theme, language, reason } = raw;
    if (!isInteger(revision) || revision < 0 || typeof available !== 'boolean') return null;
    return {
        revision,
        available,
        theme: typeof theme === 'string' ? theme : null,
        language: typeof language === 'string' ? language : null,
        reason: typeof reason === 'string' ? reason : null,
    };
};

const parseSettings = (raw: unknown): EffectiveSettings | null => {
    if (!isPlainObject(raw) || raw.success === false) return null;
    const { revision, values } = raw;
    if (!isInteger(revision) || revision < 0 || !isPlainObject(values)) return null;
    const sources: EffectiveSettings['sources'] = {};
    const unavailable: EffectiveSettings['unavailable'] = {};
    for (const key of SETTING_KEYS) {
        const entry = entryOf(values, key);
        if (entry?.available === false)
            unavailable[key] = typeof entry.reason === 'string' ? entry.reason : 'unavailable';
        if (entry?.available === true) sources[key] = entry.source === 'scenario' ? 'scenario' : 'saved';
    }
    return {
        revision,
        theme: textOf(entryOf(values, 'theme')),
        language: textOf(entryOf(values, 'language')),
        customTimezones: listOf(entryOf(values, 'customTimezones')),
        compactCards: flagOf(entryOf(values, 'compactCards')),
        compactCardActions: flagOf(entryOf(values, 'compactCardActions')),
        sources,
        unavailable,
    };
};

const PRESENTATION_SOURCE: Source<EffectivePresentation> = {
    read: () => ipc.getEffectivePresentation(),
    listen: (callback) => ipc.onEffectivePresentationChanged(callback),
    parse: parsePresentation,
    merge: (previous, next) => ({
        ...next,
        theme: next.theme ?? previous?.theme ?? null,
        language: next.language ?? previous?.language ?? null,
    }),
};

const SETTINGS_SOURCE: Source<EffectiveSettings> = {
    read: () => ipc.getEffectiveInstallationSettings(),
    listen: (callback) => ipc.onEffectiveSettingsChanged(callback),
    parse: parseSettings,
    merge: (previous, next) =>
        previous === null
            ? next
            : {
                  ...next,
                  theme: next.theme ?? previous.theme,
                  language: next.language ?? previous.language,
                  customTimezones: next.customTimezones ?? previous.customTimezones,
                  compactCards: next.compactCards ?? previous.compactCards,
                  compactCardActions: next.compactCardActions ?? previous.compactCardActions,
              },
};

type Held<P> = {
    projection: P | null;
    /** The first read has finished, whatever it found. */
    settled: boolean;
    /** Counts every projection taken (an event or a read), so a client repaints on a read that changed nothing it holds. */
    applied: number;
};

/**
 * One projection, kept current. An event is taken only when its revision is newer than what is held. A read taken after
 * something the client itself changed (a save) may answer the same revision with new values, so it applies when at least as
 * new; a read that only catches up (the mount, a focus, a reconnect) applies a strictly newer revision only — an unchanged
 * one repaints nothing, and never over a theme previewed in a form that was not saved.
 */
function useProjection<P extends Projection>(source: Source<P>) {
    const [held, setHeld] = useState<Held<P>>({ projection: null, settled: false, applied: 0 });
    const latest = useRef(-1);
    const readNow = useRef<() => Promise<void>>(
        /* istanbul ignore next -- a refresh is exposed only after mount, and the effect installs the real read on mount, so this placeholder never runs; it only satisfies the type */
        () => Promise.resolve(),
    );

    useEffect(() => {
        let live = true;
        const take = (raw: unknown, kind: 'event' | 'refresh' | 'catch-up'): void => {
            const next = source.parse(raw);
            if (!live || next === null) return;
            const applies = kind === 'refresh' ? next.revision >= latest.current : next.revision > latest.current;
            if (!applies) return;
            latest.current = next.revision;
            setHeld((prev) => ({
                projection: source.merge(prev.projection, next),
                settled: true,
                applied: prev.applied + 1,
            }));
        };
        const read = async (kind: 'refresh' | 'catch-up'): Promise<void> => {
            // A read that failed leaves what is held as it is: a client is never repainted from a guess.
            const raw = await ipc.callOrNull(source.read);
            if (!live) return;
            take(raw, kind);
            setHeld((prev) => (prev.settled ? prev : { ...prev, settled: true }));
        };
        readNow.current = () => read('refresh');
        void read('catch-up');
        const off = source.listen((payload) => take(payload, 'event'));
        const offSettings = ipc.onSettingsChanged(() => void read('refresh'));
        const onFocus = () => void read('catch-up');
        window.addEventListener('focus', onFocus);
        const offConnection = subscribeRemoteConnectionState((state) => {
            if (state === 'connected') void read('catch-up');
        });
        return () => {
            live = false;
            off?.();
            offSettings?.();
            window.removeEventListener('focus', onFocus);
            offConnection();
        };
    }, [source]);

    const refresh = useCallback(() => readNow.current(), []);
    return { ...held, refresh };
}

/**
 * The effective theme and language. `host` is what the computer paints (on a paired phone, which paints its own choices; null
 * everywhere else): for a panel that inspects the host, never for painting.
 */
export function useEffectivePresentation(): {
    presentation: EffectivePresentation | null;
    settled: boolean;
    applied: number;
    refresh: () => Promise<void>;
    host: HostPresentation | null;
} {
    const { projection, settled, applied, refresh } = useProjection(PRESENTATION_SOURCE);
    return { presentation: projection, settled, applied, refresh, host: readHostPresentation() };
}

/** The effective values a mounted app window paints, with the reason for any it cannot read. */
export function useEffectiveSettings(): {
    settings: EffectiveSettings | null;
    settled: boolean;
    applied: number;
    refresh: () => Promise<void>;
} {
    const { projection, settled, applied, refresh } = useProjection(SETTINGS_SOURCE);
    return { settings: projection, settled, applied, refresh };
}
