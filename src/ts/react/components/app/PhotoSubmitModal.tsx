import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import { interp } from '@/utils/interp';
import { suggestErrorText } from '@/api/ipcErrorText';
import { useSuggestPhotos } from '@/api/useSuggestPhotos';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import { SearchForm } from './ChooserFooter';
import { PhotoGrid } from './PhotoChooserModal';
import { SuggestedStrip } from './SuggestedStrip';

import type { LibraryPhoto } from '@/hooks/useLibraryListing';

/**
 * What a submit came to: `done` (submitted, the modal closes), `refreshed` (it failed and the card was
 * refreshed, so the listing is read again too) or `failed` (nothing changed).
 */
export type PickOutcome = 'done' | 'refreshed' | 'failed';

/**
 * The translation keys of every line the modal's body and title read. The default is the Pick… submit's;
 * another use (the swap picker) names its own.
 */
export type PickTexts = {
    title: string;
    help: string;
    count: string;
    overCap: string;
    submit: string;
    submitCount: string;
    full: string;
    noSlots: string;
};

/** Photos the modal shows as blocked (ids) and the translation key of what their tiles say. */
export type BlockedPhotos = { ids: ReadonlySet<string>; reasonKey: string };

export const PICK_TEXTS: PickTexts = {
    title: 'app.pickTitle',
    help: 'app.pickHelp',
    count: 'app.pickCount',
    overCap: 'app.pickOverCap',
    submit: 'app.pickSubmit',
    submitCount: 'app.pickSubmitCount',
    full: 'app.pickFull',
    noSlots: 'app.pickNoSlots',
};

/** What Auto ranked: the photos best first, the member that owns them, and whether stats were partly skipped. */
type Suggested = { photos: LibraryPhoto[]; memberId: string | null; statsLimited: boolean };

/**
 * Cancel and Submit: Submit names how many are picked and is held with none, while the pick cannot be sent
 * (over the cap, or the listing is being read), or while sending.
 */
