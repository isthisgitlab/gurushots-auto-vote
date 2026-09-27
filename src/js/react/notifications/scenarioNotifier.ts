/**
 * Renderer-side scenario notifier: the notices a user's scenarios left
 * (services/scenarioNotifications.ts holds the logic), read over the
 * get-scenario-status IPC channel and delivered like the deadline
 * notifications. Wired only where deadlineNotifier is — the desktop app; on
 * native Android the caller leaves it out for the same dual-loop reason (see
 * deadlineNotifier.ts).
 */

import { createScenarioNotifier } from '../../services/scenarioNotifications';

import type { OutboxItem } from '../../services/scenarioNotifications';
import type { Challenge } from '../../types/gurushots';

/**
 * @param deps.getSetting - the getGlobalDefault IPC
 * @param deps.getScenarioStatus -
 *   the getScenarioStatus IPC
 */
export function createRendererScenarioNotifier({
    getSetting,
    getScenarioStatus,
    translate,
    deliver,
    log,
}: {
    getSetting: (key: string) => Promise<unknown>;
    getScenarioStatus: (
        challengeId: Challenge['id'],
    ) => Promise<{ success: boolean; state?: { outbox?: OutboxItem[] } | null } | null | undefined>;
    translate: (key: string) => string;
    deliver: (n: { title: string; body: string }) => void;
    log?: (message: string) => void;
}): (challenges: readonly Challenge[]) => Promise<void> {
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
