/**
 * Update channels for the shells that have no electron-updater: the Capacitor
 * bridge and the web server. check-for-updates reads GitHub Releases through
 * the shared UpdateChecker, honours the user-skipped version (the settings
 * facade is the single skip-version store on every platform — Electron's
 * AutoUpdater reads the same key) and announces the outcome as the same
 * update-* events Electron sends. Each shell adds its own download-update /
 * install-update / can-auto-update on top.
 */

import * as settings from '../settings';
import * as updateChecker from '../services/UpdateChecker';
import * as pkg from '../../../package.json';
import { errorResult } from './errorResult';

import type { UpdateSummary } from '../services/AutoUpdater';

type ReleaseUpdateInfo = UpdateSummary & { downloadUrl: string | null };

/**
 * Electron's update handlers, each allowed to answer asynchronously: a shell's
 * own update channels must return what the renderer gets on Electron.
 */
type ElectronUpdateHandlers = ReturnType<typeof import('./update.handlers').buildHandlers>;
export type ShellUpdateHandlers = {
    [C in keyof ElectronUpdateHandlers]?: ElectronUpdateHandlers[C] extends (...args: infer A) => infer R
        ? (...args: A) => R | Promise<Awaited<R>>
        : never;
};

interface ReleaseUpdateDeps {
    /** Broadcast an update-* event to the renderer. */
    emit: (channel: string, payload?: unknown) => void;
    /** The release-asset suffix this build ships as; null links the releases page. */
    assetSuffix: () => Promise<string | null>;
}

const buildReleaseUpdateHandlers = ({ emit, assetSuffix }: ReleaseUpdateDeps) => {
    // The most recent check's result. download-update and skip-update-version
    // read it so the renderer does not need to thread the version or URL through.
    let lastUpdateInfo: ReleaseUpdateInfo | null = null;

    const handlers = {
        'check-for-updates': async () => {
            try {
                const result = await updateChecker.checkForUpdates({
                    currentVersion: pkg.version,
                    isBetaChannel: pkg.version.includes('-'),
                    assetSuffix: await assetSuffix(),
                });
                if (result.updateAvailable) {
                    // '' means no skip, and an available update always has a
                    // non-empty version, so a plain equality check suffices.
                    if (settings.getSetting('skipUpdateVersion') === result.version) {
                        lastUpdateInfo = null;
                        emit('update-not-available', { version: result.version });
                        return { success: true, updateInfo: null };
                    }
                    const updateInfo = {
                        currentVersion: pkg.version,
                        latestVersion: result.version,
                        releaseNotes: result.releaseNotes,
                        releaseDate: result.releaseDate,
                        isPrerelease: result.isPrerelease,
                        downloadUrl: result.downloadUrl,
                    };
                    lastUpdateInfo = updateInfo;
                    emit('update-available', updateInfo);
                    return { success: true, updateInfo };
                }
                lastUpdateInfo = null;
                emit('update-not-available', { version: result.version || pkg.version });
                return { success: true, updateInfo: null };
            } catch (error) {
                const failure = errorResult(error, 'Failed to check for updates');
                emit('update-error', { message: failure.error });
                return failure;
            }
        },
        'skip-update-version': async () => {
            const version = lastUpdateInfo?.latestVersion;
            if (!version) {
                return { success: false, error: 'No update info — run check-for-updates first' };
            }
            settings.setSetting('skipUpdateVersion', version);
            lastUpdateInfo = null;
            return { success: true, version };
        },
        'clear-skip-version': async () => {
            settings.setSetting('skipUpdateVersion', '');
            return { success: true };
        },
        'get-releases-url': async () => ({ success: true, url: updateChecker.getReleasesUrl() }),
    } satisfies ShellUpdateHandlers;

    return { handlers, getLastUpdateInfo: () => lastUpdateInfo };
};

export { buildReleaseUpdateHandlers };
