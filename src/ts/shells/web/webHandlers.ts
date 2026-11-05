/**
 * Every invoke channel the web shell answers, keyed by channel name: the same
 * ipc/*.handlers.ts modules Electron registers and the Capacitor bridge calls
 * in-process. Only the Electron-bound channels differ: updates come from
 * ipc/releaseUpdates (no self-install), and open-external-url / reload-window
 * / refresh-menu run in the browser (bridge/web.ts).
 */

import * as settingsHandlers from '../../core/ipc/settings.handlers';
import * as votingHandlers from '../../core/ipc/voting.handlers';
import * as logHandlers from '../../core/ipc/log.handlers';
import * as actionsHandlers from '../../core/ipc/actions.handlers';
import * as computationsHandlers from '../../core/ipc/computations.handlers';
import * as currencyHandlers from '../../core/ipc/currency.handlers';
import * as scenariosHandlers from '../../core/ipc/scenarios.handlers';
import { buildReleaseUpdateHandlers } from '../../core/ipc/releaseUpdates';
import * as updateChecker from '../../core/services/UpdateChecker';

import type { IpcHandler } from '../../core/ipc/invokeHandler';
import type { ShellUpdateHandlers } from '../../core/ipc/releaseUpdates';

type Emit = (channel: string, payload?: unknown) => void;

/**
 * Every invoke channel the server answers, keyed by channel name.
 * @param emit - broadcasts an event to every connected browser
 */
const buildWebHandlers = (emit: Emit): Record<string, IpcHandler> => {
    const releaseUpdates = buildReleaseUpdateHandlers({ emit, assetSuffix: async () => null });
    // No updater ships with the web shell: can-auto-update is false, so the
    // renderer's download button opens the releases page instead.
    const manualInstall = async () => ({
        success: false,
        error: 'The web UI does not install updates — download the new release instead',
        fallbackUrl: updateChecker.getReleasesUrl(),
    });
    const updateHandlers = {
        ...releaseUpdates.handlers,
        'download-update': manualInstall,
        'install-update': manualInstall,
        'can-auto-update': async () => ({ success: true, canAutoUpdate: false }),
    } satisfies ShellUpdateHandlers;

    // The remote-access pairing is the desktop app's own; the web shell has no QR code to show.
    const notApplicable = (what: string) => async () => ({
        success: false,
        error: `Remote access is not available in the web UI (${what} happens in the desktop app)`,
    });
    const remotePairingHandlers = {
        'get-remote-access': notApplicable('the pairing lives'),
        'set-remote-access': notApplicable('it is switched on'),
        'reset-remote-pairing': notApplicable('the pairing is reset'),
        'log-remote-info': notApplicable('the remote host logs'),
    };

    return {
        // The settings handlers announce writes through the installed
        // platform's windows (web/platform), which emit on this run's
        // fan-out (setWebShellRun in serverLifecycle.ts).
        ...settingsHandlers.buildHandlers(),
        ...votingHandlers.buildHandlers(),
        ...logHandlers.buildHandlers(),
        ...actionsHandlers.buildHandlers(),
        ...computationsHandlers.buildHandlers(),
        ...currencyHandlers.buildHandlers(),
        ...scenariosHandlers.buildHandlers(),
        ...updateHandlers,
        ...remotePairingHandlers,
    };
};

export { buildWebHandlers };
export type { Emit };
