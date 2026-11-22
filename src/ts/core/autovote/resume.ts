/**
 * The controller's mount-time auto-resume hold: the chunked wall-clock wait
 * between the app launching and an interrupted session resuming by itself.
 */

import { startupResumeAt } from '../scheduling/startupDelay';
import { finiteOr } from '../numbers';
import { errorMessage } from '../errorMessage';
import { ACTIONS } from './state';

import type { TimerHandle } from '../scheduling/cadenceChain';
import type { RunCapture } from '../scheduling/cadenceChain/types';
import type { RunGate } from './runGate';
import type { ControllerCore } from './types';

// The hold timer re-arms in chunks this long: a renderer timer is monotonic and
// fires late after a system sleep, so the wall clock is re-read between chunks.
const HOLD_CHUNK_MS = 5000;

/** The hold the controller carries: the resume check and its one-shot timer. */
export type ResumeHold = {
    maybeResume: () => Promise<void>;
    /** Cancel the hold timer of a pending auto-resume and empty its slot. */
    clearResumeTimer: () => void;
    resumeTimer: { current: TimerHandle | null };
};

/**
 * Create the resume hold over the controller's core. Its one-shot timer slot
 * is deliberately separate from the cadence chain's cycle timer: it is not
 * part of the chain, so the scheduleNext generation guard neither sees nor
 * cancels it. Armed means pending.
 */
export const createResumeHold = ({
    host,
    apply,
    flags,
    gate,
    start,
}: ControllerCore & { gate: RunGate; start: (request: RunCapture) => Promise<void> }): ResumeHold => {
    const resumeTimer: { current: TimerHandle | null } = { current: null };

    const clearResumeTimer = (): void => {
        if (resumeTimer.current) {
            host.clearTimeout(resumeTimer.current);
            resumeTimer.current = null;
        }
    };

    /**
     * Auto-resume if a previous session left autovoteRunning persisted
     * as true (user toggled Start, then closed the app or restarted the device).
     * Skips when there is no token, otherwise the loop would error every cycle
     * until the user logs in. The adapter calls this once per mount — no extra
     * ran-once guard.
     *
     * The resume is held until `autovoteStartupDelay` seconds after the app
     * LAUNCHED (not after this mount), so a window reload continues the same hold
     * and one after it has passed resumes at once. A native service that is
     * already running is adopted at once: voting never stopped. While held,
     * `pendingStartAt` is set and a chunked timer in `resumeTimer` calls start()
     * once the wall clock reaches the resume time (see HOLD_CHUNK_MS). A dispose,
     * or any start/stop by the user during the awaits, leaves nothing armed.
     */
    const maybeResume = async (): Promise<void> => {
        try {
            // The request is created here: it carries the Stop generation now and the epoch the fence holds. A fence that cannot
            // be read arms nothing, and a Stop that lands while this waits makes the request obsolete.
            const request = await gate.captureFresh();
            if (!request) return;
            const wasRunning = await host.getSetting('autovoteRunning');
            if (!wasRunning) return;
            const settings = await host.getSettings();
            if (!settings?.hasToken) return;
            const native = await host.background.status();
            if (native.running) {
                if (!flags.disposed()) await start(request);
                return;
            }
            // An unreadable delay or launch time still holds the session back
            // (default delay; the mount as launch), never starts it at once.
            const [delay, env] = await Promise.all([
                host.callOrNull(() => host.getGlobalDefault('autovoteStartupDelay')),
                host.callOrNull(() => host.getEnvironmentInfo()),
            ]);
            if (flags.disposed() || flags.running() || flags.userActed()) return;
            const resumeAt = startupResumeAt(finiteOr(env?.launchedAt, Date.now()), delay);
            const waitMs = resumeAt - Date.now();
            if (waitMs <= 0) {
                await start(request);
                return;
            }
            apply({ type: ACTIONS.SET_PENDING_START, payload: resumeAt });
            void host.logRendererDebug(`Auto-resume held for ${Math.ceil(waitMs / 1000)}s after launch`);
            const tick = () => {
                resumeTimer.current = null;
                const left = resumeAt - Date.now();
                if (left > 0) {
                    resumeTimer.current = host.setTimeout(tick, Math.min(left, HOLD_CHUNK_MS));
                    return;
                }
                void host.logRendererDebug('Auto-resume hold over — starting');
                start(request).catch((err) => host.logRendererError(`Auto-resume failed: ${errorMessage(err) || err}`));
            };
            resumeTimer.current = host.setTimeout(tick, Math.min(waitMs, HOLD_CHUNK_MS));
        } catch {
            /* ignore — leave UI in stopped state on failure */
        }
    };

    return { maybeResume, clearResumeTimer, resumeTimer };
};
