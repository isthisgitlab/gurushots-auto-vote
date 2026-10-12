import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { costOf } from '@/utils/discoverCost';
import { interp } from '@/utils/interp';

import type { Bankroll, OpenChallenge } from '../../../types/gurushots';

/**
 * Paid-join confirmation: names the challenge, the cost, and the current → resulting coin balance before any coins
 * are spent.
 *
 * @param confirm - the challenge waiting for confirmation; null keeps the dialog closed
 */
export function JoinConfirmModal({
    confirm,
    bankroll,
    onConfirm,
    dismiss,
}: {
    confirm: OpenChallenge | null;
    bankroll: Bankroll | null;
    onConfirm: () => void | Promise<void>;
    dismiss: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Modal isOpen={!!confirm} onClose={dismiss} title={t('app.discoverConfirmTitle')}>
            {(() => {
                if (!confirm) return null;
                const cCost = costOf(confirm);
                const coins = bankroll?.coins;
                const known = typeof coins === 'number' && Number.isFinite(coins);
                // Block the spend when we know the balance is short (server
                // rejects it too, but never show a negative "resulting" or an
                // enabled Spend button that can only fail).
                const insufficient = known && coins < cCost;
                return (
                    <>
                        <div className="space-y-2 text-sm">
                            <p>
                                {interp(t('app.discoverConfirmBody'), {
                                    title: confirm.title || confirm.url,
                                    coins: cCost,
                                })}
                            </p>
                            {confirm.chosenEffectiveCount > 0 && (
                                <p className="text-base-content/70">{t('app.discoverConfirmChosen')}</p>
                            )}
                            <p className={insufficient ? 'text-error' : 'text-base-content/70'}>
                                {!known
                                    ? t('app.discoverConfirmBalanceUnknown')
                                    : insufficient
                                      ? interp(t('app.discoverConfirmInsufficient'), {
                                            current: coins,
                                            cost: cCost,
                                        })
                                      : interp(t('app.discoverConfirmBalance'), {
                                            current: coins,
                                            cost: cCost,
                                            resulting: coins - cCost,
                                        })}
                            </p>
                        </div>
                        <ModalActions>
                            <button className="btn btn-outline btn-sm" onClick={dismiss}>
                                {t('app.cancel')}
                            </button>
                            <button
                                className="btn btn-warning btn-sm"
                                onClick={() => void onConfirm()}
                                disabled={insufficient}
                            >
                                {interp(t('app.discoverConfirmSpend'), { coins: cCost })}
                            </button>
                        </ModalActions>
                    </>
                );
            })()}
        </Modal>
    );
}
