/**
 * The phone's connection badge and the standalone notice screen: the badge
 * follows the connection state, the offline state adds the full
 * offline-or-reset explanation, the first connect offers Add to Home Screen
 * once per session, and the notice screen names the same states.
 */

import { act, screen, fireEvent } from '@testing-library/preact';
import { render } from './helpers/test-utils';
import { RemoteStateBadge } from '@/components/app/RemoteStateBadge';
import { RemoteNoticeScreen } from '@/components/app/RemoteNoticeScreen';
import { setRemoteConnectionState, remoteConnectionState } from '../../src/ts/core/remote/connectionState';
import { installPhoneRemoteMode } from '../../src/ts/core/remote/phoneMode';

describe('RemoteStateBadge', () => {
    beforeEach(() => {
        setRemoteConnectionState('connecting');
        window.sessionStorage.clear();
    });

    afterEach(() => {
        setRemoteConnectionState('connecting');
        window.sessionStorage.clear();
    });

    test.each([
        ['connecting', 'app.remoteConnecting', 'badge-ghost'],
        ['connected', 'app.remoteConnected', 'badge-success'],
        ['offline', 'app.remoteOfflineShort', 'badge-error'],
        ['network', 'app.remoteNetwork', 'badge-error'],
        ['update', 'app.remoteUpdateNeeded', 'badge-warning'],
        ['update-this', 'app.remoteUpdateThis', 'badge-warning'],
        ['unpublished', 'app.remotePageUnpublished', 'badge-warning'],
        ['full', 'app.remoteFullShort', 'badge-error'],
        ['no-key', 'app.remoteNoKey', 'badge-error'],
    ] as const)('%s shows its label and tone', (state, key, tone) => {
        setRemoteConnectionState(state);
        const { container } = render(<RemoteStateBadge />);
        const badge = container.querySelector('[role="status"]');
        expect(badge?.textContent).toBe(key);
        expect(badge?.className).toContain(tone);
    });

    test('a state change reached a mounted badge, and offline adds the full explanation', () => {
        const { container } = render(<RemoteStateBadge />);
        expect(container.textContent).toContain('app.remoteConnecting');
        act(() => {
            setRemoteConnectionState('offline');
        });
        expect(container.textContent).toContain('app.remoteOfflineShort');
        expect(screen.getByRole('alert').textContent).toBe('app.remoteOfflineDetail');
    });

    test('a sessionStorage that throws still connects, offering nothing', () => {
        const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
        Object.defineProperty(window, 'sessionStorage', {
            configurable: true,
            value: {
                getItem: () => {
                    throw new Error('blocked');
                },
                setItem: () => {
                    throw new Error('blocked');
                },
                removeItem: () => undefined,
                clear: () => undefined,
                key: () => null,
                length: 0,
            },
        });
        try {
            const { container } = render(<RemoteStateBadge />);
            act(() => {
                setRemoteConnectionState('connected');
            });
            expect(container.textContent).toContain('app.remoteConnected');
            expect(screen.queryByText('app.remoteAddToHomeScreen')).toBeNull();
        } finally {
            if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
        }
    });

    describe('Add to Home Screen is not offered where the page is already installed', () => {
        const realMatchMedia = window.matchMedia;

        afterEach(() => {
            window.matchMedia = realMatchMedia;
            delete (window.navigator as { standalone?: boolean }).standalone;
            installPhoneRemoteMode({});
        });

        const connectFresh = (): void => {
            render(<RemoteStateBadge />);
            act(() => {
                setRemoteConnectionState('connected');
            });
        };

        test('a Home Screen app (display-mode: standalone) gets no offer', () => {
            window.matchMedia = ((query: string) => ({ matches: query === '(display-mode: standalone)' })) as never;
            connectFresh();
            expect(screen.queryByText('app.remoteAddToHomeScreen')).toBeNull();
        });

        test('an iPhone Home Screen app (navigator.standalone) gets no offer', () => {
            Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
            connectFresh();
            expect(screen.queryByText('app.remoteAddToHomeScreen')).toBeNull();
        });

        test("the Android app's remote mode gets no offer", () => {
            installPhoneRemoteMode({ disconnect: async () => undefined });
            connectFresh();
            expect(screen.queryByText('app.remoteAddToHomeScreen')).toBeNull();
        });

        test('a browser tab still gets the offer', () => {
            window.matchMedia = ((query: string) => ({ matches: query === '(display-mode: browser)' })) as never;
            connectFresh();
            expect(screen.getByText('app.remoteAddToHomeScreen')).toBeDefined();
        });
    });

    test('the Add to Home Screen offer appears once per session on the first connect', () => {
        const first = render(<RemoteStateBadge />);
        expect(screen.queryByRole('status')?.textContent).not.toContain('app.remoteAddToHomeScreen');
        act(() => {
            setRemoteConnectionState('connected');
        });
        expect(screen.getByText('app.remoteAddToHomeScreen')).toBeDefined();

        // Dismiss it, then a second mount in the same session offers nothing.
        fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));
        first.unmount();
        render(<RemoteStateBadge />);
        act(() => {
            setRemoteConnectionState('connected');
        });
        expect(screen.queryByText('app.remoteAddToHomeScreen')).toBeNull();
    });
});

describe('RemoteNoticeScreen', () => {
    beforeEach(() => {
        setRemoteConnectionState('connecting');
    });

    afterEach(() => {
        setRemoteConnectionState('connecting');
    });

    test.each([
        ['no-key', 'app.remoteNoKey'],
        ['offline', 'app.remoteOfflineDetail'],
        ['network', 'app.remoteNetwork'],
        ['update', 'app.remoteUpdateNeeded'],
        ['update-this', 'app.remoteUpdateThis'],
        ['unpublished', 'app.remotePageUnpublished'],
        ['full', 'app.remoteFull'],
        ['connecting', 'app.remoteConnecting'],
    ] as const)('%s names the state', (state, key) => {
        setRemoteConnectionState(state);
        const { container } = render(<RemoteNoticeScreen />);
        expect(container.textContent).toBe(key);
        expect(remoteConnectionState()).toBe(state);
    });
});
