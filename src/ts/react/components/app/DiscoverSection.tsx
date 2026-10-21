import { useState, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useMemberChallenges } from '@/api/useMemberChallenges';
import { useOpenChosenAnnotations } from '@/api/useOpenChosenAnnotations';
import { useOnChosenPhotosCleared } from '@/api/chosenPhotosCleared';
import { useDiscoverRows } from '@/hooks/useDiscoverRows';
import { useDiscoverJoins } from '@/hooks/useDiscoverJoins';
import type { JoinPhase } from '@/hooks/useDiscoverJoins';
import { costOf } from '@/utils/discoverCost';
import { outcomeMeta } from '@/utils/discoverOutcome';
import type { OutcomeVariant } from '@/utils/discoverOutcome';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { ToneNote } from '@/components/ui/ToneNote';
import { interp } from '@/utils/interp';
import { formatDuration, formatEndTime } from '@/utils/formatters';
import * as ipc from '@/api/ipc';
import { ipcErrorText, joinRefusalText } from '@/api/ipcErrorText';
import { listedTags } from '../../../format/challengeListing';
import { endTimeOf } from '../../../format/endTime';
// The pure fresh-join guard the facade re-exports (services/VotingLogic) — imported at its home
// module, so the renderer bundle does not pull the whole voting-decision barrel in for one function.
import { joinFreshRefusal } from '../../../services/decisions/joinDecision';
import { ChallengeKindBadges, ChallengeTagBadges } from './ChallengeKindBadges';
import { prizeItemsText } from '@/utils/prizeText';
import { PhotoChooserModal } from './PhotoChooserModal';
import { ForgetPaymentModal } from './ForgetPaymentModal';
import { JoinConfirmModal } from './JoinConfirmModal';

import type { Bankroll, Challenge, OpenChallenge } from '../../../types/gurushots';
import type { JoinReason } from '../../../types/join';

/**
 * What a join left behind for its row: the join-challenge result (either arm)
 * or the local stand-in when the call itself threw.
 */
export type JoinOutcome = {
    success?: boolean;
    status?: string;
    cost?: number;
    coins?: number;
    error?: string;
    reason?: JoinReason;
    coinsBefore?: number;
};

// Static (purge-safe) text color per outcome variant — never build Tailwind
// class names dynamically, the JIT can't see them. A warning or an error is
// body-text colour behind a tone icon (ToneNote), so it has no entry here.
const TEXT_CLASS: Record<Exclude<OutcomeVariant, 'warning' | 'error'>, string> = {
    success: 'text-success',
    neutral: 'text-base-content/70',
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
            className="badge badge-outline badge-sm mt-0.5 min-h-6"
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
        <div className="text-xs text-base-content/70 mt-0.5">
            {interp(t('app.discoverChosenInherited'), { count: c.chosenEffectiveCount })}
        </div>
    );
}

/**
 * A row's Join button, named by its challenge (and, when paid, its cost) for assistive
 * technology; while joining the visible text says so, so no static label contradicts it.
 * A row whose coins are already spent (`retry`) offers Retry submit instead, with no cost in its name:
 * pressing it spends nothing.
 * A challenge that has not started cannot be joined, and neither can one that has only just started
 * and is not in the open list yet (a join would answer "no longer open"): the button is disabled and
 * its name says why. A join the listing itself refuses (`blocked`: a full challenge, or one whose
 * unlock price GuruShots did not send) still shows a plain Join — the listing can lag the live list,
 * and a claim from an earlier session may only need its submit retried — so the button stays enabled,
 * its name mentions the refusal, and a fresh join is answered `failed-no-charge` with the reason.
 */
