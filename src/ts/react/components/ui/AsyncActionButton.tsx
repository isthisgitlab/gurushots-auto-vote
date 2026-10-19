import { useState } from 'react';
import * as ipc from '@/api/ipc';
import { ipcErrorText } from '@/api/ipcErrorText';
import { useTranslation } from '@/contexts/TranslationContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { ComponentChildren } from 'preact';
import { errorMessage } from '../../../errorMessage';

/**
 * Props of AsyncActionButton.
 */
export interface AsyncActionButtonProps {
    /** full DaisyUI class string for the <button> */
    className: string;
    /** optional tooltip */
    title?: string;
    action: () => Promise<{ success?: boolean; error?: string } | null | undefined>;
    /** awaited after a successful result (every caller passes one); a throw from it is logged, not shown */
    onSuccess: () => unknown;
    /** told `null` when a press starts and the translated message when the action fails — the caller shows it */
    onError: (message: string | null) => void;
    /** logError prefix for `{success:false}` results */
    failureLogPrefix: string;
    /** logError prefix for thrown errors */
    errorLogPrefix: string;
    /** text next to the spinner */
    loadingLabel: ComponentChildren;
    /** button content when idle */
    idleContent: ComponentChildren;
    /** extra disable condition (ORed with loading) */
    disabled?: boolean;
}

/**
 * Shared envelope for a button that fires an async IPC action: toggles a
 * local loading state (spinner + loading label while pending), calls
 * `onSuccess` when the result reports success, and logs failures/throws
 * via ipc.logRendererError and reports them through `onError`. Used by VoteButton, RunButton, and the
 * Vote All / Run buttons in ChallengesSection — each caller supplies its
 * own label, icon, and DaisyUI classes.
 */
export function AsyncActionButton({
    className,
    title,
    action,
    onSuccess,
    onError,
    failureLogPrefix,
    errorLogPrefix,
    loadingLabel,
    idleContent,
    disabled = false,
}: AsyncActionButtonProps) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);

    // No useCallback: every caller passes inline `action`/`onSuccess`
    // props, so memoizing on them would never hold — and the handler only
    // feeds a plain <button> onClick, where identity doesn't matter.
    const logThrown = (err: unknown) => ipc.logRendererError(`${errorLogPrefix}: ${errorMessage(err) || err}`);

    const handleClick = async () => {
        setLoading(true);
        onError(null);
        try {
            let result;
            try {
                result = await action();
            } catch (err) {
                await logThrown(err);
                onError(t('errors.actionFailed'));
                return;
            }
            if (!result?.success) {
                await ipc.logRendererError(`${failureLogPrefix}: ${result?.error || 'Unknown error'}`);
                onError(ipcErrorText(result?.error, t) || t('errors.actionFailed'));
                return;
            }
            // The action landed: a refetch that fails now is not the action's failure.
            try {
                await onSuccess();
            } catch (err) {
                await logThrown(err);
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            className={className}
            onClick={() => void handleClick()}
            disabled={loading || disabled}
            aria-busy={loading}
            title={title}
        >
            {loading ? (
                <>
                    <LoadingSpinner size="xs" decorative />
                    {loadingLabel}
                </>
            ) : (
                idleContent
            )}
        </button>
    );
}
