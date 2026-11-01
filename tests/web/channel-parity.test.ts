/**
 * Web shell channel parity: every window.api invoke channel in the manifest is
 * answered either by the web server (the real ipc handler modules plus its
 * update channels) or by the browser bridge itself — none by both, none by
 * neither. Mirrors tests/ipc/manifest.test.ts for the Electron shell.
 */

jest.mock('../../src/ts/core/settings');
jest.mock('../../src/ts/core/apiFactory', () => ({
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
    refreshApi: jest.fn(),
}));

import type * as serverModule from '../../src/ts/shells/web/server';
import { clearInstalledPlatform } from '../helpers/platform';
import type * as bridgeModule from '../../src/ts/shells/web/bridge/web';
import type * as manifestModule from '../../src/ts/core/ipc/manifest';

clearInstalledPlatform();
const { buildWebHandlers } = require('../../src/ts/shells/web/server') as typeof serverModule;
const { BROWSER_CHANNELS } = require('../../src/ts/shells/web/bridge/web') as typeof bridgeModule;
const { allInvokeChannels } = require('../../src/ts/core/ipc/manifest') as typeof manifestModule;

test('server channels and browser channels partition the manifest invoke surface', () => {
    const served = Object.keys(buildWebHandlers(() => {}));
    const browser = [...BROWSER_CHANNELS];
    expect(served.filter((channel) => BROWSER_CHANNELS.has(channel))).toEqual([]);
    expect([...served, ...browser].sort()).toEqual([...allInvokeChannels()].sort());
});

test('the remote-access pairing channels answer not-applicable in the web UI', async () => {
    const handlers = buildWebHandlers(() => {});
    for (const channel of ['get-remote-access', 'set-remote-access', 'reset-remote-pairing']) {
        await expect((handlers[channel] as (event: null, args: never[]) => unknown)(null, [])).resolves.toEqual({
            success: false,
            error: expect.stringContaining('Remote access is not available in the web UI'),
        });
    }
});
