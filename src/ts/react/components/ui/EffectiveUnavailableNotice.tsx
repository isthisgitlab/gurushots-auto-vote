import { useTranslation } from '@/contexts/TranslationContext';

/**
 * The inline warning for a value of the running scenario that cannot be read now: what happened, why, and what happens next.
 * The window keeps what it painted last. Nothing is shown when every value can be read.
 *
 * @param props.reasons - why each unreadable value cannot be read (empty: nothing to show)
 */
export function EffectiveUnavailableNotice({ reasons }: { reasons: readonly string[] }) {
    const { t } = useTranslation();
    if (reasons.length === 0) return null;
    return (
        <div role="status" className="alert alert-warning mb-4 text-sm items-start">
            <div className="flex-1 space-y-1">
                <p className="font-semibold">{t('app.effectiveUnavailableTitle')}</p>
                <p>{t('app.effectiveUnavailableDetail')}</p>
                <p>{t('app.effectiveUnavailableReason', { reason: reasons.join(', ') })}</p>
            </div>
        </div>
    );
}
