/**
 * The controller's best-effort persisted session markers, written through the
 * host's setSetting.
 */

import { finiteOr } from '../numbers';
import { errorMessage } from '../errorMessage';

import type { AutovoteHost } from './types';

/** The session persists the lifecycle writes on start/stop. */
export type AutovotePersistence = {
    /**
     * Persist the running flag so a remount of the app (Capacitor re-launch,
     * Electron window reopen) resumes — or, once cleared, does not resume — voting.
     * Best-effort: a failure only means the next launch won't match.
     */
    persistRunningFlag: (value: boolean) => Promise<void>;
    /**
     * Record which app launch started this session: the launch time itself, which
     * the main process compares for equality with its own to tell a session started
     * in this launch from one still held at launch. Written BEFORE the running
     * flag. 0 when the launch time can't be read, which matches no launch, so the
     * main process then treats the session as not live (no spend) rather than live.
     */
    persistStartedLaunch: () => Promise<void>;
};

export const createPersistence = (host: AutovoteHost): AutovotePersistence => ({
    persistRunningFlag: async (value: boolean) => {
        try {
            await host.setSetting('autovoteRunning', value);
        } catch {
            /* ignore */
        }
    },

    persistStartedLaunch: async () => {
        try {
            const env = await host.callOrNull(() => host.getEnvironmentInfo());
            await host.setSetting('autovoteStartedLaunch', finiteOr(env?.launchedAt, 0));
        } catch (err) {
            void host.logRendererWarning(`Could not record the auto-vote launch marker: ${errorMessage(err) || err}`);
        }
    },
});
