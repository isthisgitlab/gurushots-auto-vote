/**
 * The effective projections a mounted window follows (api/useEffectiveSettings.ts): read on mount, on focus, on a saved
 * setting and when a paired phone reconnects; followed through the host's events; an event that is not newer is ignored; a value
 * that cannot be read keeps its last known one with the reason beside it.
 */
import { act, render, waitFor } from '@testing-library/preact';
import { useEffectivePresentation, useEffectiveSettings } from '@/api/useEffectiveSettings';
import { setRemoteConnectionState } from '../../src/ts/core/remote/connectionState';
import { setHostPresentationSource } from '../../src/ts/core/remote/hostPresentation';
import { fireSettingsChanged, mockApi } from './helpers/setup';
import { flag, gone, installEffectiveBus, list, presentationOf, settingsOf, text } from './helpers/effective';

describe('useEffectivePresentation', () => {
    let bus: ReturnType<typeof installEffectiveBus>;
    let held: ReturnType<typeof useEffectivePresentation>;
    function Probe() {
        held = useEffectivePresentation();
        return null;
    }

    beforeEach(() => {
        bus = installEffectiveBus();
        bus.answer({ presentation: { success: true, ...presentationOf(10, { theme: 'dark', language: 'lv' }) } });
    });
    afterEach(() => setHostPresentationSource(null));

    it('reads the projection on mount and is settled once it has', async () => {
        render(<Probe />);
        expect(held.settled).toBe(false);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(held.presentation).toEqual({
            revision: 10,
            available: true,
            theme: 'dark',
            language: 'lv',
            reason: null,
        });
    });

    it('is settled even when the host answers nothing it can use', async () => {
        bus.answer({ presentation: { success: false, error: 'x' } });
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(held.presentation).toBeNull();
    });

    it('a first projection that carries no theme or language holds nulls for both', async () => {
        bus.answer({ presentation: { success: true, ...presentationOf(3, { theme: null, language: null }) } });
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(held.presentation).toEqual({ revision: 3, available: true, theme: null, language: null, reason: null });
    });

    it('is settled when the read throws', async () => {
        mockApi.getEffectivePresentation.mockRejectedValue(new Error('down'));
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(held.presentation).toBeNull();
    });

    it('follows a newer event and ignores one that is not newer (the same or an older revision)', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        act(() => bus.firePresentation(presentationOf(11, { theme: 'cupcake' })));
        expect(held.presentation?.theme).toBe('cupcake');
        act(() => bus.firePresentation(presentationOf(11, { theme: 'stale-same' })));
        act(() => bus.firePresentation(presentationOf(9, { theme: 'stale-older' })));
        expect(held.presentation?.theme).toBe('cupcake');
    });

    it('ignores a payload that is not a projection', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        for (const bad of [null, 'x', { revision: 'a' }, { revision: -1, available: true }, { revision: 12 }]) {
            act(() => bus.firePresentation(bad));
        }
        expect(held.presentation?.revision).toBe(10);
    });

    it('keeps the last known theme and language when one cannot be read, with the reason', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        act(() =>
            bus.firePresentation(
                presentationOf(11, { available: false, theme: null, language: 'en', reason: 'theme-unavailable' }),
            ),
        );
        expect(held.presentation).toEqual({
            revision: 11,
            available: false,
            theme: 'dark',
            language: 'en',
            reason: 'theme-unavailable',
        });
    });

    it('a known withdrawal is just the next projection, carrying the saved values again', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        act(() => bus.firePresentation(presentationOf(11, { theme: 'light', language: 'en' })));
        expect(held.presentation).toMatchObject({ theme: 'light', language: 'en', available: true });
        expect(mockApi.setSetting).not.toHaveBeenCalled();
        expect(mockApi.setGlobalDefault).not.toHaveBeenCalled();
    });

    it('reads again on window focus, on a saved setting and when a phone reconnects', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(mockApi.getEffectivePresentation).toHaveBeenCalledTimes(1);

        bus.answer({ presentation: { success: true, ...presentationOf(12, { theme: 'after-focus' }) } });
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });
        await waitFor(() => expect(held.presentation?.theme).toBe('after-focus'));

        bus.answer({ presentation: { success: true, ...presentationOf(13, { theme: 'after-save' }) } });
        await act(async () => fireSettingsChanged({ app: {} }));
        await waitFor(() => expect(held.presentation?.theme).toBe('after-save'));

        bus.answer({ presentation: { success: true, ...presentationOf(14, { theme: 'after-reconnect' }) } });
        await act(async () => setRemoteConnectionState('connected'));
        await waitFor(() => expect(held.presentation?.theme).toBe('after-reconnect'));
        act(() => setRemoteConnectionState('offline'));
        expect(mockApi.getEffectivePresentation).toHaveBeenCalledTimes(4);
    });

    it('a read made after a newer event cannot lower what is held, but a read at the same revision is taken', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        act(() => bus.firePresentation(presentationOf(20, { theme: 'newer' })));
        bus.answer({ presentation: { success: true, ...presentationOf(10, { theme: 'old-read' }) } });
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });
        await act(async () => {
            await held.refresh();
        });
        expect(held.presentation?.theme).toBe('newer');
        const before = held.applied;
        bus.answer({ presentation: { success: true, ...presentationOf(20, { theme: 'newer' }) } });
        await act(async () => {
            await held.refresh();
        });
        expect(held.applied).toBeGreaterThan(before);
    });

    it('a focus read with an unchanged revision repaints nothing, so it cannot stomp an unsaved local preview', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        // The same revision the client holds — even answering different values: a catch-up read applies nothing.
        bus.answer({ presentation: { success: true, ...presentationOf(10, { theme: 'preview-killer' }) } });
        const appliedBefore = held.applied;
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });
        await waitFor(() => expect(mockApi.getEffectivePresentation).toHaveBeenCalledTimes(2));
        expect(held.applied).toBe(appliedBefore);
        expect(held.presentation?.theme).toBe('dark');
        // A newer revision through the same focus read does apply.
        bus.answer({ presentation: { success: true, ...presentationOf(11, { theme: 'published' }) } });
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });
        await waitFor(() => expect(held.presentation?.theme).toBe('published'));
    });

    it('unsubscribes everything when it unmounts and takes nothing afterwards', async () => {
        const view = render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        act(() => view.unmount());
        expect(bus.listeners().presentation).toBe(0);
        expect(bus.unsubscribed).toContain('presentation');
        const calls = mockApi.getEffectivePresentation.mock.calls.length;
        window.dispatchEvent(new Event('focus'));
        expect(mockApi.getEffectivePresentation).toHaveBeenCalledTimes(calls);
    });

    it('a read that settles after unmount applies nothing', async () => {
        let release!: (value: unknown) => void;
        mockApi.getEffectivePresentation.mockReturnValue(new Promise((resolve) => (release = resolve)) as never);
        const view = render(<Probe />);
        act(() => view.unmount());
        await act(async () => release({ success: true, ...presentationOf(30) }));
        expect(held.presentation).toBeNull();
    });

    it('exposes what the computer paints, from the phone bridge, and null where there is none', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(held.host).toBeNull();
        setHostPresentationSource(() => ({ revision: 3, available: true, theme: 'host', language: 'lv' }));
        act(() => bus.firePresentation(presentationOf(11)));
        expect(held.host).toEqual({ revision: 3, available: true, theme: 'host', language: 'lv' });
    });

    it('works on a host without the event method', async () => {
        mockApi.onEffectivePresentationChanged = undefined as never;
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(held.presentation?.theme).toBe('dark');
    });
});

