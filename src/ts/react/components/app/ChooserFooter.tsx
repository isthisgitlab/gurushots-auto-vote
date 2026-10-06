/**
 * The chooser's controls around the photo grid: the search box, and the footer with Save, Clear and
 * Cancel — Save and Clear held back, with the reason as a live region and a Retry where a retry can
 * lift the hold.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

import type { ReactNode, RefObject } from 'react';
import type { ListState, useSavedListReread } from '@/hooks/usePhotoChooser';

// What Save being held says, by the listing's state: loading will resolve by itself, an error needs
// Retry, and no context will not load at all, so it names the way out instead of a wait.
const SAVE_HOLD_HINT: Record<
    | ListState['status']
    | 'unconfirmed'
    | 'checking'
    | 'check-failed'
    | 'not-logged-in'
    | 'read-failed'
    | 'read-failed-again'
    | 'no-context-held',
    string
> = {
    unconfirmed: 'app.photoChooserSaveUnconfirmed',
    // The account is known but the saved list could not be read: its own words, and a repeat's.
    'read-failed': 'app.photoChooserSaveReadFailed',
    'read-failed-again': 'app.photoChooserSaveReadFailedAgain',
    // Signed out: Retry cannot help.
    'not-logged-in': 'app.photoChooserSaveNotLoggedIn',
    // No challenge to read the library through while the saved list is unread: Clear is held too, so
    // the hint names only the ways out that exist.
    'no-context-held': 'app.photoChooserSaveNoContextHeld',
    // The listing is ready and the saved list is being read: the photos have loaded, so say what is awaited.
    checking: 'app.photoChooserSaveChecking',
    'check-failed': 'app.photoChooserSaveCheckFailed',
    loading: 'app.photoChooserSaveWaits',
    ready: 'app.photoChooserSaveWaits',
    error: 'app.photoChooserSaveWaitsError',
    'no-context': 'app.photoChooserSaveNoContext',
};

// The holds a Retry can lift.
const RETRYABLE_HOLDS: ReadonlyArray<keyof typeof SAVE_HOLD_HINT> = [
    'unconfirmed',
    'check-failed',
    'read-failed',
    'read-failed-again',
];

/**
 * A live region that stays mounted, so what it says is announced when it changes: why Save is held
 * (Save's description points at it), or — once a Retry has lifted the hold — that the account is
 * confirmed. The Retry that can lift a hold sits outside the paragraph and stays mounted through the
 * retry (the account check and the read after it), so focus stays on it; it is aria-disabled,
 * aria-busy and shows a spinner until the answer.
 */