function JoinButton({
    id,
    name,
    cost,
    retry,
    busy,
    waiting,
    blocked,
    onClick,
}: {
    id: OpenChallenge['id'];
    name: string;
    cost: number;
    retry: boolean;
    busy: JoinPhase | null;
    waiting: 'notStarted' | 'startingNow' | null;
    blocked: 'full' | 'price-unknown' | null;
    onClick: () => void;
}) {
    const { t } = useTranslation();
    const paid = cost > 0 && !retry;
    const label = interp(
        t(
            retry
                ? 'app.discoverRetrySubmitLabel'
                : blocked === 'full'
                  ? 'app.discoverJoinFullLabel'
                  : blocked === 'price-unknown'
                    ? 'app.discoverJoinPriceUnknownLabel'
                    : waiting === 'notStarted'
                      ? 'app.discoverJoinNotStartedLabel'
                      : waiting === 'startingNow'
                        ? 'app.discoverJoinOpeningLabel'
                        : paid
                          ? 'app.discoverJoinPaidLabel'
                          : 'app.discoverJoinLabel',
        ),
        { title: name, coins: cost },
    );
    return (
        <button
            className={`btn btn-sm ${paid ? 'btn-latvian' : 'btn-neutral'}`}
            id={`discover-join-${id}`}
            aria-label={busy ? undefined : label}
            onClick={onClick}
            disabled={busy !== null || waiting !== null}
        >
            {busy
                ? t(busy === 'asking' ? 'app.discoverChecking' : 'app.discoverJoining')
                : retry
                  ? t('app.discoverRetrySubmit')
                  : paid
                    ? t('app.discoverJoinPaid')
                    : t('app.discoverJoin')}
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
    // without its ids. Once the chooser's member check has said, ask again: the ids come through if
    // the list is this account's, and not otherwise (null).
    const challengeId = challenge?.id;
    // Keyed on the challenge so a re-render does not look like a new function, and a new IPC call.
    const reloadSaved = useCallback(async (): Promise<string[] | null> => {
        const id = String(challengeId);
        const result = await ipc.callOrNull(() => ipc.getOpenChosenAnnotations([id]));
        const annotation = result?.success ? result.annotations[id] : undefined;
        return annotation && annotation.chosenOwn.length === annotation.chosenOwnCount ? annotation.chosenOwn : null;
    }, [challengeId]);
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
            // GuruShots' suggested photos for this challenge, from the listing: their tiles say so.
            recommendedIds={challenge?.suggestedPhotoIds}
            // The row's challenge is not joined, so Auto cannot rank for it (it would answer
            // challenge-ended); the chooser hides the button.
            canSuggest={false}
            clearMeansInherit
            reloadSaved={reloadSaved}
            onSave={save}
        />
    );
}

/** The seconds until a challenge starts, or null once it has (or when the row is an open one). */
const secondsToStart = (c: OpenChallenge, nowSec: number): number | null => {
    const left = Number(c.start_time) - nowSec;
    return c.status === 'upcoming' && left > 0 ? left : null;
};

/**
 * What a row says about when its challenge starts: how long is left, or that it is starting now (it
 * was upcoming and its start has passed, but the open list does not show it yet).
 */
function StartLine({ c, nowSec }: { c: OpenChallenge; nowSec: number }) {
    const { t } = useTranslation();
    if (c.status !== 'upcoming') return null;
    const left = secondsToStart(c, nowSec);
    return (
        <div className="text-xs text-base-content/70 mt-0.5">
            {left === null
                ? t('app.discoverStartingNow')
                : interp(t('app.discoverStartsIn'), { time: formatDuration(left) })}
        </div>
    );
}

/**
 * What a join left behind for its row, as a translated, coloured line. Any result without a mapped
 * status (auth-expiry, an unexpected handler error) still shows a message rather than failing
 * silently on a money-adjacent action. A join the live list refused as full or price-unreadable
 * carries its reason, not an error: it gets the refusal's what → why → next text.
 */
function RowOutcome({
    outcome,
    cost,
    name,
    busy,
    onForget,
}: {
    outcome: JoinOutcome;
    cost: number;
    name: string;
    busy: boolean;
    onForget: () => void;
}) {
    const { t } = useTranslation();
    const meta = outcomeMeta(outcome);
    const { variant } = meta;
    const refused =
        outcome.status === 'failed-no-charge' && (outcome.reason === 'full' || outcome.reason === 'price-unknown')
            ? joinRefusalText(outcome.reason, t)
            : null;
    const content = (
        <>
            {refused ??
                (meta.key
                    ? interp(t(meta.key), { coins: outcome.cost ?? cost, have: outcome.coins })
                    : ipcErrorText(outcome.error, t) || t('app.discoverGenericError'))}
            {meta.forget && (
                <button
                    className="btn btn-ghost btn-sm ml-1"
                    aria-label={interp(t('app.discoverForgetPaymentLabel'), { title: name })}
                    onClick={onForget}
                    disabled={busy}
                >
                    {t('app.discoverForgetPayment')}
                </button>
            )}
        </>
    );
    // Announced when it appears: a problem interrupts (alert), a result or a note waits its turn (status).
    if (variant === 'error' || variant === 'warning') {
        return (
            <ToneNote tone={variant} as="div" role="alert" className="text-xs mt-0.5">
                {content}
            </ToneNote>
        );
    }
    return (
        <div role="status" className={`text-xs mt-0.5 ${TEXT_CLASS[variant]}`}>
            {content}
        </div>
    );
}

