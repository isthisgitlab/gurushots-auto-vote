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

const mockMount = (name: string) => () =>
    createRoot(document.getElementById('root')!).render(name === 'app' ? <AppProbe /> : <LoginProbe />);

jest.mock('@/pages/App', () => ({ mountApp: () => mockMount('app')() }));
jest.mock('@/pages/Login', () => ({ mountLogin: () => mockMount('login')() }));

import { mountForToken } from '@/pages/mountForToken';

const flush = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
    document.body.innerHTML = '';
    cleanups.length = 0;
});

test('swapping trees unmounts the previous one and clears stale DOM', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    root.appendChild(document.createElement('p'));
    document.body.appendChild(root);

    mountForToken(false);
    await flush();
    expect(root.textContent).toBe('login');

    mountForToken(true);
    await flush();
    expect(cleanups).toEqual(['login']);
    expect(root.textContent).toBe('app');
    expect(root.querySelector('p')).toBeNull();

    mountForToken(false);
    await flush();
    expect(cleanups).toEqual(['login', 'app']);
    expect(root.textContent).toBe('login');
});
