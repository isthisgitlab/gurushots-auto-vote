/**
 * The phone's connection badge and the standalone notice screen: the badge
 * follows the connection state, the offline state adds the full
 * offline-or-reset explanation and the full state its too-many-phones
 * sentence as banners, the first connect offers Add to Home Screen
 * once per session, and the notice screen names the same states.
 */

import { act, screen, fireEvent } from '@testing-library/preact';
import { render } from './helpers/test-utils';
import { RemoteStateBadge } from '@/components/app/RemoteStateBadge';
import { RemoteNoticeScreen } from '@/components/app/RemoteNoticeScreen';
import {
    remoteConnectionState,
    setRemoteConnectionState,
    setRemoteHostPath,
} from '../../src/ts/core/remote/connectionState';
import { installPhoneRemoteMode } from '../../src/ts/core/remote/phoneMode';

import type * as noticeModule from '../../src/ts/react/components/app/RemoteNoticeScreen';
import type * as connectionStateModule from '../../src/ts/core/remote/connectionState';
import type * as rendererModule from '../../src/ts/core/translations/renderer';

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
        ['old-browser', 'app.remoteOldBrowserShort', 'badge-error'],
        ['older-link', 'app.remoteUpdateNeeded', 'badge-warning'],
        ['newer-link', 'app.remoteUpdateThis', 'badge-warning'],
        ['update', 'app.remoteUpdateNeeded', 'badge-warning'],
        ['update-this', 'app.remoteUpdateThis', 'badge-warning'],
        ['unpublished', 'app.remotePageUnpublished', 'badge-warning'],
        ['link-changed', 'app.remoteNewLinkNeeded', 'badge-warning'],
        ['full', 'app.remoteFullShort', 'badge-error'],
        ['no-key', 'app.remoteNoKey', 'badge-error'],
    ] as const)('%s shows its label and tone', (state, key, tone) => {
        setRemoteConnectionState(state);
        const { container } = render(<RemoteStateBadge />);
        const badge = container.querySelector('[role="status"]');
        expect(badge?.textContent).toBe(key);
        expect(badge?.className).toContain(tone);
    });

    test('connected over the relays says so; connected directly does not', () => {
        setRemoteConnectionState('connected');
        setRemoteHostPath('relay');
        const relayed = render(<RemoteStateBadge />);
        expect(relayed.container.querySelector('[role="status"]')?.textContent).toBe('app.remoteConnectedRelay');
        relayed.unmount();
        setRemoteHostPath('direct');
        const direct = render(<RemoteStateBadge />);
        expect(direct.container.querySelector('[role="status"]')?.textContent).toBe('app.remoteConnected');
        setRemoteHostPath('direct');
    });

    test('a mounted badge follows the desktop moving from the relays to WebRTC, and back', () => {
        setRemoteConnectionState('connected');
        setRemoteHostPath('relay');
        const { container } = render(<RemoteStateBadge />);
        expect(container.querySelector('[role="status"]')?.textContent).toBe('app.remoteConnectedRelay');
        act(() => {
            setRemoteHostPath('direct');
        });
        expect(container.querySelector('[role="status"]')?.textContent).toBe('app.remoteConnected');
        act(() => {
            setRemoteHostPath('relay');
        });
        expect(container.querySelector('[role="status"]')?.textContent).toBe('app.remoteConnectedRelay');
        setRemoteHostPath('direct');
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

    test('full adds the too-many-phones sentence as a banner', () => {
        const { container } = render(<RemoteStateBadge />);
        act(() => {
            setRemoteConnectionState('full');
        });
        expect(container.textContent).toContain('app.remoteFullShort');
        expect(screen.getByRole('alert').textContent).toBe('app.remoteFull');
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
        ['old-browser', 'app.remoteOldBrowser'],
        ['older-link', 'errors.remoteLinkOlder'],
        ['newer-link', 'errors.remoteLinkNewer'],
        ['update', 'app.remoteUpdateNeeded'],
        ['update-this', 'app.remoteUpdateThis'],
        ['unpublished', 'app.remotePageUnpublished'],
        ['link-changed', 'app.remoteLinkChanged'],
        ['full', 'app.remoteFull'],
        ['connecting', 'app.remoteConnecting'],
    ] as const)('%s names the state', (state, key) => {
        setRemoteConnectionState(state);
        const { container } = render(<RemoteNoticeScreen />);
        expect(container.textContent).toContain(key);
        expect(remoteConnectionState()).toBe(state);
    });

    test('mounts its real notice in Latvian when the browser language is Latvian', () => {
        const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'lv-LV' } });
        document.body.innerHTML = '<div id="root"></div>';
        try {
            jest.isolateModules(() => {
                jest.unmock('../../src/ts/core/translations/renderer');
                const { mountRemoteNotice } =
                    require('../../src/ts/react/components/app/RemoteNoticeScreen') as typeof noticeModule;
                const { rendererTranslator } =
                    require('../../src/ts/core/translations/renderer') as typeof rendererModule;
                const { setRemoteConnectionState: setNoticeState } =
                    require('../../src/ts/core/remote/connectionState') as typeof connectionStateModule;
                const currentLanguage = rendererTranslator.getCurrentLanguage();
                rendererTranslator.setCurrentLanguage('en');
                setNoticeState('no-key');
                try {
                    expect(globalThis.navigator.language).toBe('lv-LV');
                    act(() => {
                        mountRemoteNotice();
                    });
                    expect(rendererTranslator.getCurrentLanguage()).toBe('lv');
                    expect(document.getElementById('root')?.textContent).toContain(
                        'Skenē datorā redzamo QR kodu, lai savienotu',
                    );
                } finally {
                    rendererTranslator.setCurrentLanguage(currentLanguage);
                    setNoticeState('connecting');
                }
            });
        } finally {
            if (navigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
            else Object.defineProperty(globalThis, 'navigator', navigator);
            document.body.innerHTML = '';
        }
    });
});