function SubmitFooter({
    count,
    held,
    submitting,
    texts,
    onSubmit,
    onCancel,
}: {
    count: number;
    held: boolean;
    submitting: boolean;
    texts: PickTexts;
    onSubmit: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const label = count > 0 ? interp(t(texts.submitCount), { count }) : t(texts.submit);
    return (
        <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-outline btn-sm" disabled={submitting} onClick={onCancel}>
                {t('app.cancel')}
            </button>
            <button
                type="button"
                className="btn btn-latvian btn-sm"
                disabled={count === 0 || held || submitting}
                aria-busy={submitting}
                onClick={onSubmit}
            >
                <BusyContent busy={submitting} label={label}>
                    {label}
                </BusyContent>
            </button>
        </div>
    );
}

/**
 * The modal's body. Mounted only while the modal is open, so every opening starts with nothing picked
 * and reads the listing afresh, picking only once that read is in. `max` is the card's live count of open slots: it can shrink while the modal is open.
 */
function PhotoSubmitBody({
    challengeId,
    max,
    submitting,
    error,
    texts,
    notice,
    blocked,
    suggest,
    onSubmit,
    onClose,
}: {
    challengeId: string | number;
    max: number;
    submitting: boolean;
    error: string | null;
    texts: PickTexts;
    notice: string | null;
    blocked?: BlockedPhotos;
    suggest: boolean;
    onSubmit: (imageIds: string[]) => Promise<PickOutcome>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState<string[]>([]);
    // Marks read before an action of this window (a join, a submit) are not to be trusted: a cached listing
    // always comes back as a preview, and picking waits for the fresh read.
    const { state, known, generation, revalidating, recheckFailed, load, refresh, retry } = useLibraryListing(
        challengeId,
        { alwaysFresh: true },
    );
    const preview = state.status === 'ready' && state.listing.preview;
    // Until the app has checked which photos the challenge accepts, none can be picked or sent.
    const checking = preview || recheckFailed;

    // The generation of the read a failed submit asked for: once a listing of that generation (or later) is
    // in, photos it says can no longer be entered leave the pick. Null when nothing is waiting.
    const pruneFromRef = useRef<number | null>(null);

    // Auto: the ranking on screen, the records of every photo it has named (a picked suggestion keeps its tile
    // when the strip clears), and the failure of the last press. An answer is kept only while the epoch it
    // was asked in is current: a Refresh, a refreshed submit or closing the modal ends it.
    const { suggest: runSuggest, loading: suggesting } = useSuggestPhotos();
    const [suggested, setSuggested] = useState<Suggested | null>(null);
    const [suggestedKnown, setSuggestedKnown] = useState<ReadonlyMap<string, LibraryPhoto>>(new Map());
    const [suggestFailure, setSuggestFailure] = useState<string | null>(null);
    const suggestEpoch = useRef(0);
    useEffect(
        () => () => {
            suggestEpoch.current += 1;
        },
        [],
    );

    // With one slot a tap swaps the pick instead of being refused. The pick is what is being sent while a
    // submit is in flight, so it does not change then.
    const toggle = useCallback(
        (id: string) => {
            if (submitting) return;
            setSelected((prev) => {
                if (prev.includes(id)) return prev.filter((other) => other !== id);
                return max === 1 ? [id] : [...prev, id];
            });
        },
        [max, submitting],
    );

    useEffect(() => {
        const from = pruneFromRef.current;
        // `generation < from`: a guard for a read that has not landed yet (defence in depth). A preview, or a
        // listing still being read again, says nothing about what the challenge accepts yet, and the pick is what
        // is being sent while a submit is in flight.
        if (from === null || state.status !== 'ready' || generation < from || checking || revalidating) return;
        if (submitting) return;
        pruneFromRef.current = null;
        if (!state.listing.allowedKnown) return;
        // A photo that has won since the last read is left out of the listing, so `known` still has it as allowed.
        const won = new Set(state.listing.wonIds);
        setSelected((prev) => {
            const kept = prev.filter((id) => known.get(id)?.allowed !== false && !won.has(id));
            return kept.length === prev.length ? prev : kept;
        });
    }, [state, known, generation, checking, revalidating, submitting]);

    // The suggestions are of the listing they were ranked beside: a new read drops them, and an answer still on
    // its way.
    const clearSuggestions = () => {
        suggestEpoch.current += 1;
        setSuggested(null);
        setSuggestFailure(null);
    };

    // After a Refresh answers, the pick is checked against the listing it brought, as after a refused submit.
    const refreshListing = () => {
        clearSuggestions();
        pruneFromRef.current = refresh();
    };

    const submit = () => {
        void (async () => {
            if ((await onSubmit(selected)) === 'refreshed') {
                clearSuggestions();
                pruneFromRef.current = retry();
            }
        })();
    };

    const autoSuggest = async () => {
        const epoch = suggestEpoch.current;
        setSuggestFailure(null);
        const result = await runSuggest(challengeId);
        if (epoch !== suggestEpoch.current) return;
        if (!result.success) {
            setSuggestFailure(result.error);
            return;
        }
        setSuggested(result);
        setSuggestedKnown(
            (prev) => new Map([...prev, ...result.photos.map((photo): [string, LibraryPhoto] => [photo.id, photo])]),
        );
    };

    // Adds the best suggestions not picked yet to the free slots, never taking a hand pick out. With one slot
    // it swaps the pick for the best one, as a tap does.
    const addSuggestions = (photos: LibraryPhoto[]) => {
        const ranked = photos.map((photo) => photo.id);
        setSelected((prev) => {
            if (max === 1) return ranked.slice(0, 1);
            const added = ranked.filter((id) => !prev.includes(id)).slice(0, Math.max(0, max - prev.length));
            return added.length > 0 ? [...prev, ...added] : prev;
        });
    };

    const alert = error && (
        <div role="alert" className="alert alert-error py-2 text-sm">
            <span>{error}</span>
        </div>
    );

    if (max < 1) {
        return (
            <div className="space-y-3">
                <p className="text-sm" role="status">
                    {t(texts.noSlots)}
                </p>
                <ModalActions>
                    <button type="button" className="btn btn-outline btn-sm" disabled={submitting} onClick={onClose}>
                        {t('app.close')}
                    </button>
                </ModalActions>
            </div>
        );
    }

    const over = selected.length > max;
    // With one slot the modal swaps the pick, so nothing is ever "full".
    const full = max !== 1 && selected.length >= max;
    const search = <SearchForm onSearch={(term) => void load(term)} />;
    return (
        <div className="space-y-3">
            {notice && (
                <div role="status" className="alert alert-info py-2 text-sm">
                    <span>{notice}</span>
                </div>
            )}
            <p className="text-base-content/70 text-xs">{t(texts.help)}</p>
            {suggest ? (
                <div className="space-y-1">
                    <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-48 flex-1">{search}</div>
                        <button
                            type="button"
                            className="btn btn-sm"
                            disabled={suggesting}
                            aria-busy={suggesting}
                            onClick={() => void autoSuggest()}
                        >
                            <BusyContent busy={suggesting} label={t('app.pickAuto')}>
                                {t('app.pickAuto')}
                            </BusyContent>
                        </button>
                    </div>
                    <p className="text-base-content/70 text-xs">{t('app.pickAutoHelp')}</p>
                </div>
            ) : (
                search
            )}
            <p className="text-xs" role="status">
                {interp(t(over ? texts.overCap : texts.count), { count: selected.length, max })}
            </p>
            {suggesting && (
                <p className="text-xs" role="status">
                    {t('app.pickAutoRunning')}
                </p>
            )}
            {suggestFailure && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span>{suggestErrorText(suggestFailure, t)}</span>
                </div>
            )}
            {suggested && (
                <SuggestedStrip
                    photos={suggested.photos}
                    memberId={suggested.memberId}
                    statsLimited={suggested.statsLimited}
                    selected={selected}
                    atCap={full}
                    fullKey={texts.full}
                    locked={checking}
                    addDisabled={submitting || checking || full}
                    onToggle={toggle}
                    onAdd={() => addSuggestions(suggested.photos)}
                />
            )}
            <PhotoGrid
                state={state}
                known={known}
                selected={selected}
                hideUnlisted={false}
                locked={checking}
                lockedKey="app.pickTileLocked"
                hasChallenge
                revalidating={revalidating}
                recheckFailed={recheckFailed}
                submit
                refreshDisabled={submitting}
                onToggle={toggle}
                onRetry={retry}
                onRefresh={refreshListing}
                // With one slot the modal swaps the pick, so the grid never stops offering tiles.
                max={max === 1 ? Number.POSITIVE_INFINITY : max}
                fullKey={texts.full}
                blockedIds={blocked?.ids}
                blockedKey={blocked?.reasonKey}
                numbered={false}
                extraPhotos={suggestedKnown}
            />
            {alert}
            <SubmitFooter
                count={selected.length}
                held={over || state.status !== 'ready' || checking}
                submitting={submitting}
                texts={texts}
                onSubmit={submit}
                onCancel={onClose}
            />
        </div>
    );
}

/**
 * Pick photos from the member's library and submit them to one challenge right away: the picker of the
 * Chosen Photos chooser, without saving anything. Owned by the card's actions (not by the buttons that open
 * it), so a refresh that closes the buttons' gate cannot drop it or the answer to a submit in flight.
 * While a submit is in flight nothing can close it.
 *
 * @param max - the card's live count of open slots
 * @param error - the translated text of the last failed submit
 * @param texts - the translation keys of the title and every line of the body (the Pick… submit's by default)
 * @param notice - a line shown at the top of the body, e.g. why the modal opened
 * @param blocked - photos shown as blocked, with the translation key of the reason, that cannot be picked: the
 *   listing marks only what the server refuses for the challenge, not what is already entered
 * @param suggest - offers Auto, which ranks the photos under the auto-submit rules and shows the best (the Pick…
 *   submit's; the swap picker has none)
 * @param onSubmit - sends the ids and says what came of it (the card refreshes itself)
 */
export function PhotoSubmitModal({
    isOpen,
    onClose,
    challengeId,
    max,
    submitting,
    error,
    texts = PICK_TEXTS,
    notice = null,
    blocked,
    suggest = false,
    onSubmit,
}: {
    isOpen: boolean;
    onClose: () => void;
    challengeId: string | number;
    max: number;
    submitting: boolean;
    error: string | null;
    texts?: PickTexts;
    notice?: string | null;
    blocked?: BlockedPhotos;
    suggest?: boolean;
    onSubmit: (imageIds: string[]) => Promise<PickOutcome>;
}) {
    const { t } = useTranslation();
    if (!isOpen) return null;
    return (
        <Modal
            isOpen
            onClose={submitting ? undefined : onClose}
            title={t(texts.title)}
            size="xl"
            showCloseButton={!submitting}
        >
            <PhotoSubmitBody
                challengeId={challengeId}
                max={max}
                submitting={submitting}
                error={error}
                texts={texts}
                notice={notice}
                blocked={blocked}
                suggest={suggest}
                onSubmit={onSubmit}
                onClose={onClose}
            />
        </Modal>
    );
}
