import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useMemberChallenges } from '@/api/useMemberChallenges';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { interp } from '@/utils/interp';
import * as ipc from '@/api/ipc';

// Map a join outcome status to a translated, colored inline message. Distinct
// wording for the money-critical "charged but not joined" case, which also
// surfaces a resume-submit action (see below).
const OUTCOME = {
    joined: { key: 'app.discoverJoined', variant: 'success' },
    'skipped-unaffordable': { key: 'app.discoverUnaffordable', variant: 'warning' },
    'balance-unknown': { key: 'app.discoverBalanceUnknown', variant: 'warning' },
    'charged-pending-submit': { key: 'app.discoverChargedPending', variant: 'error' },
    'failed-no-charge': { key: 'app.discoverFailedNoCharge', variant: 'error' },
    'skipped-no-photo': { key: 'app.discoverNoPhoto', variant: 'warning' },
    unavailable: { key: 'app.discoverUnavailable', variant: 'neutral' },
    busy: { key: 'app.discoverBusy', variant: 'neutral' },
};

// Static (purge-safe) text color per outcome variant — never build Tailwind
// class names dynamically, the JIT can't see them.
const TEXT_CLASS = {
    success: 'text-success',
    warning: 'text-warning',
    error: 'text-error',
    neutral: 'text-base-content/60',
};

