/**
 * platform/kind — the dependency-free platform marker the shell bridges set. A page with no stored kind reads
 * `electron` (the Electron renderer has no bridge to mark with); a marked one reads what was stored.
 */
import { markPlatformKind, platformKind } from '../../src/ts/platform/kind';
import { resetPlatformKind } from '../helpers/platformKind';

describe('platform kind', () => {
    afterEach(resetPlatformKind);

    test('a page no bridge marked reads electron', () => {
        expect(platformKind()).toBe('electron');
    });

    test('the kind a bridge marked is the kind that reads back', () => {
        markPlatformKind('web');
        expect(platformKind()).toBe('web');
        markPlatformKind('capacitor');
        expect(platformKind()).toBe('capacitor');
    });
});