/** One challenge in the list: what it is, what it costs, its capacity, when it starts, its chosen photos, and its actions. */
function DiscoverRow({
    c,
    outcome,
    busy,
    nowSec,
    timezone,
    onChoose,
    onJoin,
    onForget,
}: {
    c: OpenChallenge;
    outcome: JoinOutcome | undefined;
    busy: JoinPhase | null;
    nowSec: number;
    timezone: string;
    onChoose: () => void;
    onJoin: () => void;
    onForget: () => void;
}) {
    const { t } = useTranslation();
    const cost = costOf(c);
    // Coins already spent: the row resumes the submit rather than joining (and paying) again.
    const retry = outcome !== undefined && outcomeMeta(outcome).retry;
    // Why the listing itself refuses a fresh join (a join still asks the live list): a full challenge,
    // or one whose unlock price GuruShots did not send. Null when the row may go ahead.
    const blocked = joinFreshRefusal(c);
    const closeTime = endTimeOf(c.close_time);
    const name = rowName(c, t('app.discoverUntitled'));
    // Upcoming rows wait: until the start, then until the open list shows the challenge.
    const waiting = c.status !== 'upcoming' ? null : secondsToStart(c, nowSec) !== null ? 'notStarted' : 'startingNow';
    // The capacity line, on a challenge whose cap and head count BOTH read: the head count, and
    // "Full" when it is reached. A count the listing left unreadable shows no fraction (never
    // "NaN/150") — the join asks the live list, which decides.
    const maxPlayers = Number(c.max_players);
    const players = Number(c.players);
    const capped = Number.isFinite(maxPlayers) && maxPlayers > 0 && Number.isFinite(players);
    // The wire field is typed as an array but is not guaranteed one: read it only when it is.
    const prizes = Array.isArray(c.first_prizes) ? prizeItemsText(c.first_prizes, t) : '';
    return (
        <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-base-200 px-2 py-1.5">
            <div className="min-w-0">
                <div className="truncate font-medium">{name}</div>
                <div className="flex flex-wrap items-center gap-1 text-xs text-base-content/70">
                    <ChallengeKindBadges challenge={c} />
                    <ChallengeTagBadges tags={listedTags(c)} />
                    <span>
                        {cost > 0
                            ? interp(t('app.discoverCostPaid'), { coins: cost })
                            : blocked === 'price-unknown'
                              ? t('app.discoverPriceUnknown')
                              : t('app.discoverCostFree')}
                    </span>
                    {capped && (
                        <span>
                            <span aria-hidden="true">· 👥 </span>
                            <span className="sr-only">{t('app.players')}: </span>
                            {players.toLocaleString()}/{maxPlayers.toLocaleString()}
                            {blocked === 'full' && (
                                <>
                                    <span aria-hidden="true"> · </span>
                                    {t('app.discoverFull')}
                                </>
                            )}
                        </span>
                    )}
                    {closeTime !== null && (
                        <span>
                            <span aria-hidden="true">· </span>
                            {t('app.ends')} {formatEndTime(closeTime, timezone)}
                        </span>
                    )}
                    {(c.suggestedPhotoIds?.length ?? 0) > 0 && (
                        <span className="badge badge-outline badge-sm">{t('app.discoverRecommended')}</span>
                    )}
                </div>
                {blocked === 'price-unknown' && (
                    <div className="text-xs text-base-content/70 mt-0.5">{t('app.discoverPriceUnknownHint')}</div>
                )}
                {prizes !== '' && (
                    <div className="text-xs text-base-content/70 mt-0.5 wrap-anywhere">
                        {t('app.prize')}: {prizes}
                    </div>
                )}
                <StartLine c={c} nowSec={nowSec} />
                <ChosenMarks c={c} name={name} onChoose={onChoose} />
                {waiting !== null && c.chosenEffectiveCount > 0 && (
                    <div className="text-xs text-base-content/70 mt-0.5">{t('app.discoverUpcomingChosenHint')}</div>
                )}
                {outcome && (
                    <RowOutcome outcome={outcome} cost={cost} name={name} busy={busy !== null} onForget={onForget} />
                )}
            </div>
            <div className="flex items-center gap-2">
                <button
                    className="btn btn-outline btn-sm"
                    aria-label={interp(t('app.discoverChoosePhotosLabel'), { title: name })}
                    onClick={onChoose}
                >
                    {t('app.choosePhotos')}
                </button>
                <JoinButton
                    id={c.id}
                    name={name}
                    cost={cost}
                    retry={retry}
                    busy={busy}
                    waiting={waiting}
                    blocked={blocked}
                    onClick={onJoin}
                />
            </div>
        </li>
    );
}

