/**
 * Renderer-side driver for the deadline-action OS notifications.
 *
 * Injected into the shared cadence chain (AutovoteContext) as its per-cycle
 * onCycleChallenges hook. It owns NONE of the decision logic — that is the pure
 * services/deadlineNotifications.js, safe in this bundle — and only bridges the
 * renderer's IPC + platform delivery:
 *
 *   - config + per-challenge deadline actions come over IPC (the same
 *     get-deadline-actions channel the timeline already uses; no new channel);
 *   - delivery is platform-picked by the caller (Electron Web Notification).
 *
 * Fire-and-forget by contract: the chain calls this in its own isolated,
 * never-awaited wrapper, so a throw here cannot affect scheduling. It is also
 * self-contained — a re-entrancy guard, an early-exit when the feature is off,
 * and its own catch (mirroring the Node twin nodeNotify.js) so it resolves
 * quietly even if the decision code throws, rather than relying on the caller's
 * outer .catch().
 *
 * DELIVERY SCOPE: this is the SINGLE delivery source (Electron). On native
 * Android the app runs a native foreground voting service, so to avoid a
 * dual-loop double-fire the caller does NOT wire this notifier there at all
 * (resolveRendererDelivery → null → onCycleChallenges omitted), which also
 * avoids per-cycle IPC that would only be thrown away. If a native notifier is
 * ever added, keep that gate so the two paths never both fire.
 */

import {
    computeDueNotifications,
    createDedupe,
    formatNotification,
    readNotificationConfig,
} from '../../services/deadlineNotifications';

/**
 * Fetch each challenge's deadline actions, one IPC round trip at a time.
 * get-deadline-actions returns {success, actions} | {success:false} and never
 * throws; anything that didn't resolve cleanly is skipped. Only id/title are
 * read — the challenge objects belong to the voting pass, so they are treated
 * as read-only.
 *
 * @param {Array|unknown} challenges
 * @param {(challenge:Object)=>Promise<{success:boolean, actions?:Array}>} getDeadlineActions
 * @returns {Promise<Array<{id:unknown, title:unknown, actions:Array}>>}
 */
async function collectDeadlineActions(challenges, getDeadlineActions) {
    const list = Array.isArray(challenges) ? challenges : [];
    const perChallengeActions = [];
    for (const challenge of list) {
        const res = await getDeadlineActions(challenge);
        if (!res || res.success !== true || !Array.isArray(res.actions)) continue;
        perChallengeActions.push({ id: challenge?.id, title: challenge?.title, actions: res.actions });
    }
    return perChallengeActions;
}

/**
 * Report a failed notifier cycle to the optional diagnostic sink, which is
 * itself best-effort: a throwing sink is swallowed too.
 *
 * @param {((message:string)=>void)|undefined} log
 * @param {any} error
 */
function logCycleFailure(log, error) {
    try {
        log?.(`deadline notification cycle failed: ${error?.message ?? error}`);
    } catch {
        /* the diagnostic sink itself is best-effort */
    }
}

/**
 * Build the per-cycle notifier. Holds the dedupe Set + a re-entrancy flag, so
 * create ONE instance and reuse it across cycles (a fresh instance every cycle
 * would never dedupe).
 *
 * @param {Object} deps
 * @param {()=>Promise<Object>} deps.getSettings - the getSettings IPC
 * @param {(challenge:Object)=>Promise<{success:boolean, actions?:Array}>} deps.getDeadlineActions -
 *   the getDeadlineActions IPC (returns the {success, actions} wrapper — never throws)
 * @param {(key:string)=>string} deps.translate - returns a raw i18n template
 * @param {(n:{title:string, body:string})=>void} deps.deliver - platform delivery
 * @param {(message:string)=>void} [deps.log] - optional best-effort diagnostic sink
 *   (e.g. ipc.logRendererDebug); a failure is logged here rather than vanishing.
 * @returns {(challenges:Array, now:number)=>Promise<void>}
 */
export function createDeadlineNotifier({ getSettings, getDeadlineActions, translate, deliver, log }) {
    const dedupe = createDedupe();
    // Re-entrancy guard: per-challenge IPC round trips make a cycle's run
    // outlast a fast (last-minute) cadence tick; without this, two overlapping
    // runs could race the dedupe Set around an await and double-fire.
    let running = false;

    return async function onCycleChallenges(challenges, now) {
        if (running) return;
        running = true;
        try {
            const settings = await getSettings();
            const config = readNotificationConfig((key) => settings?.[key]);
            // Feature off (the default) → zero per-challenge work.
            if (!config.anyEnabled) return;

            const perChallengeActions = await collectDeadlineActions(challenges, getDeadlineActions);

            const due = computeDueNotifications(perChallengeActions, now, config);
            const fresh = dedupe.filterNew(due);
            const notification = formatNotification(fresh, translate);
            if (notification) deliver(notification);
        } catch (error) {
            // Self-contained: swallow so a decision/IPC failure can neither reach
            // the scheduler nor vanish without a trace (mirrors nodeNotify.js).
            logCycleFailure(log, error);
        } finally {
            running = false;
        }
    };
}

/**
 * Electron delivery: a Web Notification (renders as a native OS toast, and
 * still fires while the page is backgrounded). Clicking it focuses the app
 * window so the user can act.
 *
 * Permission: if the OS-level permission was denied, `new Notification` is a
 * silent no-op, so skip and (on the first undecided state) request it, letting
 * later cycles deliver once granted. Best-effort throughout — any throw
 * (notifications unavailable) is swallowed so it can never reach the scheduler.
 *
 * @param {{title:string, body:string}} notification
 */
export function deliverElectronNotification({ title, body }) {
    try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'denied') return;
        if (Notification.permission === 'default') {
            // Ask once (async, fire-and-forget). Electron's file:// origin usually
            // auto-grants, but request explicitly for platforms where it does not;
            // subsequent cycles then deliver.
            try {
                void Notification.requestPermission?.();
            } catch {
                /* requestPermission unavailable — fall through and still try */
            }
        }
        const toast = new Notification(title, { body });
        toast.onclick = () => {
            try {
                window.focus?.();
            } catch {
                /* focus is best-effort */
            }
        };
    } catch {
        /* OS notifications unavailable/blocked — nothing else to do */
    }
}

/**
 * Pick the renderer delivery function for the current platform. Electron gets
 * the Web Notification deliverer; native Android gets `null`, the caller's
 * signal NOT to wire the notifier at all (the native service is authoritative
 * there — see the file header). Extracted + exported so the platform decision
 * is unit-testable rather than an inline ternary a future edit could invert.
 *
 * @param {boolean} isNativePlatform
 * @returns {((n:{title:string, body:string})=>void) | null}
 */
export function resolveRendererDelivery(isNativePlatform) {
    return isNativePlatform ? null : deliverElectronNotification;
}
