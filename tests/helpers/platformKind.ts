/**
 * Clears the platform kind a test marked (platform/kind stores it on globalThis), so it cannot leak into the next
 * test — in this file or, on the shared global, a later one.
 */
import type { PlatformKind } from '../../src/ts/platform/kind';

type PlatformGlobals = typeof globalThis & { __autovotePlatformKind?: PlatformKind };

const resetPlatformKind = (): void => {
    delete (globalThis as PlatformGlobals).__autovotePlatformKind;
};

export { resetPlatformKind };
