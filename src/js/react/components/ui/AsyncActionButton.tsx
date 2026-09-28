import { useState } from 'react';
import * as ipc from '@/api/ipc';
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
    /** awaited after a successful result (every caller passes one) */
    onSuccess: () => unknown;
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
 * via ipc.logRendererError. Used by VoteButton, RunButton, and the
 * Vote All / Run buttons in ChallengesSection — each caller supplies its
 * own label, icon, and DaisyUI classes.
 */
export function AsyncActionButton({
    className,
    title,
    action,
    onSuccess,
    failureLogPrefix,
    errorLogPrefix,
    loadingLabel,
    idleContent,
    disabled = false,
}: AsyncActionButtonProps) {
    const [loading, setLoading] = useState(false);

    // No useCallback: every caller passes inline `action`/`onSuccess`
    // props, so memoizing on them would never hold — and the handler only
    // feeds a plain <button> onClick, where identity doesn't matter.
    const handleClick = async () => {
        setLoading(true);
        try {
            const result = await action();
            if (result?.success) {
                await onSuccess();
            } else {
                await ipc.logRendererError(`${failureLogPrefix}: ${result?.error || 'Unknown error'}`);
            }
        } catch (err) {
            await ipc.logRendererError(`${errorLogPrefix}: ${errorMessage(err) || err}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <button className={className} onClick={() => void handleClick()} disabled={loading || disabled} title={title}>
            {loading ? (
                <>
                    <span className="loading loading-spinner loading-xs" />
                    {loadingLabel}
                </>
            ) : (
                idleContent
            )}
        </button>
    );
}