function HoldStatus({
    id,
    statusRef,
    message,
    showRetry,
    retrying,
    onRetry,
}: {
    id: string;
    /** Where focus goes when the Retry the user was on goes away and Save is still held. */
    statusRef: RefObject<HTMLParagraphElement | null>;
    message: string | null;
    showRetry: boolean;
    retrying: boolean;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-end gap-2">
            <p id={id} ref={statusRef} tabIndex={-1} role="status" className="text-base-content/70 text-right text-xs">
                {message && t(message)}
            </p>
            {(showRetry || retrying) && (
                <button
                    type="button"
                    className={`btn btn-outline btn-xs ${retrying ? 'btn-disabled' : ''}`}
                    aria-disabled={retrying}
                    aria-busy={retrying}
                    onClick={() => {
                        if (!retrying) onRetry();
                    }}
                >
                    {retrying && <span className="loading loading-spinner loading-xs" />}
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
    buttonRef,
    onPress,
    children,
}: {
    held: boolean;
    /** The element that says why it is held. */
    hintId: string;
    className: string;
    disabled?: boolean;
    buttonRef?: RefObject<HTMLButtonElement | null>;
    onPress: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            ref={buttonRef}
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
 * Save, Clear and Cancel. Save is held (`saveWaits`) with the status line as its description; Clear is
 * held while the saved list is unread (`locked`), with its own short description of why.
 */
function FooterActions({
    saveWaits,
    locked,
    hintId,
    saving,
    saveRef,
    onSave,
    onClear,
    onClose,
}: {
    saveWaits: boolean;
    locked: boolean;
    hintId: string;
    saving: boolean;
    saveRef: RefObject<HTMLButtonElement | null>;
    onSave: () => void;
    onClear: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const clearHintId = useId();
    return (
        <div className="flex justify-end gap-2">
            <HeldButton
                held={saveWaits}
                hintId={hintId}
                className="btn-latvian"
                disabled={saving}
                buttonRef={saveRef}
                onPress={onSave}
            >
                {saving && <span className="loading loading-spinner loading-xs" />}
                {t('app.photoChooserUse')}
            </HeldButton>
            <HeldButton held={locked} hintId={clearHintId} className="btn-warning" onPress={onClear}>
                {t('app.photosClear')}
            </HeldButton>
            {locked && (
                <span id={clearHintId} className="sr-only">
                    {t('app.photoChooserClearHeld')}
                </span>
            )}
            <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
                {t('app.cancel')}
            </button>
        </div>
    );
}

/** Focus is nowhere: on the page itself, or on an element that has just been removed. */
const focusIsLost = (): boolean => {
    const active = document.activeElement;
    return active === null || active === document.body || !active.isConnected;
};

/**
 * The chooser's actions: save (held back, with its reason, while the account is unknown),
 * clear the selection (held with it while the saved list is unread: a late read would undo the
 * clear; its own description says so), cancel — and the error of a save that failed.
 *
 * When the Retry button goes (the hold lifted, signed out, another account, the listing reloading)
 * while focus was on it, focus would drop to the page. It moves to Save if Save is free, else to
 * the status line (which holds the reason), so it is always somewhere stable; once the hold lifts
 * after a pressed Retry it moves on to Save. Focus anywhere else — the search box, Cancel — is
 * never taken.
 */
export function ChooserFooter({
    saveFailed,
    saveWaits,
    holdReason,
    retrying,
    confirmed,
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
    /** A retry is under way (the check and the read after it). */
    retrying: boolean;
    /** A pressed Retry has lifted the hold and the list is read. */
    confirmed: boolean;
    /** Asks again, when the hold is one only a retry can lift. */
    onRetryHold: () => void;
    saving: boolean;
    onSave: () => void;
    onClear: () => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const hintId = useId();
    const saveRef = useRef<HTMLButtonElement>(null);
    const statusRef = useRef<HTMLParagraphElement>(null);
    const retryShown = (saveWaits && RETRYABLE_HOLDS.includes(holdReason)) || retrying;
    const wasShown = useRef(false);
    useEffect(() => {
        const gone = wasShown.current && !retryShown;
        wasShown.current = retryShown;
        if (gone && focusIsLost()) (saveWaits ? statusRef : saveRef).current?.focus();
    }, [retryShown, saveWaits]);
    // The hold has lifted after a pressed Retry: from the page or from the status line (where focus
    // was parked while Retry was away) it goes to Save; anywhere the user put it, it stays.
    useEffect(() => {
        if (confirmed && (focusIsLost() || document.activeElement === statusRef.current)) saveRef.current?.focus();
    }, [confirmed]);
    const message = saveWaits ? SAVE_HOLD_HINT[holdReason] : confirmed ? 'app.photoChooserSaveConfirmed' : null;
    return (
        <>
            {saveFailed && (
                <div role="alert" className="alert alert-error py-2 text-sm">
                    <span>{t('app.photoChooserSaveError')}</span>
                </div>
            )}
            <HoldStatus
                id={hintId}
                statusRef={statusRef}
                message={message}
                showRetry={retryShown}
                retrying={retrying}
                onRetry={onRetryHold}
            />
            <FooterActions
                saveWaits={saveWaits}
                locked={locked}
                hintId={hintId}
                saving={saving}
                onSave={onSave}
                onClear={onClear}
                onClose={onClose}
                saveRef={saveRef}
            />
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
 * What the hold on Save says: a retry or a read under way is "checking"; with no challenge to read
 * the library through while the saved list is unread, the way out that exists (Clear is held too);
 * a list that could not be read for this account says which failure it was; otherwise it is the
 * listing's state.
 */
export const holdReasonOf = (
    saved: ReturnType<typeof useSavedListReread>,
    listState: ListState['status'],
): keyof typeof SAVE_HOLD_HINT => {
    if (saved.busy || saved.checking) return 'checking';
    if (listState === 'no-context' && saved.status !== 'ok') return 'no-context-held';
    return saved.failure ?? listState;
};
