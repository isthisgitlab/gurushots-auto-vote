/**
 * Web entry (pages/Web.tsx) — at module load installs the fetch/SSE bridge,
 * mounts Login or App from whether the server holds a token, and re-mounts on
 * login-success / logout. Each test loads the module in an isolated registry
 * with its collaborators doMock'ed.
 */

import type { RendererGlobals } from '../../src/ts/types/capacitor';

const SRC = '../../src/ts';

const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('Web entry', () => {
    let saved: boolean | undefined;

    beforeEach(() => {
        saved = (globalThis as RendererGlobals).__capacitorBootstrap;
    });

    afterEach(() => {
        if (saved === undefined) delete (globalThis as RendererGlobals).__capacitorBootstrap;
        else (globalThis as RendererGlobals).__capacitorBootstrap = saved;
        document.body.innerHTML = '';
    });

    const load = (getSettings: () => Promise<unknown>) => {
        const m = {
            shell: {} as Record<string, () => void>,
            installWebBridge: jest.fn(),
            onShellEvent: jest.fn((event: string, cb: () => void) => {
                m.shell[event] = cb;
                return () => true;
            }),
            getSettings: jest.fn(getSettings),
            logRendererError: jest.fn(async (_message: string) => {}),
            mountApp: jest.fn(),
            mountLogin: jest.fn(),
        };
        jest.isolateModules(() => {
            jest.doMock(`${SRC}/bridge/web`, () => ({
                installWebBridge: m.installWebBridge,
                onShellEvent: m.onShellEvent,
            }));
            jest.doMock('@/api/ipc', () => ({ getSettings: m.getSettings, logRendererError: m.logRendererError }));
            jest.doMock('@/pages/App', () => ({ mountApp: m.mountApp }));
            jest.doMock('@/pages/Login', () => ({ mountLogin: m.mountLogin }));
            require('@/pages/Web');
        });
        return m;
    };

    test('installs the bridge, then mounts App for a stored token', async () => {
        const m = load(async () => ({ hasToken: true }));
        await flush();
        expect((globalThis as RendererGlobals).__capacitorBootstrap).toBe(true);
        expect(m.installWebBridge.mock.invocationCallOrder[0]).toBeLessThan(m.getSettings.mock.invocationCallOrder[0]);
        expect(m.getSettings).toHaveBeenCalledTimes(1);
        expect(m.mountApp).toHaveBeenCalledTimes(1);
        expect(m.mountLogin).not.toHaveBeenCalled();
    });

    test('login-success and logout re-mount by the current token state', async () => {
        const m = load(async () => ({ hasToken: false }));
        await flush();
        expect(m.mountLogin).toHaveBeenCalledTimes(1);

        m.getSettings.mockResolvedValue({ hasToken: true });
        m.shell['login-success']();
        await flush();
        expect(m.mountApp).toHaveBeenCalledTimes(1);

        m.getSettings.mockResolvedValue({ hasToken: false });
        m.shell.logout();
        await flush();
        expect(m.mountLogin).toHaveBeenCalledTimes(2);
    });

    test('an unreachable server logs the failure and mounts Login', async () => {
        const m = load(async () => {
            throw new Error('fetch failed');
        });
        await flush();
        expect(m.logRendererError).toHaveBeenCalledWith('Web UI could not read the session state: fetch failed');
        expect(m.mountLogin).toHaveBeenCalledTimes(1);
    });
});
