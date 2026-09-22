import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useAutoClear } from '@/hooks/useAutoClear';
import { useKeyUnlock, useFillExposure } from '@/api/useCurrencyActions';
import { interp } from '@/utils/interp';
import { CurrencyConfirmModal, currencyOutcomeText } from './CurrencyConfirmModal';

const ERROR_DISPLAY_MS = 5000;

/**
 * Card-cell button that spends one unit of a bankroll currency on the
 * challenge (key unlock in the Boost cell, exposure fill in the Exposure cell).
 * Opens a confirm modal first; nothing is spent until Spend is pressed.
 *
 * @param {object} props
 * @param {string} props.label - button text
 * @param {string} props.icon
 * @param {'keys'|'fills'} props.field - which balance this spends
 * @param {object|null} props.bankroll
 * @param {string} props.title - confirm modal title
 * @param {string} props.body - confirm modal explanation
 * @param {{run: function, loading: boolean, error: string|null, clearError: function}} props.action
 * @param {string|number} props.challengeId
 * @param {boolean} props.disabled
 * @param {function} [props.onSpent] - called after a successful spend (refetch balances + challenges)
 */
function CurrencyActionButton({ label, icon, field, bankroll, title, body, action, challengeId, disabled, onSpent }) {
    const { t } = useTranslation();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const { run, loading, error, clearError } = action;

    useAutoClear(error, clearError, ERROR_DISPLAY_MS);

    const handleConfirm = async () => {
        const result = await run(challengeId);
        setConfirmOpen(false);
        // A not-available outcome also means the card is stale — refresh it.
        if ((result?.success || result?.outcome === 'not-available') && onSpent) onSpent();
    };

    return (
        <>
            <button
                className={`btn btn-xs mt-1 ${error ? 'btn-error' : 'btn-accent'}`}
                onClick={() => setConfirmOpen(true)}
                disabled={disabled || loading}
            >
                {loading ? (
                    <span className="loading loading-spinner loading-xs" />
                ) : (
                    <>
                        {icon} {label}
                    </>
                )}
            </button>
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
const CELL_ACTIONS = {
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
 *
 * @param {{kind: 'key'|'fill', challenge: object, bankroll: object|null, disabled: boolean, onSpent?: function}} props
 */
export function CurrencyCellButton({ kind, challenge, bankroll, disabled, onSpent }) {
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
            disabled={disabled}
            onSpent={onSpent}
        />
    );
}
