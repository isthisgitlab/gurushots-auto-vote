import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

import type { EffectOutcome } from '@/api/ipc';

// The sentence under the title, by what the change stands at and what the last status check found.
const TITLE_KEYS = { unclear: 'app.effectUnclear', queued: 'app.effectQueued', waiting: 'app.effectWaiting' } as const;
const DETAIL_KEYS = {
    unclear: 'app.effectUnclearDetail',
    queued: 'app.effectQueuedDetail',
    waiting: 'app.effectWaitingDetail',
} as const;
const CHECKED_KEYS = { 'not-recorded': 'app.effectNotRecorded', unreadable: 'app.effectUnreadable' } as const;

/**
 * The notice for a change that has no final result: the reply was lost ("We could not confirm the change"), or an Android
 * service has it queued ("Waiting for the background service"). A change with an identity can be checked by it
 * (Check status); the identity is kept until the host records a final result, and nothing is sent again. Use it with the
 * `outcome`, `checkStatus` and `dismissOutcome` of useAsyncIpcAction.
 *
 * @param props.outcome - what the hook left open (null: nothing is shown)
 * @param props.onCheck - the hook's checkStatus
 * @param props.onDismiss - the hook's dismissOutcome (the user gives the change up)
 */
export function EffectOutcomeNotice({
    outcome,
    onCheck,
    onDismiss,
}: {
    outcome: EffectOutcome | null;
    onCheck: () => Promise<boolean>;
    onDismiss: () => void;
}) {
    const { t } = useTranslation();
    const [checking, setChecking] = useState(false);
    if (outcome === null) return null;
    return (
        <div role="status" className="alert alert-warning mb-4 text-sm items-start">
            <div className="flex-1 space-y-1">
                <p className="font-semibold">{t(TITLE_KEYS[outcome.kind])}</p>
                <p>{t(DETAIL_KEYS[outcome.kind])}</p>
                {outcome.checked !== null && <p>{t(CHECKED_KEYS[outcome.checked])}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
                {outcome.requestId !== null && (
                    <button
                        type="button"
                        className="btn btn-sm max-sm:min-h-10"
                        disabled={checking}
                        onClick={() => {
                            setChecking(true);
                            void onCheck().finally(() => setChecking(false));
                        }}
                    >
                        {t('app.effectCheckStatus')}
                    </button>
                )}
                <button type="button" className="btn btn-sm btn-ghost max-sm:min-h-10" onClick={onDismiss}>
                    {t('errors.dismiss')}
                </button>
            </div>
        </div>
    );
}
