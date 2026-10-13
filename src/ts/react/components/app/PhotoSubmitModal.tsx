import { useCallback, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import { interp } from '@/utils/interp';
import { useLibraryListing } from '@/hooks/usePhotoChooser';
import { SearchForm } from './ChooserFooter';
import { PhotoGrid } from './PhotoChooserModal';

/**
 * What a submit came to: `done` (submitted, the modal closes), `refreshed` (it failed and the card was
 * refreshed, so the listing is read again too) or `failed` (nothing changed).
 */
export type PickOutcome = 'done' | 'refreshed' | 'failed';

/** Cancel and Submit: Submit names how many are picked and is held with none, over the cap, or while sending. */
function SubmitFooter({
    count,
    held,
    submitting,
    onSubmit,
    onCancel,
}: {
    count: number;
    held: boolean;
    submitting: boolean;
    onSubmit: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const label = count > 0 ? interp(t('app.pickSubmitCount'), { count }) : t('app.pickSubmit');
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
 * and a fresh listing. `max` is the card's live count of open slots: it can shrink while the modal is open.
 */
function PhotoSubmitBody({
    challengeId,
    max,
    submitting,
    error,
    onSubmit,
    onClose,
}: {
    challengeId: string | number;
    max: number;
    submitting: boolean;
    error: string | null;
    onSubmit: (imageIds: string[]) => Promise<PickOutcome>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState<string[]>([]);
    const { state, known, load, retry } = useLibraryListing(challengeId);

    // With one slot a tap swaps the pick instead of being refused.
    const toggle = useCallback(
        (id: string) => {
            setSelected((prev) => {
                if (prev.includes(id)) return prev.filter((other) => other !== id);
                return max === 1 ? [id] : [...prev, id];
            });
        },
        [max],
    );

    const submit = () => {
        void (async () => {
            if ((await onSubmit(selected)) === 'refreshed') retry();
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
                {alert}
                <p className="text-sm" role="status">
                    {t('app.pickNoSlots')}
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
            <p className="text-base-content/70 text-xs">{t('app.pickHelp')}</p>
            <SearchForm onSearch={(term) => void load(term)} />
            <p className="text-xs" role="status">
                {interp(t(over ? 'app.pickOverCap' : 'app.pickCount'), { count: selected.length, max })}
            </p>
            <PhotoGrid
                state={state}
                known={known}
                selected={selected}
                hideUnlisted={false}
                locked={false}
                onToggle={toggle}
                onRetry={retry}
                // With one slot the modal swaps the pick, so the grid never stops offering tiles.
                max={max === 1 ? Number.POSITIVE_INFINITY : max}
                fullKey="app.pickFull"
                numbered={false}
            />
            {alert}
            <SubmitFooter
                count={selected.length}
                held={over}
                submitting={submitting}
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
 * @param onSubmit - sends the ids and says what came of it (the card refreshes itself)
 */
export function PhotoSubmitModal({
    isOpen,
    onClose,
    challengeId,
    max,
    submitting,
    error,
    onSubmit,
}: {
    isOpen: boolean;
    onClose: () => void;
    challengeId: string | number;
    max: number;
    submitting: boolean;
    error: string | null;
    onSubmit: (imageIds: string[]) => Promise<PickOutcome>;
}) {
    const { t } = useTranslation();
    if (!isOpen) return null;
    return (
        <Modal
            isOpen
            onClose={submitting ? undefined : onClose}
            title={t('app.pickTitle')}
            size="xl"
            showCloseButton={!submitting}
        >
            <PhotoSubmitBody
                challengeId={challengeId}
                max={max}
                submitting={submitting}
                error={error}
                onSubmit={onSubmit}
                onClose={onClose}
            />
        </Modal>
    );
}
