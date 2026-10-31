/**
 * Runtime mode and platform detection, plus the env flags. The single
 * allowed reader of process.env so the rest of the codebase isn't
 * sprinkled with env lookups. Pure Node — no Electron, no logger
 * import — so it can be required from anywhere including bootstrap
 * paths.
 *
 * The platform-specific answers (the OS paths, the app identity, the
 * packaged-build and source detection) live behind platform().paths in
 * the platform families under src/ts/platforms/. The detection helpers
 * here are the ones those families branch on; they die once every
 * branch has moved.
 */

const hasNode = typeof process !== 'undefined' && process.versions != null;

/**
 * The members of the Capacitor runtime global this module reads.
 */
type CapacitorGlobal = { isNativePlatform: () => boolean };

/**
 * The page globals the platform shells inject (absent in plain Node).
 */
type RuntimeGlobals = typeof globalThis & { Capacitor?: CapacitorGlobal; __GS_HEADLESS__?: unknown };

const getCapacitor = (): CapacitorGlobal | undefined => (globalThis as RuntimeGlobals).Capacitor;

const isElectron = () => hasNode && process.versions.electron != null;

const isCapacitor = () => {
    const cap = getCapacitor();
    return cap != null && typeof cap.isNativePlatform === 'function';
};

// The Android background service runs the JS in a bare WebView with no
// Capacitor runtime, and injects this flag so the storage and HTTP layers
// route through the native @JavascriptInterface bridges instead of
// @capacitor/preferences / CapacitorHttp.
const isHeadlessService = () => (globalThis as RuntimeGlobals).__GS_HEADLESS__ === true;

const isCli = () => hasNode && !isElectron();

const getPlatform = () => {
    if (isHeadlessService()) return 'headless';
    if (isElectron()) return 'electron';
    if (isCapacitor()) return 'capacitor';
    if (isCli()) return 'cli';
    return 'unknown';
};

const isDevelopment = () =>
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'dev' ||
    process.env.DEV === 'true' ||
    process.env.DEV === '1';

const isTest = () => process.env.NODE_ENV === 'test';

const getEnvSnapshot = () => ({
    nodeEnv: process.env.NODE_ENV,
    dev: process.env.DEV,
    prod: process.env.PROD,
});

export { isElectron, isCapacitor, isHeadlessService, isCli, getPlatform, isDevelopment, isTest, getEnvSnapshot };
