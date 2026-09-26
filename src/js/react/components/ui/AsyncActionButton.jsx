import { useState } from 'react';
import * as ipc from '@/api/ipc';

/**
 * Props of AsyncActionButton.
 *
 * @typedef {object} AsyncActionButtonProps
 * @property {string} className        - full DaisyUI class string for the <button>
 * @property {string} [title]          - optional tooltip
 * @property {() => Promise<{success?: boolean, error?: string} | null | undefined>} action
 * @property {() => unknown} onSuccess - awaited after a successful result (every caller passes one)
 * @property {string} failureLogPrefix - logError prefix for `{success:false}` results
 * @property {string} errorLogPrefix   - logError prefix for thrown errors
 * @property {import('preact').ComponentChildren} loadingLabel - text next to the spinner
 * @property {import('preact').ComponentChildren} idleContent  - button content when idle
 * @property {boolean} [disabled]      - extra disable condition (ORed with loading)
 */

/**
 * Shared envelope for a button that fires an async IPC action: toggles a
 * local loading state (spinner + loading label while pending), calls
 * `onSuccess` when the result reports success, and logs failures/throws
 * via ipc.logRendererError. Used by VoteButton, RunButton, and the
 * Vote All / Run buttons in ChallengesSection — each caller supplies its
 * own label, icon, and DaisyUI classes.
 *
 * @param {AsyncActionButtonProps} props
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
}) {
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
            await ipc.logRendererError(
                `${errorLogPrefix}: ${/** @type {{ message?: unknown } | null | undefined} */ (err)?.message || err}`,
            );
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
