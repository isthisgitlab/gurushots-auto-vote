/**
 * The app identity: the package name and the name the app's data directory
 * carries. Every consumer (logger, settings storage, the platform families)
 * names the app through this module, so logs and settings can never land in
 * different directories. It imports only the port: the packaged-build answer
 * is the installed platform's, not a detection helper of its own.
 */

import { platform } from './port';

const APP_BASE_NAME = 'gurushots-auto-vote';

const getAppName = (): string => (platform().paths.isSourceCode() ? `${APP_BASE_NAME}-dev` : APP_BASE_NAME);

export { APP_BASE_NAME, getAppName };
