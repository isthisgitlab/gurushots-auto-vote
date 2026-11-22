/**
 * The host's effective projections as a test drives them: a bus for the two events, and builders for what the two read channels
 * answer (get-effective-presentation, get-effective-installation-settings).
 */
import { mockApi } from './setup';

type Listener = (payload: unknown) => void;

export type Wire =
    | { available: true; source: 'saved' | 'scenario'; value: unknown }
    | { available: false; reason: string };

/** A known string value of the projection. */
export const text = (value: string, source: 'saved' | 'scenario' = 'saved'): Wire => ({
    available: true,
    source,
    value: { kind: 'string', value },
});
export const flag = (value: boolean, source: 'saved' | 'scenario' = 'saved'): Wire => ({
    available: true,
    source,
    value: { kind: 'boolean', value },
});
export const list = (value: string[], source: 'saved' | 'scenario' = 'saved'): Wire => ({
    available: true,
    source,
    value: { kind: 'list', value },
});
export const gone = (reason: string): Wire => ({ available: false, reason });

export const presentationOf = (
    revision: number,
    over: Partial<{ available: boolean; theme: string | null; language: string | null; reason: string | null }> = {},
) => ({ revision, available: true, theme: 'light', language: 'en', reason: null, ...over });

export const settingsOf = (revision: number, values: Record<string, Wire>) => ({
    revision,
    subject: 'installation' as const,
    generation: 1,
    values,
});

/**
 * Wires the mocked window.api: the two events register their listeners on the bus, and the two reads answer what the test
 * last set with `answer`. Call it in a beforeEach (the shared setup resets every mock before each test).
 */
export const installEffectiveBus = () => {
    const presentation = new Set<Listener>();
    const settings = new Set<Listener>();
    const answers: { presentation: unknown; settings: unknown } = { presentation: undefined, settings: undefined };
    const unsubscribed: string[] = [];
    mockApi.onEffectivePresentationChanged = jest.fn((callback) => {
        presentation.add(callback as Listener);
        return () => {
            unsubscribed.push('presentation');
            presentation.delete(callback as Listener);
        };
    });
    mockApi.onEffectiveSettingsChanged = jest.fn((callback) => {
        settings.add(callback as Listener);
        return () => {
            unsubscribed.push('settings');
            settings.delete(callback as Listener);
        };
    });
    mockApi.getEffectivePresentation.mockImplementation(async () => answers.presentation as never);
    mockApi.getEffectiveInstallationSettings.mockImplementation(async () => answers.settings as never);
    return {
        /** What the next read answers (null: the call throws). */
        answer: (next: { presentation?: unknown; settings?: unknown }) => {
            if ('presentation' in next) answers.presentation = next.presentation;
            if ('settings' in next) answers.settings = next.settings;
        },
        firePresentation: (payload: unknown) => {
            for (const listener of [...presentation]) listener(payload);
        },
        fireSettings: (payload: unknown) => {
            for (const listener of [...settings]) listener(payload);
        },
        listeners: () => ({ presentation: presentation.size, settings: settings.size }),
        unsubscribed,
    };
};