describe('useEffectiveSettings', () => {
    let bus: ReturnType<typeof installEffectiveBus>;
    let held: ReturnType<typeof useEffectiveSettings>;
    function Probe() {
        held = useEffectiveSettings();
        return null;
    }
    const full = (revision: number, over: Record<string, ReturnType<typeof text>> = {}) =>
        settingsOf(revision, {
            theme: text('dark'),
            language: text('lv'),
            customTimezones: list(['Asia/Tokyo']),
            compactCards: flag(true, 'scenario'),
            compactCardActions: flag(false),
            ...over,
        });

    beforeEach(() => {
        bus = installEffectiveBus();
        bus.answer({ settings: { success: true, ...full(5) } });
    });

    it('derives the painted values and where each comes from', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(held.settings).toEqual({
            revision: 5,
            theme: 'dark',
            language: 'lv',
            customTimezones: ['Asia/Tokyo'],
            compactCards: true,
            compactCardActions: false,
            sources: {
                theme: 'saved',
                language: 'saved',
                customTimezones: 'saved',
                compactCards: 'scenario',
                compactCardActions: 'saved',
            },
            unavailable: {},
        });
    });

    it('an unreadable key keeps its last known value and names its reason; a later read clears it', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        act(() =>
            bus.fireSettings(
                settingsOf(6, {
                    theme: gone('expired'),
                    language: text('en'),
                    customTimezones: gone('x') as never,
                    compactCards: { available: false } as never,
                }),
            ),
        );
        expect(held.settings).toMatchObject({
            revision: 6,
            theme: 'dark',
            language: 'en',
            customTimezones: ['Asia/Tokyo'],
            compactCards: true,
            compactCardActions: false,
            unavailable: { theme: 'expired', customTimezones: 'x', compactCards: 'unavailable' },
        });
        act(() => bus.fireSettings(full(7)));
        expect(held.settings?.unavailable).toEqual({});
    });

    it('ignores a stale event and a payload that is not a projection, and a value of the wrong kind reads as unknown', async () => {
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        act(() => bus.fireSettings(full(5)));
        act(() => bus.fireSettings({ revision: 9, values: 'nope' }));
        act(() => bus.fireSettings(null));
        expect(held.settings?.revision).toBe(5);
        act(() =>
            bus.fireSettings(
                settingsOf(8, {
                    theme: flag(true),
                    language: { available: true, source: 'saved', value: null } as never,
                    customTimezones: { available: true, source: 'saved', value: { kind: 'list', value: [1] } } as never,
                    compactCards: text('x'),
                }),
            ),
        );
        // None is readable as its own kind, so each keeps what was known.
        expect(held.settings).toMatchObject({
            theme: 'dark',
            language: 'lv',
            customTimezones: ['Asia/Tokyo'],
            compactCards: true,
        });
    });

    it('starts from nothing known: a key the host leaves out is null with no reason', async () => {
        bus.answer({ settings: { success: true, ...settingsOf(1, { theme: text('light') }) } });
        render(<Probe />);
        await waitFor(() => expect(held.settled).toBe(true));
        expect(held.settings).toMatchObject({
            theme: 'light',
            language: null,
            customTimezones: null,
            compactCards: null,
        });
        expect(held.settings?.unavailable).toEqual({});
        expect(held.settings?.sources).toEqual({ theme: 'saved' });
    });
});