const costOf = (c) => {
    const n = Number(c?.join_coins);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Discover / un-joined challenges list with per-challenge Join buttons. Free
 * joins run immediately; paid joins open a confirm modal that shows the cost and
 * the current → resulting coin balance before spending. After any join that
 * changes state, refetches the list and calls onJoined so the header bankroll
 * (and active challenges) refresh.
 *
 * @param {{ isLoggedIn: boolean, bankroll: object|null, onJoined: function }} props
 */
export function DiscoverSection({ isLoggedIn, bankroll, onJoined }) {
    const { t } = useTranslation();
    const { items, loading, error, refetch } = useMemberChallenges();
    const [confirm, setConfirm] = useState(null); // challenge pending paid confirmation
    const [busyId, setBusyId] = useState(null);
    const [results, setResults] = useState({}); // id -> outcome result

    const doJoin = useCallback(
        async (challenge, spendCoins) => {
            const id = challenge?.id;
            setBusyId(id);
            try {
                const res = await ipc.joinChallenge(id, spendCoins);
                setResults((prev) => ({ ...prev, [id]: res }));
                // Refetch on any outcome that changes what's joinable (joined,
                // coins charged, or the challenge is gone) so a stale row/button
                // doesn't linger. Refresh balances only when coins moved.
                const gone = res?.success || res?.status === 'charged-pending-submit' || res?.status === 'unavailable';
                if (gone) refetch();
                if (res?.success || res?.status === 'charged-pending-submit') onJoined();
                return res;
            } catch (err) {
                setResults((prev) => ({ ...prev, [id]: { status: 'failed-no-charge', error: err?.message } }));
                return { success: false };
            } finally {
                setBusyId(null);
            }
        },
        [refetch, onJoined],
    );

    const onJoinClick = useCallback(
        (challenge) => {
            if (costOf(challenge) > 0) {
                setConfirm(challenge);
            } else {
                doJoin(challenge, false);
            }
        },
        [doJoin],
    );

    const onConfirm = useCallback(async () => {
        const challenge = confirm;
        setConfirm(null);
        // Only reachable from the modal's Spend button, which renders only
        // while a challenge is pending confirmation.
        await doJoin(challenge, true);
    }, [confirm, doJoin]);

    if (!isLoggedIn) return null;

    // useMemberChallenges guarantees an array.
    const list = items;

    return (
        <>
            <details
                className="collapse collapse-arrow rounded-lg border border-base-300 bg-base-100 mb-3"
                data-testid="discover-section"
            >
                {/* pe-10 keeps clearance for DaisyUI's collapse-arrow (its
                    padding-inline-end:3rem is otherwise overridden by utilities). */}
                <summary className="collapse-title min-h-0 flex items-center gap-2 py-2 ps-3 pe-10 text-sm font-semibold">
                    {/* h2 (not span) keeps the section discoverable by heading nav. */}
                    <h2 className="m-0 text-sm font-semibold">{t('app.discoverTitle')}</h2>
                    {list.length > 0 && (
                        <span className="badge badge-neutral badge-sm" aria-label={t('app.discoverCountLabel')}>
                            {list.length}
                        </span>
                    )}
                    {/* Surface a fetch failure even while collapsed — otherwise a
                        failed load looks identical to "no open challenges". */}
                    {error && (
                        <span className="badge badge-error badge-sm" title={t('app.discoverUnavailableList')}>
                            !
                        </span>
                    )}
                </summary>
                <div className="collapse-content px-3 pb-3">
                    <div className="flex justify-end mb-2">
                        <button className="btn btn-ghost btn-xs" onClick={() => refetch()} disabled={loading}>
                            {t('app.discoverRefresh')}
                        </button>
                    </div>

                    {loading && list.length === 0 ? (
                        <InlineLoader />
                    ) : error ? (
                        <p className="text-sm text-error">{t('app.discoverUnavailableList')}</p>
                    ) : list.length === 0 ? (
                        <p className="text-sm text-base-content/60">{t('app.discoverEmpty')}</p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {list.map((c) => {
                                const cost = costOf(c);
                                const outcome = results[c.id];
                                // Any result without a mapped status (auth-expiry, an
                                // unexpected handler error) still shows a message rather
                                // than failing silently on a money-adjacent action.
                                const meta = outcome
                                    ? OUTCOME[outcome.status] || { key: null, variant: 'error' }
                                    : null;
                                const isBusy = busyId === c.id;
                                return (
                                    <li
                                        key={c.id}
                                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-base-200 px-2 py-1.5"
                                    >
                                        <div className="min-w-0">
                                            <div className="truncate font-medium">
                                                {c.title || c.url || t('app.discoverUntitled')}
                                            </div>
                                            <div className="flex items-center gap-2 text-xs text-base-content/60">
                                                {c.type && (
                                                    <StatusBadge variant="ghost" size="xs">
                                                        {c.type}
                                                    </StatusBadge>
                                                )}
                                                <span>
                                                    {cost > 0
                                                        ? interp(t('app.discoverCostPaid'), { coins: cost })
                                                        : t('app.discoverCostFree')}
                                                </span>
                                            </div>
                                            {meta && (
                                                <div className={`text-xs mt-0.5 ${TEXT_CLASS[meta.variant]}`}>
                                                    {meta.key
                                                        ? interp(t(meta.key), {
                                                              coins: outcome.cost ?? cost,
                                                              have: outcome.coins,
                                                          })
                                                        : outcome.error || t('app.discoverGenericError')}
                                                    {outcome.status === 'charged-pending-submit' && (
                                                        <button
                                                            className="btn btn-ghost btn-xs ml-2"
                                                            onClick={() => doJoin(c, true)}
                                                            disabled={isBusy}
                                                        >
                                                            {t('app.discoverRetrySubmit')}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <button
                                            className={`btn btn-sm ${cost > 0 ? 'btn-warning' : 'btn-primary'}`}
                                            onClick={() => onJoinClick(c)}
                                            disabled={isBusy}
                                        >
                                            {isBusy
                                                ? t('app.discoverJoining')
                                                : cost > 0
                                                  ? t('app.discoverJoinPaid')
                                                  : t('app.discoverJoin')}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </details>

            {/* Paid-join confirmation: names the challenge, the cost, and the
                current → resulting coin balance before any coins are spent. */}
            <Modal isOpen={!!confirm} onClose={() => setConfirm(null)} title={t('app.discoverConfirmTitle')}>
                {(() => {
                    if (!confirm) return null;
                    const cCost = costOf(confirm);
                    const coins = bankroll?.coins;
                    const known = Number.isFinite(coins);
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
                                <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
                                    {t('app.cancel')}
                                </button>
                                <button className="btn btn-warning btn-sm" onClick={onConfirm} disabled={insufficient}>
                                    {interp(t('app.discoverConfirmSpend'), { coins: cCost })}
                                </button>
                            </ModalActions>
                        </>
                    );
                })()}
            </Modal>
        </>
    );
}
