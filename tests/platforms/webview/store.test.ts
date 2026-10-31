/**
 * The webview family's storage member, as it stands: every function member
 * throws until Phase 3 step 7 moves the real transport behind the port, and
 * lockPolicy is the branch's own answer for the app WebView.
 */

import { createWebviewStorage } from '../../../src/ts/platforms/webview/store';

import type { SettingsStoreRef } from '../../../src/ts/platform/port';

const store: SettingsStoreRef = { prefKey: 'gs_test', filePath: () => '/data/gs_test.json' };
const storage = createWebviewStorage();
const NOT_MOVED = 'webview storage moves behind the port in Phase 3 step 7';

describe('the placeholder storage', () => {
    test.each([
        ['readRaw', () => storage.readRaw(store)],
        ['writeRaw', () => storage.writeRaw(store, 'DATA', false)],
        ['writeIfAbsent', () => storage.writeIfAbsent(store, 'IMPORT')],
        ['location', () => storage.location(store)],
        ['hasQuarantined', () => storage.hasQuarantined(store)],
        ['quarantineRaw', () => storage.quarantineRaw(store, 'UNUSABLE')],
        ['storedKey', () => storage.storedKey?.('gs_test')],
        ['preferences', () => storage.preferences?.()],
        ['headlessStore', () => storage.headlessStore()],
        ['cas', () => storage.cas?.('gs_test', null, 'DATA')],
        ['sharedUpdate', () => storage.sharedUpdate?.('gs_test', () => null)],
        ['readFailed', () => storage.readFailed('gs_test')],
        ['loaded', () => storage.loaded('gs_test')],
        ['flushed', () => storage.flushed()],
    ])('%s throws until Phase 3 step 7 moves the transport', (_name, call) => {
        expect(call).toThrow(NOT_MOVED);
    });

    test('lockPolicy is the answer the branches select for the app WebView', () => {
        expect(storage.lockPolicy).toBe('none');
    });
});
