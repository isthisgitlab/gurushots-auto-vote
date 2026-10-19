import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { StickyModalFooter, STICKY_FOOTER_SCROLL_PADDING } from '@/components/ui/StickyModalFooter';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import { interp } from '@/utils/interp';
import { suggestErrorText } from '@/api/ipcErrorText';
import { useSuggestPhotos } from '@/api/useSuggestPhotos';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import { SearchForm } from './ChooserFooter';
import { PhotoGrid } from './PhotoChooserModal';
import { SuggestedStrip } from './SuggestedStrip';

import type { LibraryPhoto } from '@/hooks/useLibraryListing';
import type { LibraryUsage } from '../../../types/photoPicker';

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
    autoHelp: string;
    autoRunning: string;
    idleWithPicks: string;
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
    autoHelp: 'app.pickAutoHelp',
    autoRunning: 'app.pickAutoRunning',
    idleWithPicks: 'app.pickIdleWithPicks',
};

/** What Auto ranked: the photos best first, the member that owns them, and whether stats were partly skipped. */
type Suggested = { photos: LibraryPhoto[]; memberId: string | null; statsLimited: boolean };

/**
 * Cancel and Submit: Submit names how many are picked and is held with none, while the pick cannot be sent
 * (over the cap, or a listing asked for is being read or failed), or while sending.
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
        <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-outline btn-sm" disabled={submitting} onClick={onCancel}>
                {t('app.cancel')}
            </button>
            <button
                type="button"
                className="btn btn-neutral btn-sm"
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
 * The modal's body. Mounted only while the modal is open, so every opening starts with nothing picked.
 * No listing is read until Load all, Search or a Retry asks for one, and Auto's picks can be sent without it.
 * `usage` is what the listing and Auto read eligibility for. `max` is the card's live count of open slots: it
 * can shrink while the modal is open.
 */
