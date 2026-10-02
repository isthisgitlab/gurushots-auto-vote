import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useAutoClear } from '@/hooks/useAutoClear';
import { useKeyUnlock, useFillExposure } from '@/api/useCurrencyActions';
import { interp } from '@/utils/interp';
import { spentOrStale } from '@/utils/spentOrStale';
import { ActionButton } from '@/components/ui/ActionButton';
import { CurrencyConfirmModal, currencyOutcomeText } from './CurrencyConfirmModal';

import type { Bankroll, Challenge } from '../../../types/gurushots';

/**
 * A bankroll spend hook's state envelope (useKeyUnlock / useFillExposure).
 */
type CurrencySpendAction = ReturnType<typeof useKeyUnlock>;

const ERROR_DISPLAY_MS = 5000;

/**
 * Card-cell button that spends one unit of a bankroll currency on the
 * challenge (key unlock in the Boost cell, exposure fill in the Exposure cell).
 * Opens a confirm modal first; nothing is spent until Spend is pressed.
 *
 * @param props.label - button text
 * @param props.field - which balance this spends
 * @param props.title - confirm modal title
 * @param props.body - confirm modal explanation
 * @param props.onSpent - called after a successful spend (refetch balances + challenges)
 */
function CurrencyActionButton({
    label,
    icon,
    field,
    bankroll,
    title,
    body,
    action,
    challengeId,
    onSpent,
}: {
    label: string;
    icon: string;
    field: 'keys' | 'fills';
    bankroll: Bankroll | null;
    title: string;
    body: string;
    action: CurrencySpendAction;
    challengeId: Challenge['id'];
    onSpent?: () => void;
}) {
    const { t } = useTranslation();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const { run, loading, error, clearError } = action;

    useAutoClear(error, clearError, ERROR_DISPLAY_MS);

    const handleConfirm = async () => {
        const result = await run(challengeId);
        setConfirmOpen(false);
        if (spentOrStale(result) && onSpent) onSpent();
    };

    return (
        <>
            <ActionButton
                variant="accent"
                error={error}
                className="mt-1"
                onClick={() => setConfirmOpen(true)}
                disabled={loading}
            >
                {loading ? (
                    <span className="loading loading-spinner loading-xs" />
                ) : (
                    <>
                        {icon} {label}
                    </>
                )}
            </ActionButton>
            {error && (
                <div className="text-error text-xs mt-1" role="alert">
                    {currencyOutcomeText(t, error)}
                </div>
            )}
            <CurrencyConfirmModal
                isOpen={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                onConfirm={handleConfirm}
                title={title}
                field={field}
                bankroll={bankroll}
                spending={loading}
            >
                <p>{body}</p>
            </CurrencyConfirmModal>
        </>
    );
}

// Per-cell wiring: which hook spends, which balance it draws on, and the
// translation keys for the button and its confirm modal.
const CELL_ACTIONS: Record<
    'key' | 'fill',
    {
        useAction: () => CurrencySpendAction;
        icon: string;
        field: 'keys' | 'fills';
        label: string;
        title: string;
        body: string;
    }
> = {
    key: {
        useAction: useKeyUnlock,
        icon: '🔑',
        field: 'keys',
        label: 'app.currencyKeyUnlock',
        title: 'app.currencyKeyUnlockTitle',
        body: 'app.currencyKeyUnlockBody',
    },
    fill: {
        useAction: useFillExposure,
        icon: '📈',
        field: 'fills',
        label: 'app.currencyFillExposure',
        title: 'app.currencyFillExposureTitle',
        body: 'app.currencyFillExposureBody',
    },
};

/**
 * Stat-cell spend button: `kind="key"` unlocks the boost (Boost cell),
 * `kind="fill"` tops exposure up to 100% (Exposure cell). `kind` is fixed per
 * mounted instance, so the hook it selects is stable across renders.
 */
export function CurrencyCellButton({
    kind,
    challenge,
    bankroll,
    onSpent,
}: {
    kind: 'key' | 'fill';
    challenge: Challenge;
    bankroll: Bankroll | null;
    onSpent?: () => void;
}) {
    const { t } = useTranslation();
    const config = CELL_ACTIONS[kind];
    const action = config.useAction();
    return (
        <CurrencyActionButton
            label={t(config.label)}
            icon={config.icon}
            field={config.field}
            bankroll={bankroll}
            title={t(config.title)}
            body={interp(t(config.body), { title: challenge.title })}
            action={action}
            challengeId={challenge.id}
            onSpent={onSpent}
        />
    );
}
