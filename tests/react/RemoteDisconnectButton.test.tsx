/**
 * The Android remote mode's Disconnect: rendered by the Navbar and by the loader's notice screen
 * only while the bundled remote page installed it; a leave that fails says so. The test mock's
 * t() returns the key.
 */

import { act, screen } from '@testing-library/preact';
import { fireEvent, render } from './helpers/test-utils';
import { RemoteDisconnectButton } from '@/components/app/RemoteDisconnectButton';
import { RemoteNoticeScreen } from '@/components/app/RemoteNoticeScreen';
import { Navbar } from '@/components/layout/Navbar';
import { installPhoneRemoteMode } from '../../src/ts/core/remote/phoneMode';

const flush = () =>
    act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    });

describe('Disconnect', () => {
    afterAll(() => installPhoneRemoteMode({}));

    test('renders nothing where the remote page did not install it', () => {
        installPhoneRemoteMode({});
        const { container } = render(<RemoteDisconnectButton t={(key) => key} className="btn" />);
        expect(container.textContent).toBe('');
        render(<RemoteNoticeScreen />);
        expect(screen.queryByText('app.remoteDisconnect')).toBeNull();
    });

    test('a click leaves remote mode', async () => {
        const disconnect = jest.fn().mockResolvedValue(undefined);
        installPhoneRemoteMode({ disconnect });
        render(<RemoteDisconnectButton t={(key) => key} className="btn" />);
        fireEvent.click(screen.getByText('app.remoteDisconnect'));
        await flush();
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('a leave that failed says so, and the next click clears the message', async () => {
        const disconnect = jest.fn().mockRejectedValueOnce(new Error('prefs')).mockResolvedValue(undefined);
        installPhoneRemoteMode({ disconnect });
        render(<RemoteDisconnectButton t={(key) => key} className="btn" />);
        fireEvent.click(screen.getByText('app.remoteDisconnect'));
        await flush();
        expect(screen.getByRole('alert').textContent).toBe('errors.remoteDisconnectFailed');
        fireEvent.click(screen.getByText('app.remoteDisconnect'));
        await flush();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test("the Navbar carries it while the phone shows the computer's app", () => {
        installPhoneRemoteMode({ disconnect: jest.fn().mockResolvedValue(undefined) });
        render(<Navbar isMock={false} onLogsClick={() => {}} onSettingsClick={() => {}} onLogout={() => {}} />);
        expect(screen.getByText('app.remoteDisconnect')).toBeDefined();
    });

    test('the notice screen carries it too: the app opens there until the user leaves', () => {
        installPhoneRemoteMode({ disconnect: jest.fn().mockResolvedValue(undefined) });
        render(<RemoteNoticeScreen />);
        expect(screen.getByText('app.remoteDisconnect')).toBeDefined();
    });
});