function PhotoSubmitBody({
    challengeId,
    max,
    submitting,
    error,
    texts,
    notice,
    blocked,
    usage,
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
    usage: LibraryUsage;
    onSubmit: (imageIds: string[]) => Promise<PickOutcome>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState<string[]>([]);
    // Marks read before an action of this window (a join, a submit) are not to be trusted: a cached listing
    // always comes back as a preview, and picking waits for the fresh read.
    const { state, known, generation, revalidating, recheckFailed, load, refresh, retry } = useLibraryListing(
        challengeId,
        { alwaysFresh: true, onDemand: true, usage },
    );
    const preview = state.status === 'ready' && state.listing.preview;
    // Once a listing is shown, until the app has checked which photos the challenge accepts, none can be picked or
    // sent. An idle one shows none: Auto's picks are ranked against the live challenge's eligible photos.
    const checking = preview || recheckFailed;
    const reading = state.status === 'loading' || revalidating;
    // Whether the read on screen is one Load all started: only that one shows Load all as busy.
    const [loadAllReading, setLoadAllReading] = useState(false);
    // Bumped by Load all to remount the search box empty, so it never shows a term the grid is not filtered by.
    const [searchKey, setSearchKey] = useState(0);

    // The generation of the read a failed submit asked for (or a Refresh): once a listing of that generation (or
    // later) is in, photos it says can no longer be entered leave the pick. Load all and Search do not set it, so a
    // pick that one of those reads marks refused stays on screen with its reason (the grid shows a pick whatever its
    // mark). Null when nothing is waiting.
    const pruneFromRef = useRef<number | null>(null);

    // Auto: the ranking on screen, the records of every photo it has named (a picked suggestion keeps its tile
    // when the strip clears), and the failure of the last press. An answer is kept only while the epoch it
    // was asked in is current: a Refresh, a refreshed submit or closing the modal ends it.
    const { suggest: runSuggest, loading: suggesting } = useSuggestPhotos();
    const [suggested, setSuggested] = useState<Suggested | null>(null);
    const [suggestedKnown, setSuggestedKnown] = useState<ReadonlyMap<string, LibraryPhoto>>(new Map());
    // The member of the last answer that named one: it survives the strip clearing, so picks keep their thumbnails.
    const [suggestedMemberId, setSuggestedMemberId] = useState<string | null>(null);
    const [suggestFailure, setSuggestFailure] = useState<string | null>(null);
    // Every id picked in this opening, in first-pick order: while idle the grid keeps each one's tile in place
    // when it is unpicked, so the tile (and the focus on it) stays and the pick can be made again. The state
    // remembers the ids once they are unpicked; a pick is shown in the render that makes it.
    const [idleSeen, setIdleSeen] = useState<string[]>([]);
    useEffect(() => {
        setIdleSeen((prev) => {
            const added = selected.filter((id) => !prev.includes(id));
            return added.length > 0 ? [...prev, ...added] : prev;
        });
    }, [selected]);
    const idleShown = [...idleSeen, ...selected.filter((id) => !idleSeen.includes(id))];
    const suggestEpoch = useRef(0);
    useEffect(
        () => () => {
            suggestEpoch.current += 1;
        },
        [],
    );

    // Photos taken out of the pick stay on screen with their reason until the next listing replaces this one.
    const onScreen = state.status === 'ready' ? state.listing : null;
    const [takenBack, setTakenBack] = useState<{ listing: typeof onScreen; ids: ReadonlySet<string> }>({
        listing: null,
        ids: new Set(),
    });
    const keepIds = takenBack.listing === onScreen ? takenBack.ids : undefined;
    const current = useRef({ selected, onScreen });
    // The latest pick and listing, for `toggle`, which must stay the same function between renders.
    useLayoutEffect(() => {
        current.current = { selected, onScreen };
    });

    // Records photos taken out of the pick (taken back, or replaced with one slot) for the listing on screen.
    const keepShown = useCallback((ids: readonly string[]) => {
        if (ids.length === 0) return;
        const listing = current.current.onScreen;
        setTakenBack((prev) => ({
            listing,
            ids: new Set([...(prev.listing === listing ? prev.ids : []), ...ids]),
        }));
    }, []);

    // With one slot a tap swaps the pick instead of being refused. The pick is what is being sent while a
    // submit is in flight, so it does not change then.
    const toggle = useCallback(
        (id: string) => {
            if (submitting) return;
            const picked = current.current.selected;
            // Taps take back a picked photo; with one slot they also replace the pick.
            keepShown(picked.includes(id) ? [id] : max === 1 ? picked : []);
            setSelected((prev) => {
                if (prev.includes(id)) return prev.filter((other) => other !== id);
                return max === 1 ? [id] : [...prev, id];
            });
        },
        [max, submitting, keepShown],
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
        setLoadAllReading(false);
        clearSuggestions();
        pruneFromRef.current = refresh();
    };

    const submit = () => {
        void (async () => {
            if ((await onSubmit(selected)) === 'refreshed') {
                setLoadAllReading(false);
                clearSuggestions();
                pruneFromRef.current = retry();
            }
        })();
    };

    const autoSuggest = async () => {
        const epoch = suggestEpoch.current;
        setSuggestFailure(null);
        const result = await runSuggest(challengeId, usage);
        if (epoch !== suggestEpoch.current) return;
        if (!result.success) {
            setSuggested(null);
            setSuggestFailure(result.error);
            return;
        }
        setSuggested(result);
        if (result.memberId !== null) setSuggestedMemberId(result.memberId);
        setSuggestedKnown(
            (prev) => new Map([...prev, ...result.photos.map((photo): [string, LibraryPhoto] => [photo.id, photo])]),
        );
    };

    // Adds the best suggestions not picked yet to the free slots, never taking a hand pick out. With one slot
    // it swaps the pick for the best one, as a tap does.
    const addSuggestions = (photos: LibraryPhoto[]) => {
        const ranked = photos.map((photo) => photo.id);
        if (max === 1) keepShown(selected.filter((id) => id !== ranked[0]));
        setSelected((prev) => {
            if (max === 1) return ranked.slice(0, 1);
            const added = ranked.filter((id) => !prev.includes(id)).slice(0, Math.max(0, max - prev.length));
            return [...prev, ...added];
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

    // A tap while a submit is in flight does nothing (see toggle): the tiles say so instead of ignoring it.
    const locked = checking || submitting;
    const lockedKey = submitting ? 'app.pickTileSubmitting' : 'app.pickTileLocked';
    const over = selected.length > max;
    // Add suggestions has nothing to do when every suggestion is picked already; with one slot it swaps in #1,
    // so it has nothing to do only when #1 is the whole pick.
    const nothingToAdd =
        suggested !== null &&
        (max === 1
            ? selected.length === 1 && selected[0] === suggested.photos[0]?.id
            : suggested.photos.every((photo) => selected.includes(photo.id)));
    // With one slot the modal swaps the pick, so nothing is ever "full".
    const full = max !== 1 && selected.length >= max;
    let autoStatus = '';
    if (suggesting) autoStatus = t(texts.autoRunning);
    else if (suggested) autoStatus = interp(t('app.pickSuggestedCount'), { count: suggested.photos.length });
    // Load all waits for any read, and for a submit, as Refresh does.
    const loadAllHeld = reading || submitting;
    const loadAllBusy = reading && loadAllReading;
    const search = (
        <SearchForm
            key={searchKey}
            onSearch={(term) => {
                setLoadAllReading(false);
                void load(term);
            }}
        />
    );
    return (
        <div className="space-y-3">
            {notice && (
                <div role="status" className="alert alert-info py-2 text-sm">
                    <span>{notice}</span>
                </div>
            )}
            <p className="text-base-content/70 text-xs">{t(texts.help)}</p>
            <div className="space-y-1">
                <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-48 flex-1">{search}</div>
                    <button
                        type="button"
                        className={`btn btn-outline btn-sm ${loadAllHeld ? 'btn-disabled' : ''}`}
                        // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body>.
                        aria-disabled={loadAllHeld}
                        aria-busy={loadAllBusy}
                        onClick={() => {
                            if (loadAllHeld) return;
                            setLoadAllReading(true);
                            setSearchKey((key) => key + 1);
                            void load('');
                        }}
                    >
                        <BusyContent busy={loadAllBusy} label={t('app.pickLoadAll')}>
                            {t('app.pickLoadAll')}
                        </BusyContent>
                    </button>
                    <button
                        type="button"
                        className={`btn btn-sm ${suggesting ? 'btn-disabled' : ''}`}
                        // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body>.
                        aria-disabled={suggesting}
                        aria-busy={suggesting}
                        onClick={() => {
                            if (!suggesting) void autoSuggest();
                        }}
                    >
                        <BusyContent busy={suggesting} label={t('app.pickAuto')}>
                            {t('app.pickAuto')}
                        </BusyContent>
                    </button>
                </div>
                <p className="text-base-content/70 text-xs">{t(texts.autoHelp)}</p>
            </div>
            <p className="text-xs" role="status">
                {interp(t(over ? texts.overCap : texts.count), { count: selected.length, max })}
            </p>
            {/* Always mounted, so a screen reader announces the text that arrives in it. The count of a finished
                ranking is read out only: the strip shows it. */}
            <p role="status" aria-live="polite" className={suggesting || !suggested ? 'text-xs' : 'sr-only'}>
                {autoStatus}
            </p>
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
                    locked={locked}
                    lockedKey={lockedKey}
                    addDisabled={submitting || checking || full || nothingToAdd}
                    onToggle={toggle}
                    onAdd={() => addSuggestions(suggested.photos)}
                />
            )}
            <PhotoGrid
                state={state}
                known={known}
                selected={selected}
                hideUnlisted={false}
                locked={locked}
                lockedKey={lockedKey}
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
                idleMemberId={suggestedMemberId}
                idleIds={idleShown}
                idleWithPicksKey={texts.idleWithPicks}
                keepIds={keepIds}
            />
            <StickyModalFooter>
                {alert}
                <SubmitFooter
                    count={selected.length}
                    held={over || checking || (state.status !== 'ready' && state.status !== 'idle')}
                    submitting={submitting}
                    texts={texts}
                    onSubmit={submit}
                    onCancel={onClose}
                />
            </StickyModalFooter>
        </div>
    );
}

/**
 * Pick photos from the member's library and submit them to one challenge right away: the picker of the
 * Chosen Photos chooser, without saving anything. Nothing is read on opening: Load all, Search and Auto (which
 * ranks the photos under the auto-submit rules and shows the best) ask for what they need. Owned by the card's
 * actions (not by the buttons that open it), so a refresh that closes the buttons' gate cannot drop it or the
 * answer to a submit in flight. While a submit is in flight nothing can close it.
 *
 * @param max - the card's live count of open slots
 * @param error - the translated text of the last failed submit
 * @param texts - the translation keys of the title and every line of the body (the Pick… submit's by default)
 * @param notice - a line shown at the top of the body, e.g. why the modal opened
 * @param blocked - photos shown as blocked, with the translation key of the reason, that cannot be picked: the
 *   listing marks only what the server refuses for the challenge, not what is already entered
 * @param usage - what the listing's eligibility and Auto's ranking are read for: entering the challenge (the
 *   default, the Pick… submit) or replacing an entry's photo (the swap picker)
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
    usage = 'submit',
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
    usage?: LibraryUsage;
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
            className={STICKY_FOOTER_SCROLL_PADDING}
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
                usage={usage}
                onSubmit={onSubmit}
                onClose={onClose}
            />
        </Modal>
    );
}
