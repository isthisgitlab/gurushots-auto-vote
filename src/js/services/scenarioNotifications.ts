/**
 * OS notifications for user-defined scenarios: the notices a scenario's
 * `notify` action (and a halt) leave in the challenge's scenario state
 * outbox (services/scenarioRunner.ts), delivered by the host's per-cycle
 * notifier — the CLI scheduler (services/notify/nodeNotify.ts) and the
 * desktop renderer (react/notifications/scenarioNotifier.js), alongside the
 * deadline notifications and through the same transports.
 *
 * Pure (no settings, no I/O), so the renderer bundle can carry it. A host
 * shows only notices created after it started, each once: a restart never
 * replays old ones.
 */

import { sanitizeNotificationText, interpolate } from './deadlineNotifications';

import type { Challenge } from '../types/gurushots';

/** Longest notification body; a scenario notice is itself capped at 120 characters. */
const MAX_BODY = 240;

export type OutboxItem = { id?: unknown; at?: unknown; message?: unknown };

type ChallengeOutbox = { challengeId: unknown; challengeTitle: string; outbox: OutboxItem[] };

/**
 * Remembers which notices were shown. Keys of notices that left every outbox
 * are forgotten, so the set stays bounded over a long session.
 *
 * @param startedAt - unix seconds; older notices are never shown
 */
const createNoticeTracker = (startedAt: number) => {
    const shown: Set<string> = new Set();
    return {
        fresh(outboxes: ChallengeOutbox[]): Array<{ challengeTitle: string; message: string }> {
            const present = new Set<string>();
            const notices = [];
            for (const { challengeId, challengeTitle, outbox } of outboxes) {
                for (const item of outbox) {
                    const key = `${challengeId}:${item?.id}`;
                    present.add(key);
                    if (typeof item?.message !== 'string' || !(Number(item.at) >= startedAt) || shown.has(key))
                        continue;
                    shown.add(key);
                    notices.push({ challengeTitle, message: item.message });
                }
            }
            for (const key of shown) if (!present.has(key)) shown.delete(key);
            return notices;
        },
    };
};

/**
 * One OS notification for this cycle's new notices — several coalesce into one.
 *
 * @param translate - returns a raw template
 */
const formatScenarioNotification = (
    notices: Array<{ challengeTitle: string; message: string }>,
    translate: (key: string) => string,
): { title: string; body: string } | null => {
    if (notices.length === 0) return null;
    if (notices.length === 1) {
        const [notice] = notices;
        return {
            title: sanitizeNotificationText(
                interpolate(translate('app.scenarioNotifyTitle'), { title: notice.challengeTitle }),
            ),
            body: sanitizeNotificationText(notice.message, MAX_BODY),
        };
    }
    return {
        title: sanitizeNotificationText(
            interpolate(translate('app.scenarioNotifyGroupTitle'), { count: notices.length }),
        ),
        body: sanitizeNotificationText(notices.map((n) => `${n.challengeTitle}: ${n.message}`).join(' · '), MAX_BODY),
    };
};

/**
 * The per-cycle scenario notifier a host injects as (part of) the cadence
 * chain's onCycleChallenges hook. Create ONE per host and reuse it. Never
 * throws; a failure goes to `log`.
 *
 * @param deps.isEnabled - the notifyOnScenario setting
 * @param deps.startedAt - unix seconds (default: now)
 */
const createScenarioNotifier = ({
    isEnabled,
    readOutbox,
    translate,
    deliver,
    log,
    startedAt,
}: {
    isEnabled: () => boolean | Promise<boolean>;
    readOutbox: (challenge: Challenge) => OutboxItem[] | null | undefined | Promise<OutboxItem[] | null | undefined>;
    translate: (key: string) => string;
    deliver: (n: { title: string; body: string }) => void;
    log?: (message: string) => void;
    startedAt?: number;
}): ((challenges: readonly Challenge[]) => Promise<void>) => {
    const tracker = createNoticeTracker(startedAt ?? Math.floor(Date.now() / 1000));
    let running = false;
    return async (challenges) => {
        if (running) return;
        running = true;
        try {
            if (!(await isEnabled())) return;
            const outboxes: ChallengeOutbox[] = [];
            for (const challenge of challenges) {
                const outbox = await readOutbox(challenge);
                if (Array.isArray(outbox) && outbox.length) {
                    outboxes.push({
                        challengeId: challenge.id,
                        challengeTitle: challenge.title || `challenge ${challenge.id}`,
                        outbox,
                    });
                }
            }
            const notification = formatScenarioNotification(tracker.fresh(outboxes), translate);
            if (notification) deliver(notification);
        } catch (error) {
            try {
                log?.(
                    `scenario notification cycle failed: ${(error as { message?: unknown } | null | undefined)?.message ?? error}`,
                );
            } catch {
                /* the diagnostic sink itself is best-effort */
            }
        } finally {
            running = false;
        }
    };
};

export { createNoticeTracker, formatScenarioNotification, createScenarioNotifier };
