import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useMemberChallenges } from '@/api/useMemberChallenges';
import { useOpenChosenAnnotations } from '@/api/useOpenChosenAnnotations';
import { useOnChosenPhotosCleared } from '@/api/chosenPhotosCleared';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { interp } from '@/utils/interp';
import * as ipc from '@/api/ipc';
import { ipcErrorText } from '@/api/ipcErrorText';
import { PhotoChooserModal } from './PhotoChooserModal';

import type { Bankroll, Challenge, OpenChallenge } from '../../../types/gurushots';
import { errorMessage } from '../../../errorMessage';

/**
 * What a join left behind for its row: the join-challenge result (either arm)
 * or the local stand-in when the call itself threw.
 */
export type JoinOutcome = { success?: boolean; status?: string; cost?: number; coins?: number; error?: string };

// Map a join outcome status to a translated, colored inline message. Distinct
// wording for the money-critical "charged but not joined" case, which also
// surfaces a resume-submit action (see below).
const OUTCOME: Record<string, { key: string; variant: keyof typeof TEXT_CLASS }> = {
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

const costOf = (c: Challenge) => {
    const n = Number(c?.join_coins);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/** What names a row for assistive technology: its title, else its address. */
const rowName = (c: Challenge, untitled: string): string => c.title || c.url || untitled;

/**
 * Marks a row that has a list of its own; clicking it reopens the chooser. A list
 * saved under another account (`foreignCount`, which the join does not use) is
 * counted instead of described as chosen photos.
 */
function ChosenChip({
    name,
    foreignCount,
    onClick,
}: {
    name: string;
    foreignCount: number | null;
    onClick: () => void;
}) {
    const { t } = useTranslation();
    const foreign = foreignCount !== null;
    const text = foreign
        ? interp(t('app.discoverChosenForeignChip'), { count: foreignCount })
        : t('app.discoverChosenChip');
    return (
        <button
            type="button"
            className="badge badge-info badge-sm mt-0.5"
            title={t(foreign ? 'app.discoverChosenForeignHint' : 'app.discoverChosenChipHint')}
            aria-label={interp(t(foreign ? 'app.discoverChosenForeignLabel' : 'app.discoverChosenChipLabel'), {
                title: name,
                count: foreignCount ?? 0,
            })}
            onClick={onClick}
        >
            {text}
        </button>
    );
}

/**
 * What a row says about chosen photos: the chip when it has a list of its own (a list
 * saved under another account is counted instead), else a line for one that reaches it
 * through a rule or the global default.
 */
function ChosenMarks({ c, name, onChoose }: { c: OpenChallenge; name: string; onChoose: () => void }) {
    const { t } = useTranslation();
    if (c.chosenOwnCount > 0) {
        return (
            <ChosenChip
                name={name}
                foreignCount={c.chosenEffectiveCount === 0 ? c.chosenOwnCount : null}
                onClick={onChoose}
            />
        );
    }
    if (c.chosenEffectiveCount === 0) return null;
    return (
        <div className="text-xs text-base-content/60 mt-0.5">
            {interp(t('app.discoverChosenInherited'), { count: c.chosenEffectiveCount })}
        </div>
    );
}

/**
 * A row's Join button, named by its challenge (and, when paid, its cost) for assistive
 * technology; while joining the visible text says so, so no static label contradicts it.
 */
function JoinButton({ name, cost, busy, onClick }: { name: string; cost: number; busy: boolean; onClick: () => void }) {
    const { t } = useTranslation();
    const paid = cost > 0;
    const label = interp(t(paid ? 'app.discoverJoinPaidLabel' : 'app.discoverJoinLabel'), { title: name, coins: cost });
    return (
        <button
            className={`btn btn-sm ${paid ? 'btn-warning' : 'btn-primary'}`}
            aria-label={busy ? undefined : label}
            onClick={onClick}
            disabled={busy}
        >
            {busy ? t('app.discoverJoining') : paid ? t('app.discoverJoinPaid') : t('app.discoverJoin')}
        </button>
    );
}

/**
 * The chooser for one row's own Chosen Photos list. An empty selection removes
 * the list so the row inherits again. The key gives each challenge a fresh open.
 */
function RowPhotoChooser({
    challenge,
    onClose,
    onSaved,
}: {
    challenge: OpenChallenge | null;
    onClose: () => void;
    onSaved: () => Promise<void>;
}) {
    // The row may have opened before the main process knew whose account this is, and then it came
    // without its ids. Once the chooser's listing has said, ask again: the ids come through if the
    // list is this account's, and not otherwise (null).
    const reloadSaved = async (): Promise<string[] | null> => {
        const id = String((challenge as Challenge).id);
        const result = await ipc.callOrNull(() => ipc.getOpenChosenAnnotations([id]));
        const annotation = result?.success ? result.annotations[id] : undefined;
        return annotation && annotation.chosenOwn.length === annotation.chosenOwnCount ? annotation.chosenOwn : null;
    };
    const save = async (ids: string[]): Promise<boolean> => {
        // Only reachable from the chooser, which renders only while a challenge is being chosen for.
        const id = String((challenge as Challenge).id);
        const saved = await ipc.callOrNull(() =>
            ids.length > 0
                ? ipc.setChallengeOverride('chosenPhotos', id, ids)
                : ipc.removeChallengeOverride('chosenPhotos', id),
        );
        if (saved !== true) return false;
        await onSaved();
        return true;
    };
    return (
        <PhotoChooserModal
            key={challenge?.id}
            isOpen={!!challenge}
            onClose={onClose}
            value={challenge?.chosenOwn ?? []}
            savedCount={challenge?.chosenOwnCount}
            challengeId={challenge?.id ?? null}
            clearMeansInherit
            reloadSaved={reloadSaved}
            onSave={save}
        />
    );
}

/**
 * Discover / un-joined challenges list with per-challenge Join buttons. Free
 * joins run immediately; paid joins open a confirm modal that shows the cost and
 * the current → resulting coin balance before spending. After any join that
 * changes state, refetches the list and calls onJoined so the header bankroll
 * (and active challenges) refresh. Each row can also hold a list of chosen
 * photos for that challenge alone: the join reads it before the challenge has
 * any other settings (see resolveJoinSetting).
 */
export function DiscoverSection({
    isLoggedIn,
    bankroll,
    onJoined,
}: {
    isLoggedIn: boolean;
    bankroll: Bankroll | null;
    onJoined: () => void;
}) {
    const { t } = useTranslation();
    const { items, loading, error, refetch } = useMemberChallenges();
    // The rows follow the settings without another trip to GuruShots: what the list carried is
    // only the starting point, the settings-only read replaces it as soon as it answers.
    const chosen = useOpenChosenAnnotations(items.map((c) => String(c.id)));
    useOnChosenPhotosCleared(() => void chosen.refetch());
    const [confirm, setConfirm] = useState<OpenChallenge | null>(null); // challenge pending paid confirmation
    const [choosing, setChoosing] = useState<OpenChallenge | null>(null); // challenge whose photos are being chosen
    const [busyId, setBusyId] = useState<Challenge['id'] | null>(null);
    const [results, setResults] = useState<Record<string, JoinOutcome>>({}); // id -> outcome result

    const doJoin = useCallback(
        async (challenge: OpenChallenge, spendCoins: boolean) => {
            const id = challenge?.id;
            setBusyId(id);
            try {
                const res: JoinOutcome = await ipc.joinChallenge(id, spendCoins);
                setResults((prev) => ({ ...prev, [id]: res }));
                // Refetch on any outcome that changes what's joinable (joined,
                // coins charged, or the challenge is gone) so a stale row/button
                // doesn't linger. Refresh balances only when coins moved.
                const gone = res?.success || res?.status === 'charged-pending-submit' || res?.status === 'unavailable';
                if (gone) void refetch();
                if (res?.success || res?.status === 'charged-pending-submit') onJoined();
                return res;
            } catch (err) {
                setResults((prev) => ({
                    ...prev,
                    [id]: {
                        status: 'failed-no-charge',
                        error: errorMessage(err),
                    },
                }));
                return { success: false };
            } finally {
                setBusyId(null);
            }
        },
        [refetch, onJoined],
    );

    const onJoinClick = useCallback(
        (challenge: OpenChallenge) => {
            if (costOf(challenge) > 0) {
                setConfirm(challenge);
            } else {
                void doJoin(challenge, false);
            }
        },
        [doJoin],
    );

    const onConfirm = useCallback(async () => {
        const challenge = confirm;
        setConfirm(null);
        // Only reachable from the modal's Spend button, which renders only
        // while a challenge is pending confirmation.
        await doJoin(challenge as OpenChallenge, true);
    }, [confirm, doJoin]);

    if (!isLoggedIn) return null;

    // useMemberChallenges guarantees an array.
    const list = items.map((c): OpenChallenge => ({ ...c, ...chosen.annotations[String(c.id)] }));

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
                        <span
                            className="badge badge-neutral badge-sm"
                            role="img"
                            aria-label={interp(t('app.discoverCountLabel'), { count: list.length })}
                        >
                            {list.length}
                        </span>
                    )}
                    {/* Surface a fetch failure even while collapsed — otherwise a
                        failed load looks identical to "no open challenges". */}
                    {error && (
                        <span
                            className="badge badge-error badge-sm"
                            role="img"
                            title={t('app.discoverUnavailableList')}
                            aria-label={t('app.discoverUnavailableList')}
                        >
                            !
                        </span>
                    )}
                </summary>
                <div className="collapse-content px-3 pb-3">
                    <div className="flex justify-end mb-2">
                        <button className="btn btn-outline btn-sm" onClick={() => void refetch()} disabled={loading}>
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
                                const meta: { key: string | null; variant: keyof typeof TEXT_CLASS } | null = outcome
                                    ? OUTCOME[outcome.status as string] || { key: null, variant: 'error' }
                                    : null;
                                const isBusy = busyId === c.id;
                                const name = rowName(c, t('app.discoverUntitled'));
                                return (
                                    <li
                                        key={c.id}
                                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-base-200 px-2 py-1.5"
                                    >
                                        <div className="min-w-0">
                                            <div className="truncate font-medium">{name}</div>
                                            <div className="flex items-center gap-2 text-xs text-base-content/60">
                                                {c.type && <StatusBadge variant="ghost">{c.type}</StatusBadge>}
                                                <span>
                                                    {cost > 0
                                                        ? interp(t('app.discoverCostPaid'), { coins: cost })
                                                        : t('app.discoverCostFree')}
                                                </span>
                                            </div>
                                            <ChosenMarks c={c} name={name} onChoose={() => setChoosing(c)} />
                                            {meta && (
                                                <div className={`text-xs mt-0.5 ${TEXT_CLASS[meta.variant]}`}>
                                                    {meta.key
                                                        ? interp(t(meta.key), {
                                                              coins: outcome.cost ?? cost,
                                                              have: outcome.coins,
                                                          })
                                                        : ipcErrorText(outcome.error, t) ||
                                                          t('app.discoverGenericError')}
                                                    {outcome.status === 'charged-pending-submit' && (
                                                        <button
                                                            className="btn btn-outline btn-sm ml-2"
                                                            aria-label={interp(t('app.discoverRetrySubmitLabel'), {
                                                                title: name,
                                                            })}
                                                            onClick={() => void doJoin(c, true)}
                                                            disabled={isBusy}
                                                        >
                                                            {t('app.discoverRetrySubmit')}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                className="btn btn-outline btn-sm"
                                                aria-label={interp(t('app.discoverChoosePhotosLabel'), { title: name })}
                                                onClick={() => setChoosing(c)}
                                            >
                                                {t('app.choosePhotos')}
                                            </button>
                                            <JoinButton
                                                name={name}
                                                cost={cost}
                                                busy={isBusy}
                                                onClick={() => onJoinClick(c)}
                                            />
                                        </div>
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
                                <button className="btn btn-outline btn-sm" onClick={() => setConfirm(null)}>
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

            <RowPhotoChooser challenge={choosing} onClose={() => setChoosing(null)} onSaved={chosen.refetch} />
        </>
    );
}
