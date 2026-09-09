/**
 * Renderer-side driver for the deadline-action OS notifications.
 *
 * Injected into the shared cadence chain (AutovoteContext) as its per-cycle
 * onCycleChallenges hook. It owns NONE of the decision logic — that is the pure
 * services/deadlineNotifications.js, safe in this bundle — and only bridges the
 * renderer's IPC + platform delivery:
 *
 *   - config + per-challenge deadline actions come over window.api (the same
 *     get-deadline-actions channel the timeline already uses; no new channel);
 *   - delivery is platform-picked by the caller (Electron Web Notification).
 *
 * Fire-and-forget by contract: the chain calls this in its own isolated,
 * never-awaited wrapper, so a throw here cannot affect scheduling. We still
 * guard internally (re-entrancy + early-exit) so it is cheap and safe.
 *
 * DELIVERY SCOPE: today this is the SINGLE delivery source (Electron). On native
 * Android the app also runs a native foreground voting service; to avoid a
 * dual-loop double-fire we deliver from exactly one place. Native Android
 * delivery is intentionally NOT wired here yet (see docs/plan) — `deliver` is a
 * no-op there. If a native notifier is ever added, this renderer path MUST be
 * gated off on native Android so the two never both fire.
 */

import {
    computeDueNotifications,
    createDedupe,
    formatNotification,
    readNotificationConfig,
} from '../../services/deadlineNotifications';

/**
 * Build the per-cycle notifier. Holds the dedupe Set + a re-entrancy flag, so
 * create ONE instance and reuse it across cycles (a fresh instance every cycle
 * would never dedupe).
 *
 * @param {Object} deps
 * @param {()=>Promise<Object>} deps.getSettings - window.api.getSettings
 * @param {(challenge:Object)=>Promise<{success:boolean, actions?:Array}>} deps.getDeadlineActions -
 *   window.api.getDeadlineActions (returns the {success, actions} wrapper — never throws)
 * @param {(key:string)=>string} deps.translate - returns a raw i18n template
 * @param {(n:{title:string, body:string})=>void} deps.deliver - platform delivery
 * @returns {(challenges:Array, now:number)=>Promise<void>}
 */
export function createDeadlineNotifier({ getSettings, getDeadlineActions, translate, deliver }) {
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

            const list = Array.isArray(challenges) ? challenges : [];
            const perChallengeActions = [];
            for (const challenge of list) {
                // get-deadline-actions returns {success, actions} | {success:false};
                // it never throws. Skip anything that didn't resolve cleanly.
                const res = await getDeadlineActions(challenge);
                if (!res || res.success !== true || !Array.isArray(res.actions)) continue;
                perChallengeActions.push({ id: challenge?.id, title: challenge?.title, actions: res.actions });
            }

            const due = computeDueNotifications(perChallengeActions, now, config);
            const fresh = dedupe.filterNew(due);
            const notification = formatNotification(fresh, translate);
            if (notification) deliver(notification);
        } finally {
            running = false;
        }
    };
}

/**
 * Electron delivery: a Web Notification (renders as a native OS toast, and
 * still fires while the page is backgrounded). Clicking it focuses the app
 * window so the user can act. Best-effort — a throw (notifications disabled at
 * the OS level) is swallowed so it can never reach the scheduler.
 *
 * @param {{title:string, body:string}} notification
 */
export function deliverElectronNotification({ title, body }) {
    try {
        if (typeof Notification === 'undefined') return;
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

/** No-op delivery for platforms not yet wired (native Android — see file header). */
export function deliverNoop() {}
