/**
 * Web shell channel parity: every window.api invoke channel in the manifest is
 * answered either by the web server (the real ipc handler modules plus its
 * update channels) or by the browser bridge itself — none by both, none by
 * neither. Mirrors tests/ipc/manifest.test.ts for the Electron shell.
 */

jest.mock('../../src/js/settings');
jest.mock('../../src/js/apiFactory', () => ({
    getApiStrategy: jest.fn(),
    getMiddleware: jest.fn(),
    refreshApi: jest.fn(),
}));

import type * as serverModule from '../../src/js/web/server';
import type * as bridgeModule from '../../src/js/bridge/web';
import type * as manifestModule from '../../src/js/ipc/manifest';

const { buildWebHandlers } = require('../../src/js/web/server') as typeof serverModule;
const { BROWSER_CHANNELS } = require('../../src/js/bridge/web') as typeof bridgeModule;
const { allInvokeChannels } = require('../../src/js/ipc/manifest') as typeof manifestModule;

test('server channels and browser channels partition the manifest invoke surface', () => {
    const served = Object.keys(buildWebHandlers(() => {}));
    const browser = [...BROWSER_CHANNELS];
    expect(served.filter((channel) => BROWSER_CHANNELS.has(channel))).toEqual([]);
    expect([...served, ...browser].sort()).toEqual([...allInvokeChannels()].sort());
});
