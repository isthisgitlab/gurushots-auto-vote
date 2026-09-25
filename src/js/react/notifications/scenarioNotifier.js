/**
 * Renderer-side scenario notifier: the notices a user's scenarios left
 * (services/scenarioNotifications.js holds the logic), read over the
 * get-scenario-status IPC channel and delivered like the deadline
 * notifications. Wired only where deadlineNotifier is — the desktop app; on
 * native Android the caller leaves it out for the same dual-loop reason (see
 * deadlineNotifier.js).
 */

import { createScenarioNotifier } from '../../services/scenarioNotifications';

/**
 * @param {Object} deps
 * @param {(key:string)=>Promise<any>} deps.getSetting - the getGlobalDefault IPC
 * @param {(challengeId:unknown)=>Promise<any>} deps.getScenarioStatus - the getScenarioStatus IPC
 * @param {(key:string)=>string} deps.translate
 * @param {(n:{title:string, body:string})=>void} deps.deliver
 * @param {(message:string)=>void} [deps.log]
 * @returns {(challenges:Array)=>Promise<void>}
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
