/**
 * The env flags. The single allowed reader of process.env so the rest of
 * the codebase isn't sprinkled with env lookups. Pure Node — no Electron,
 * no logger import — so it can be required from anywhere including
 * bootstrap paths.
 *
 * The platform-specific answers (the OS paths, the app identity, the
 * packaged-build and source detection, the Electron/Capacitor/headless
 * detection) live behind platform() in the platform families under
 * src/ts/platforms/.
 */

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

export { isDevelopment, isTest, getEnvSnapshot };
