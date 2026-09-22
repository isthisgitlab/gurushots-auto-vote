import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { interp } from '@/utils/interp';

// Outcome code (voting/currencyActions CURRENCY_OUTCOME) → translated message.
// Anything unmapped (auth failure, unexpected string) reads as a generic
// rejection — never a raw code or status in front of the user.
const OUTCOME_KEY = {
    'not-available': 'app.currencyOutcomeNotAvailable',
    'no-balance': 'app.currencyOutcomeNoBalance',
    'balance-unknown': 'app.currencyOutcomeBalanceUnknown',
    'no-alternative': 'app.currencyOutcomeNoAlternative',
    'stale-candidate': 'app.currencyOutcomeStaleCandidate',
    busy: 'app.currencyOutcomeBusy',
};

/**
 * @param {function} t - translation function
 * @param {string|null} outcome - the failed action's outcome code
 * @returns {string}
 */
export const currencyOutcomeText = (t, outcome) => t(OUTCOME_KEY[outcome] || 'app.currencyOutcomeFailed');

// Bankroll field → [plural label (header pill), singular unit] translation keys.
const CURRENCY_LABELS = {
    keys: ['app.bankrollKeys', 'app.currencyUnitKeys'],
    swaps: ['app.bankrollSwaps', 'app.currencyUnitSwaps'],
    fills: ['app.bankrollFills', 'app.currencyUnitFills'],
};

/**
 * Confirmation before spending one unit of a bankroll currency. Shows the cost
 * and the current → resulting balance; Spend stays disabled with a spinner from
 * the first click until the spend settles, so a double click can't spend twice.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {function} props.onClose
 * @param {function} props.onConfirm
 * @param {string} props.title
 * @param {'keys'|'swaps'|'fills'} props.field - which balance this spends
 * @param {object|null} props.bankroll
 * @param {boolean} props.spending
 * @param {import('react').ReactNode} props.children - action-specific body
 */
export function CurrencyConfirmModal({ isOpen, onClose, onConfirm, title, field, bankroll, spending, children }) {
    const { t } = useTranslation();
    const [pluralKey, unitKey] = CURRENCY_LABELS[field];
    const currency = t(pluralKey);
    const unit = t(unitKey);
    const current = Number(bankroll?.[field]);
    const known = Number.isFinite(current);

    return (
        <Modal isOpen={isOpen} onClose={spending ? undefined : onClose} title={title} showCloseButton={!spending}>
            <div className="space-y-2 text-sm">
                {children}
                <p>{interp(t('app.currencyCost'), { unit })}</p>
                <p className="text-base-content/70">
                    {known
                        ? interp(t('app.currencyBalance'), { current, currency, resulting: Math.max(current - 1, 0) })
                        : interp(t('app.currencyBalanceUnknown'), { currency })}
                </p>
            </div>
            <ModalActions>
                <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={spending}>
                    {t('common.cancel')}
                </button>
                <button className="btn btn-warning btn-sm" onClick={onConfirm} disabled={spending}>
                    {spending ? (
                        <span className="loading loading-spinner loading-xs" />
                    ) : (
                        interp(t('app.currencySpend'), { unit })
                    )}
                </button>
            </ModalActions>
        </Modal>
    );
}
