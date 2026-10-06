/**
 * The chooser's controls around the photo grid: the search box, and the footer with Save, Clear and
 * Cancel — Save and Clear held back, with the reason as a live region and a Retry where a retry can
 * lift the hold.
 */

import { useId, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

import type { ReactNode } from 'react';
import type { ListState, useSavedListReread } from '@/hooks/usePhotoChooser';

// What Save being held says, by the listing's state: loading will resolve by itself, an error needs
// Retry, and no context will not load at all, so it names the way out instead of a wait.
const SAVE_HOLD_HINT: Record<ListState['status'] | 'unconfirmed' | 'checking' | 'check-failed', string> = {
    unconfirmed: 'app.photoChooserSaveUnconfirmed',
    // The listing is ready and the saved list is being read: the photos have loaded, so say what is awaited.
    checking: 'app.photoChooserSaveChecking',
    'check-failed': 'app.photoChooserSaveCheckFailed',
    loading: 'app.photoChooserSaveWaits',
    ready: 'app.photoChooserSaveWaits',
    error: 'app.photoChooserSaveWaitsError',
    'no-context': 'app.photoChooserSaveNoContext',
};

/**
 * Why Save is held, as a live region (so the changing reason is announced; Save's description
 * points at it), and the Retry that can lift it. Retry sits outside the paragraph Save is described
 * by and stays mounted through the retry, so focus stays on it; it is aria-disabled and aria-busy
 * until the answer.
 */
function SaveHoldHint({
    id,
    holdReason,
    retrying,
    onRetry,
}: {
    id: string;
    holdReason: keyof typeof SAVE_HOLD_HINT;
    retrying: boolean;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    const retryable = retrying || holdReason === 'unconfirmed' || holdReason === 'check-failed';
    return (
        <div className="flex items-center justify-end gap-2">
            <p id={id} role="status" className="text-base-content/70 text-right text-xs">
                {t(SAVE_HOLD_HINT[holdReason])}
            </p>
            {retryable && (
                <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    aria-disabled={retrying}
                    aria-busy={retrying}
                    onClick={() => {
                        if (!retrying) onRetry();
                    }}
                >
                    {t('app.photoChooserRetry')}
                </button>
            )}
        </div>
    );
}

/**
 * A footer button that can be held back: aria-disabled rather than disabled, so it stays focusable
 * and the hint it points at can be reached, and a press is ignored while held.
 */
function HeldButton({
    held,
    hintId,
    className,
    disabled,
    onPress,
    children,
}: {
    held: boolean;
    hintId: string;
    className: string;
    disabled?: boolean;
    onPress: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            className={`btn btn-sm ${className} ${held ? 'btn-disabled' : ''}`}
            aria-disabled={held}
            aria-describedby={held ? hintId : undefined}
            onClick={() => {
                if (!held) onPress();
            }}
            disabled={disabled}
        >
            {children}
        </button>
    );
}

/**
 * The chooser's actions: save (held back, with its reason, while the account is unknown),
 * clear the selection (held with it while the saved list is unread: a late read would undo the
 * clear), cancel — and the error of a save that failed.
 */
export function ChooserFooter({
    saveFailed,
    saveWaits,
    holdReason,
    retrying,
    locked,
    onRetryHold,
    saving,
    onSave,
    onClear,
    onClose,
}: {
    saveFailed: boolean;
    saveWaits: boolean;
    /** Why Save is held: what the hint says to do about it differs. */
    holdReason: keyof typeof SAVE_HOLD_HINT;
    /** The saved list is unread: Clear is held with Save. */
    locked: boolean;
    /** A retry is under way. */
    retrying: boolean;
    /** Asks again, when the hold is one only a retry can lift. */
    onRetryHold: () => void;
    saving: boolean;
    onSave: () => void;
    onClear: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const hintId = useId();
    return (
        <>
            {saveFailed && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span>{t('app.photoChooserSaveError')}</span>
                </div>
            )}
            {saveWaits && (
                <SaveHoldHint id={hintId} holdReason={holdReason} retrying={retrying} onRetry={onRetryHold} />
            )}
            <div className="flex justify-end gap-2">
                <HeldButton held={saveWaits} hintId={hintId} className="btn-latvian" disabled={saving} onPress={onSave}>
                    {saving && <span className="loading loading-spinner loading-xs" />}
                    {t('app.photoChooserUse')}
                </HeldButton>
                <HeldButton held={locked} hintId={hintId} className="btn-warning" onPress={onClear}>
                    {t('app.photosClear')}
                </HeldButton>
                <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
                    {t('app.cancel')}
                </button>
            </div>
        </>
    );
}

/** The search box: submitting reads the listing again for the (trimmed) term. */
export function SearchForm({ onSearch }: { onSearch: (term: string) => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    return (
        <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                onSearch(text.trim());
            }}
        >
            <input
                type="search"
                className="input input-sm min-w-40 flex-1"
                aria-label={t('app.photoChooserSearchLabel')}
                placeholder={t('app.photoChooserSearchPlaceholder')}
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
            />
            <button type="submit" className="btn btn-outline btn-sm">
                {t('app.photoChooserSearch')}
            </button>
        </form>
    );
}

/**
 * What the hold on Save says: a retry or a read under way is "checking", an account that could not
 * be confirmed says so (or that the check failed again), and otherwise it is the listing's state.
 */
export const holdReasonOf = (
    saved: ReturnType<typeof useSavedListReread>,
    listState: ListState['status'],
): keyof typeof SAVE_HOLD_HINT => {
    if (saved.busy || saved.checking) return 'checking';
    if (saved.status !== 'unconfirmed') return listState;
    return saved.checkFailed ? 'check-failed' : 'unconfirmed';
};
