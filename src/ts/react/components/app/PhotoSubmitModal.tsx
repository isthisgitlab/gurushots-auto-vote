import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import { interp } from '@/utils/interp';
import { useLibraryListing } from '@/hooks/useLibraryListing';
import { SearchForm } from './ChooserFooter';
import { PhotoGrid } from './PhotoChooserModal';

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

    // After a Refresh answers, the pick is checked against the listing it brought, as after a refused submit.
    const refreshListing = () => {
        pruneFromRef.current = refresh();
    };

    const submit = () => {
        void (async () => {
            if ((await onSubmit(selected)) === 'refreshed') {
                pruneFromRef.current = retry();
            }
        })();
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
    return (
        <div className="space-y-3">
            {notice && (
                <div role="status" className="alert alert-info py-2 text-sm">
                    <span>{notice}</span>
                </div>
            )}
            <p className="text-base-content/70 text-xs">{t(texts.help)}</p>
            <SearchForm onSearch={(term) => void load(term)} />
            <p className="text-xs" role="status">
                {interp(t(over ? texts.overCap : texts.count), { count: selected.length, max })}
            </p>
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
                onSubmit={onSubmit}
                onClose={onClose}
            />
        </Modal>
    );
}
