/**
 * Renderer-side scenario notifier: the notices a user's scenarios left
 * (services/scenarioNotifications.js holds the logic), read over the
 * get-scenario-status IPC channel and delivered like the deadline
 * notifications. Wired only where deadlineNotifier is — the desktop app; on
 * native Android the caller leaves it out for the same dual-loop reason (see
 * deadlineNotifier.js).
 */

import { createScenarioNotifier } from '../../services/scenarioNotifications';

/** @import { OutboxItem } from '../../services/scenarioNotifications' */
/** @import { Challenge } from '../../types/gurushots' */

/**
 * @param {Object} deps
 * @param {(key:string)=>Promise<unknown>} deps.getSetting - the getGlobalDefault IPC
 * @param {(challengeId: Challenge['id'])=>Promise<{success: boolean, state?: {outbox?: OutboxItem[]} | null} | null | undefined>} deps.getScenarioStatus -
 *   the getScenarioStatus IPC
 * @param {(key:string)=>string} deps.translate
 * @param {(n:{title:string, body:string})=>void} deps.deliver
 * @param {(message:string)=>void} [deps.log]
 * @returns {(challenges:unknown)=>Promise<void>}
 */
export function createRendererScenarioNotifier({ getSetting, getScenarioStatus, translate, deliver, log }) {
    return createScenarioNotifier({
        isEnabled: async () => (await getSetting('notifyOnScenario')) !== false,
        readOutbox: async (challenge) => {
            const status = await getScenarioStatus(challenge.id);
            return status?.success ? status.state?.outbox : null;
        },
        translate,
        deliver,
        log,
    });
}
