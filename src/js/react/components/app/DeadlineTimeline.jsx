import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { useTick } from '@/hooks/useTick';

// Action key → translation key for its display label.
const ACTION_LABEL_KEY = {
    autoFill: 'app.deadlineActionAutoFill',
    boost: 'app.deadlineActionBoost',
    turbo: 'app.deadlineActionTurbo',
    emergencyFill: 'app.deadlineActionEmergencyFill',
};

/**
 * Per-card advisory timeline of the automation's upcoming deadline actions.
 * `actions` come from useDeadlineActions (get-deadline-actions IPC); each has an
 * absolute `dueAt` (epoch seconds) already gated to the actions that will really
 * fire. Renders nothing when the list is empty (matching BoostWindowBanner's
 * contract).
 *
 * The times are ADVISORY: the entry count is read at compute time and can drift
 * as auto-fill adds entries mid-cycle, so every duration is `~`-prefixed and the
 * header carries an "approximate" note. In compact mode this collapses to a
 * single "next action" line to respect the card's density control.
 */
export function DeadlineTimeline({ actions, compact = false }) {
    const { t } = useTranslation();
    const hasRows = Array.isArray(actions) && actions.length > 0;
    // Only tick while there's something to count down.
    const now = useTick(1000, hasRows);
    if (!hasRows) return null;

    const rows = actions.filter((a) => typeof a.dueAt === 'number').map((a) => ({ ...a, remaining: a.dueAt - now }));
    if (rows.length === 0) return null;

    const labelFor = (action) => t(ACTION_LABEL_KEY[action] || action);
    const remainingText = (remaining) => (remaining > 0 ? `~${formatDuration(remaining)}` : t('app.deadlineDue'));

    if (compact) {
        const next = rows.filter((r) => r.remaining > 0).sort((a, b) => a.remaining - b.remaining)[0] || rows[0];
        return (
            <div className="text-xs text-base-content/70" title={t('app.deadlineTimelineApprox')}>
                ⏳ {t('app.deadlineNext')}: {labelFor(next.action)} {remainingText(next.remaining)}
            </div>
        );
    }

    return (
        <div className="bg-base-200 rounded p-2">
            <div className="text-xs font-medium mb-1">
                ⏳ {t('app.deadlineTimeline')}{' '}
                <span className="font-normal text-base-content/60">({t('app.deadlineTimelineApprox')})</span>
            </div>
            <ul className="text-xs space-y-0.5">
                {rows.map((r) => (
                    <li key={r.action} className="flex justify-between gap-2">
                        <span>{labelFor(r.action)}</span>
                        <span className="text-base-content/70">{remainingText(r.remaining)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