/**
 * How many rows are open and how many are upcoming, apart: a challenge that has just started (not
 * open yet, no longer upcoming) is neither, so both numbers stay true. Without upcoming rows it is the
 * open count, as ever; with nothing to count, no badge.
 */
function CountBadge({ list, nowSec }: { list: OpenChallenge[]; nowSec: number }) {
    const { t } = useTranslation();
    const upcoming = list.filter((c) => secondsToStart(c, nowSec) !== null).length;
    const open = list.filter((c) => c.status !== 'upcoming').length;
    if (open + upcoming === 0) return null;
    const label =
        upcoming > 0
            ? interp(t('app.discoverCountSplit'), { open, upcoming })
            : interp(t('app.discoverCountLabel'), { count: open });
    return (
        <span className="badge badge-neutral badge-sm" role="img" aria-label={label}>
            {upcoming > 0 ? label : open}
        </span>
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
    timezone,
}: {
    isLoggedIn: boolean;
    bankroll: Bankroll | null;
    onJoined: () => void;
    /** The Timezone setting, which the end times are written in (as on the challenge cards). */
    timezone: string;
}) {
    const { t } = useTranslation();
    const { items, loading, error, refetch } = useMemberChallenges();
    // The rows: the open challenges, those that just started (until the open list shows them), the upcoming ones.
    const { rows, nowSec } = useDiscoverRows(items, error !== null, refetch);
    // The rows follow the settings without another trip to GuruShots: what the list carried is
    // only the starting point, the settings-only read replaces it as soon as it answers.
    const chosen = useOpenChosenAnnotations(rows.map((c) => String(c.id)));
    useOnChosenPhotosCleared(() => void chosen.refetch());
    const [choosing, setChoosing] = useState<OpenChallenge | null>(null); // challenge whose photos are being chosen
    const [forgetting, setForgetting] = useState<OpenChallenge | null>(null); // challenge whose payment is being forgotten
    const { confirm, results, busy, withAnswerCost, ask, onConfirm, dismiss, clearResult } = useDiscoverJoins({
        items,
        isLoggedIn,
        refetch,
        onJoined,
    });

    if (!isLoggedIn) return null;

    // useMemberChallenges guarantees an array.
    const list = rows.map((c): OpenChallenge => ({ ...withAnswerCost(c), ...chosen.annotations[String(c.id)] }));

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
                    <CountBadge list={list} nowSec={nowSec} />
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

                    {/* A failed read leaves the rows of the last good one (see useMemberChallenges): the error stands beside them. */}
                    {error && (
                        <ToneNote tone="error" className="text-sm mb-2">
                            {t('app.discoverUnavailableList')}
                        </ToneNote>
                    )}
                    {loading && list.length === 0 ? (
                        <InlineLoader />
                    ) : list.length === 0 ? (
                        error ? null : (
                            <p className="text-sm text-base-content/70">{t('app.discoverEmpty')}</p>
                        )
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {list.map((c) => (
                                <DiscoverRow
                                    key={c.id}
                                    c={c}
                                    outcome={results[c.id]}
                                    busy={busy.get(c.id) ?? null}
                                    nowSec={nowSec}
                                    timezone={timezone}
                                    onChoose={() => setChoosing(c)}
                                    onJoin={() => ask(c)}
                                    onForget={() => setForgetting(c)}
                                />
                            ))}
                        </ul>
                    )}
                </div>
            </details>

            <JoinConfirmModal confirm={confirm} bankroll={bankroll} onConfirm={onConfirm} dismiss={dismiss} />

            <ForgetPaymentModal
                challenge={forgetting}
                coinsBefore={forgetting ? results[forgetting.id]?.coinsBefore : undefined}
                onClose={() => setForgetting(null)}
                onForgotten={(id) => {
                    clearResult(id);
                    void refetch();
                    // The button that opened the dialog is gone with the row's line: focus goes to the row's Join.
                    window.setTimeout(() => document.getElementById(`discover-join-${id}`)?.focus(), 0);
                }}
            />

            <RowPhotoChooser challenge={choosing} onClose={() => setChoosing(null)} onSaved={chosen.refetch} />
        </>
    );
}
