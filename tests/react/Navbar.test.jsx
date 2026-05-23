/**
 * Navbar — the in-app Logs button is Capacitor-gated: shown only on a native
 * (Android) platform, since Electron opens the Logs window from its menu. The
 * test mock's t() returns the key, so the button's title is 'logs.title'.
 */
import { fireEvent, render, screen } from '@/test/test-utils';
import { Navbar } from '@/components/layout/Navbar';

describe('Navbar', () => {
    afterEach(() => {
        delete globalThis.Capacitor;
    });

    test('hides the Logs button off Capacitor', () => {
        render(<Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />);
        expect(screen.queryByTitle('logs.title')).toBeNull();
        // Settings + logout are always present.
        expect(screen.getByTitle('app.settings')).toBeTruthy();
    });

    test('shows the Logs button on Capacitor and calls onLogsClick', () => {
        globalThis.Capacitor = { isNativePlatform: () => true };
        const onLogsClick = jest.fn();
        render(<Navbar isMock={false} onLogsClick={onLogsClick} onSettingsClick={() => {}} onLogout={() => {}} />);
        const logsBtn = screen.getByTitle('logs.title');
        expect(logsBtn).toBeTruthy();
        fireEvent.click(logsBtn);
        expect(onLogsClick).toHaveBeenCalledTimes(1);
    });
});
