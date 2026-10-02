/**
 * Web entry (pages/Web.tsx) — at module load installs the fetch/SSE bridge,
 * mounts Login or App from the token the server holds, and re-mounts on
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

    const load = (getSetting: () => Promise<unknown>) => {
        const m = {
            shell: {} as Record<string, () => void>,
            installWebBridge: jest.fn(),
            onShellEvent: jest.fn((event: string, cb: () => void) => {
                m.shell[event] = cb;
                return () => true;
            }),
            getSetting: jest.fn(getSetting),
            logRendererError: jest.fn(async (_message: string) => {}),
            mountApp: jest.fn(),
            mountLogin: jest.fn(),
        };
        jest.isolateModules(() => {
            jest.doMock(`${SRC}/bridge/web`, () => ({
                installWebBridge: m.installWebBridge,
                onShellEvent: m.onShellEvent,
            }));
            jest.doMock('@/api/ipc', () => ({ getSetting: m.getSetting, logRendererError: m.logRendererError }));
            jest.doMock('@/pages/App', () => ({ mountApp: m.mountApp }));
            jest.doMock('@/pages/Login', () => ({ mountLogin: m.mountLogin }));
            require('@/pages/Web');
        });
        return m;
    };

    test('installs the bridge, then mounts App for a stored token', async () => {
        const m = load(async () => 'tok');
        await flush();
        expect((globalThis as RendererGlobals).__capacitorBootstrap).toBe(true);
        expect(m.installWebBridge.mock.invocationCallOrder[0]).toBeLessThan(m.getSetting.mock.invocationCallOrder[0]);
        expect(m.getSetting).toHaveBeenCalledWith('token');
        expect(m.mountApp).toHaveBeenCalledTimes(1);
        expect(m.mountLogin).not.toHaveBeenCalled();
    });

    test('login-success and logout re-mount by the current token; a non-string token mounts Login', async () => {
        const m = load(async () => undefined);
        await flush();
        expect(m.mountLogin).toHaveBeenCalledTimes(1);

        m.getSetting.mockResolvedValue('new-token');
        m.shell['login-success']();
        await flush();
        expect(m.mountApp).toHaveBeenCalledTimes(1);

        m.getSetting.mockResolvedValue('');
        m.shell.logout();
        await flush();
        expect(m.mountLogin).toHaveBeenCalledTimes(2);
    });

    test('an unreachable server logs the failure and mounts Login', async () => {
        const m = load(async () => {
            throw new Error('fetch failed');
        });
        await flush();
        expect(m.logRendererError).toHaveBeenCalledWith('Web UI could not read the session token: fetch failed');
        expect(m.mountLogin).toHaveBeenCalledTimes(1);
    });
});
