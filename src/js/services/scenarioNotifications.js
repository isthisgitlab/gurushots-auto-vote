// @ts-check
/**
 * OS notifications for user-defined scenarios: the notices a scenario's
 * `notify` action (and a halt) leave in the challenge's scenario state
 * outbox (services/scenarioRunner.js), delivered by the host's per-cycle
 * notifier — the CLI scheduler (services/notify/nodeNotify.js) and the
 * desktop renderer (react/notifications/scenarioNotifier.js), alongside the
 * deadline notifications and through the same transports.
 *
 * Pure (no settings, no I/O), so the renderer bundle can carry it. A host
 * shows only notices created after it started, each once: a restart never
 * replays old ones.
 */

const { sanitizeNotificationText, interpolate } = require('./deadlineNotifications');

/** Longest notification body; a scenario notice is itself capped at 120 characters. */
const MAX_BODY = 240;

/**
 * @typedef {{id?: unknown, at?: unknown, message?: unknown}} OutboxItem
 * @typedef {{challengeId: unknown, challengeTitle: string, outbox: OutboxItem[]}} ChallengeOutbox
 */

/**
 * Remembers which notices were shown. Keys of notices that left every outbox
 * are forgotten, so the set stays bounded over a long session.
 *
 * @param {number} startedAt - unix seconds; older notices are never shown
 */
const createNoticeTracker = (startedAt) => {
    /** @type {Set<string>} */
    const shown = new Set();
    return {
        /**
         * @param {ChallengeOutbox[]} outboxes
         * @returns {Array<{challengeTitle: string, message: string}>}
         */
        fresh(outboxes) {
            const present = new Set();
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
 * @param {Array<{challengeTitle: string, message: string}>} notices
 * @param {(key: string) => string} translate - returns a raw template
 * @returns {{title: string, body: string}|null}
 */
const formatScenarioNotification = (notices, translate) => {
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
 * @param {object} deps
 * @param {() => boolean|Promise<boolean>} deps.isEnabled - the notifyOnScenario setting
 * @param {(challenge: any) => OutboxItem[]|null|undefined|Promise<OutboxItem[]|null|undefined>} deps.readOutbox
 * @param {(key: string) => string} deps.translate
 * @param {(n: {title: string, body: string}) => void} deps.deliver
 * @param {(message: string) => void} [deps.log]
 * @param {number} [deps.startedAt] - unix seconds (default: now)
 * @returns {(challenges: any) => Promise<void>}
 */
const createScenarioNotifier = ({ isEnabled, readOutbox, translate, deliver, log, startedAt }) => {
    const tracker = createNoticeTracker(startedAt ?? Math.floor(Date.now() / 1000));
    let running = false;
    return async (challenges) => {
        if (running) return;
        running = true;
        try {
            if (!(await isEnabled())) return;
            /** @type {ChallengeOutbox[]} */
            const outboxes = [];
            for (const challenge of Array.isArray(challenges) ? challenges : []) {
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
                log?.(`scenario notification cycle failed: ${/** @type {any} */ (error)?.message ?? error}`);
            } catch {
                /* the diagnostic sink itself is best-effort */
            }
        } finally {
            running = false;
        }
    };
};

module.exports = { createNoticeTracker, formatScenarioNotification, createScenarioNotifier };
