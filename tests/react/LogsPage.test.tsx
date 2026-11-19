/**
 * Logs window page (pages/Logs.tsx) — shows a loader until translations are
 * ready, then the navbar (connection status from useLogStream) and the log
 * list. It mounts itself into #root at module load when that element exists.
 */
import { act, render, screen, waitFor } from '@testing-library/preact';
import { fireSettingsChanged, mockApi } from './helpers/setup';
import { installEffectiveBus, presentationOf } from './helpers/effective';

describe('Logs page', () => {
    let originalBacklog: typeof window.api.getLogBacklog;

    beforeEach(() => {
        originalBacklog = window.api.getLogBacklog;
        window.api.getLogBacklog = jest
            .fn()
            .mockResolvedValue([{ seq: 1, timestamp: 'T', level: 'INFO', message: 'hello log' }]);
    });

    afterEach(() => {
        window.api.getLogBacklog = originalBacklog;
        document.body.innerHTML = '';
    });

    test('loader, then the connected navbar and the backlog', async () => {
        const { default: LogsPage } = await import('@/pages/Logs');
        // Imported without #root: nothing auto-mounted.
        expect(document.body.textContent).toBe('');

        render(<LogsPage />);
        expect(screen.getByText('common.loading')).toBeTruthy();
        await waitFor(() => expect(screen.getByText('Hello log')).toBeTruthy());
        expect(screen.getByText('logs.title')).toBeTruthy();
        expect(screen.getByText('logs.connected')).toBeTruthy();
    });

    describe('theme', () => {
        afterEach(() => {
            document.documentElement.removeAttribute('data-theme');
            mockApi.getSetting.mockResolvedValue(null);
        });

        test('reads the theme on load and follows a live change of it', async () => {
            mockApi.getSetting.mockImplementation(async (key) => (key === 'theme' ? 'dark' : null));
            const { default: LogsPage } = await import('@/pages/Logs');
            render(<LogsPage />);
            await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
            expect(mockApi.getSetting).toHaveBeenCalledWith('theme');

            act(() => fireSettingsChanged({ app: { language: 'en', theme: 'lemonade' } }));
            expect(document.documentElement.getAttribute('data-theme')).toBe('lemonade');

            // A change without a theme (or a payload of another shape) leaves it alone.
            act(() => fireSettingsChanged({ app: { language: 'lv' } }));
            act(() => fireSettingsChanged({ app: 'not an object' }));
            act(() => fireSettingsChanged());
            expect(document.documentElement.getAttribute('data-theme')).toBe('lemonade');
        });

        test('keeps the page theme when the theme is not a string, and stops listening on unmount', async () => {
            const { default: LogsPage } = await import('@/pages/Logs');
            const { unmount } = render(<LogsPage />);
            await waitFor(() => expect(screen.getByText('Hello log')).toBeTruthy());
            expect(document.documentElement.getAttribute('data-theme')).toBeNull();
            unmount();
            fireSettingsChanged({ app: { theme: 'dark' } });
            expect(document.documentElement.getAttribute('data-theme')).toBeNull();
        });
    });

    test('auto-mounts into #root at module load', async () => {
        const root = document.createElement('div');
        root.id = 'root';
        document.body.appendChild(root);
        jest.isolateModules(() => {
            require('@/pages/Logs');
        });
        await waitFor(() => expect(root.textContent).toContain('Hello log'));
    });

    describe('the effective presentation', () => {
        let bus: ReturnType<typeof installEffectiveBus>;
        beforeEach(() => {
            bus = installEffectiveBus();
        });
        afterEach(() => {
            document.documentElement.removeAttribute('data-theme');
            mockApi.getSetting.mockResolvedValue(null);
        });

        test('paints the effective theme over the saved one, follows a newer projection and ignores a stale one', async () => {
            mockApi.getSetting.mockImplementation(async (key) => (key === 'theme' ? 'light' : null));
            bus.answer({ presentation: { success: true, ...presentationOf(5, { theme: 'dark' }) } });
            const { default: LogsPage } = await import('@/pages/Logs');
            render(<LogsPage />);
            await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
            act(() => bus.firePresentation(presentationOf(6, { theme: 'cupcake' })));
            expect(document.documentElement.getAttribute('data-theme')).toBe('cupcake');
            act(() => bus.firePresentation(presentationOf(6, { theme: 'stale' })));
            expect(document.documentElement.getAttribute('data-theme')).toBe('cupcake');
            // The window reads the presentation projection only, never the complete one.
            expect(mockApi.getEffectiveInstallationSettings).not.toHaveBeenCalled();
            expect(mockApi.onEffectiveSettingsChanged).not.toHaveBeenCalled();
        });

        test('restores the saved theme when the host withdraws, without a write', async () => {
            bus.answer({ presentation: { success: true, ...presentationOf(5, { theme: 'dark' }) } });
            const { default: LogsPage } = await import('@/pages/Logs');
            render(<LogsPage />);
            await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
            act(() => bus.firePresentation(presentationOf(6, { theme: 'light' })));
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
            expect(mockApi.setSetting).not.toHaveBeenCalled();
        });

        test('warns with the reason and keeps the theme when it cannot be read', async () => {
            bus.answer({ presentation: { success: true, ...presentationOf(5, { theme: 'dark' }) } });
            const { default: LogsPage } = await import('@/pages/Logs');
            render(<LogsPage />);
            await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
            act(() =>
                bus.firePresentation(presentationOf(6, { available: false, theme: null, reason: 'unavailable' })),
            );
            expect(screen.getByText('app.effectiveUnavailableTitle')).toBeTruthy();
            expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
            // A present reason is shown; an absent one is still an unreadable value.
            act(() => bus.firePresentation(presentationOf(7, { available: false, reason: null })));
            expect(screen.getByText('app.effectiveUnavailableReason')).toBeTruthy();
        });
    });
});
