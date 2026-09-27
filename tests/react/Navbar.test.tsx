/**
 * Navbar — the in-app Logs button is Capacitor-gated: shown only on a native
 * (Android) platform, since Electron opens the Logs window from its menu. The
 * test mock's t() returns the key, so the button's title is 'logs.title'.
 */
import { fireEvent, render, screen } from './helpers/test-utils';
import type { RendererGlobals } from '../../src/js/types/capacitor';
import { Navbar } from '@/components/layout/Navbar';

const g = globalThis as RendererGlobals;

describe('Navbar', () => {
    afterEach(() => {
        delete g.Capacitor;
    });

    test('hides the Logs button off Capacitor', () => {
        render(<Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />);
        expect(screen.queryByTitle('logs.title')).toBeNull();
        // Settings + logout are always present.
        expect(screen.getByTitle('app.settings')).toBeTruthy();
    });

    test('shows the Logs button on Capacitor and calls onLogsClick', () => {
        g.Capacitor = { isNativePlatform: () => true };
        const onLogsClick = jest.fn();
        render(<Navbar isMock={false} onLogsClick={onLogsClick} onSettingsClick={() => {}} onLogout={() => {}} />);
        const logsBtn = screen.getByTitle('logs.title');
        expect(logsBtn).toBeTruthy();
        fireEvent.click(logsBtn);
        expect(onLogsClick).toHaveBeenCalledTimes(1);
    });

    test('the icon-only buttons carry accessible names', () => {
        g.Capacitor = { isNativePlatform: () => true };
        render(<Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />);
        for (const name of ['logs.title', 'app.settings', 'app.logout']) {
            expect(screen.getByRole('button', { name })).toBeTruthy();
        }
    });
});
