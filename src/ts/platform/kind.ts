/**
 * The platform the renderer runs on, marked by the shell bridge when it exposes `window.api` (the web bridge always,
 * the Capacitor one only when the runtime probes native). Dependency-free, so the renderer can read it without
 * importing the bridge.
 */

export type PlatformKind = 'electron' | 'web' | 'capacitor';

type PlatformGlobals = typeof globalThis & { __autovotePlatformKind?: PlatformKind };

/** Called by the bridge that exposes `window.api`, once, at installation. */
const markPlatformKind = (kind: PlatformKind): void => {
    (globalThis as PlatformGlobals).__autovotePlatformKind = kind;
};

/**
 * The stored kind; `electron` when none is stored: the Electron renderer has no bridge module to mark with, because
 * the preload runs in an isolated world.
 */
const platformKind = (): PlatformKind => (globalThis as PlatformGlobals).__autovotePlatformKind ?? 'electron';

export { markPlatformKind, platformKind };
