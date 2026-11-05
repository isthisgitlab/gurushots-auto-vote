/**
 * mountForToken — the Login/App swap the single-document shells (Capacitor,
 * web) run on login and logout. The previous tree must be unmounted, not just
 * have its DOM removed: its effects (the autovote scheduler's timers, event
 * subscriptions) would otherwise keep running beside the new tree.
 */

import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const cleanups: string[] = [];
const useCleanupLog = (name: string) => useEffect(() => () => void cleanups.push(name), [name]);
const AppProbe = () => {
    useCleanupLog('app');
    return <span>app</span>;
};
const LoginProbe = () => {
    useCleanupLog('login');
    return <span>login</span>;
};

import { invalid } from '../helpers/invalid';

import type { BackgroundHost } from '../../src/ts/core/autovote/controller';

const mockMount = (name: string) => () =>
    createRoot(document.getElementById('root')!).render(name === 'app' ? <AppProbe /> : <LoginProbe />);

// Every app mount hands a root back (the real mountApp does); the swap must
// unmount the previous one.
const appRoots: Array<{ unmount: jest.MockedFunction<() => void> }> = [];
const mockMountApp = jest.fn((_backgroundHost?: unknown) => {
    mockMount('app')();
    const root = { unmount: jest.fn() };
    appRoots.push(root);
    return root;
});
jest.mock('@/pages/App', () => ({ mountApp: (backgroundHost?: unknown) => mockMountApp(backgroundHost) }));
const mockMountLogin = jest.fn();
jest.mock('@/pages/Login', () => ({
    mountLogin: (startupError?: string) => {
        mockMountLogin(startupError);
        mockMount('login')();
    },
}));

import { mountForToken } from '@/pages/mountForToken';

const flush = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
    document.body.innerHTML = '';
    cleanups.length = 0;
    appRoots.length = 0;
});

test('swapping trees unmounts the previous one and clears stale DOM', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    root.appendChild(document.createElement('p'));
    document.body.appendChild(root);

    mountForToken(false);
    await flush();
    expect(root.textContent).toBe('login');
    // No app root stood, so there was nothing to unmount.
    expect(appRoots).toEqual([]);

    mountForToken(true);
    await flush();
    expect(cleanups).toEqual(['login']);
    expect(root.textContent).toBe('app');
    expect(root.querySelector('p')).toBeNull();
    // The app root stands and has not been unmounted.
    expect(appRoots).toHaveLength(1);
    expect(appRoots[0].unmount).not.toHaveBeenCalled();

    mountForToken(false);
    await flush();
    expect(cleanups).toEqual(['login', 'app']);
    expect(root.textContent).toBe('login');
    // The swap unmounted the standing app root — its controller's dispose
    // runs there — before the login tree mounted.
    expect(appRoots[0].unmount).toHaveBeenCalledTimes(1);

    // An app root mounted after a login is tracked the same way.
    mountForToken(true);
    await flush();
    expect(appRoots).toHaveLength(2);
    expect(appRoots[1].unmount).not.toHaveBeenCalled();
    mountForToken(false);
    await flush();
    expect(appRoots[1].unmount).toHaveBeenCalledTimes(1);
});

test('a failure the shell met is handed to Login, and only to Login', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    mountForToken(false, 'web-shell-token');
    expect(mockMountLogin).toHaveBeenLastCalledWith('web-shell-token');

    mountForToken(true, 'web-shell-token');
    expect(mockMountLogin).toHaveBeenCalledTimes(1);
});

test('the App mount carries the background host the shell passes', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    // No host of its own: the omitted third arg is forwarded untouched, and
    // the real mountApp defaults it to the no-op host (pinned by AppPage's
    // auto-mount case).
    mountForToken(true);
    expect(mockMountApp).toHaveBeenLastCalledWith(undefined);

    const custom = invalid<BackgroundHost>({ marker: 'custom-host' });
    mountForToken(true, undefined, custom);
    expect(mockMountApp).toHaveBeenLastCalledWith(custom);
});
