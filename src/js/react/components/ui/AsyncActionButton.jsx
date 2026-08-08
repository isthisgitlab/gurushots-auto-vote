import { useState } from 'react';

/**
 * Shared envelope for a button that fires an async IPC action: toggles a
 * local loading state (spinner + loading label while pending), calls
 * `onSuccess` when the result reports success, and logs failures/throws
 * via window.api.logError. Extracted from the identical bodies of
 * VoteButton, RunButton, and the Vote All / Run buttons in
 * ChallengesSection — each caller keeps its exact label, icon, and
 * DaisyUI classes.
 *
 * @param {object} props
 * @param {string} props.className        - full DaisyUI class string for the <button>
 * @param {string} [props.title]          - optional tooltip
 * @param {() => Promise<{success?: boolean, error?: string}>} props.action
 * @param {Function} [props.onSuccess]    - awaited after a successful result
 * @param {string} props.failureLogPrefix - logError prefix for `{success:false}` results
 * @param {string} props.errorLogPrefix   - logError prefix for thrown errors
 * @param {import('react').ReactNode} props.loadingLabel - text next to the spinner
 * @param {import('react').ReactNode} props.idleContent  - button content when idle
 * @param {boolean} [props.disabled]      - extra disable condition (ORed with loading)
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
                if (onSuccess) await onSuccess();
            } else {
                await window.api.logError(`${failureLogPrefix}: ${result?.error || 'Unknown error'}`);
            }
        } catch (err) {
            await window.api.logError(`${errorLogPrefix}: ${err.message || err}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <button className={className} onClick={handleClick} disabled={loading || disabled} title={title}>
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
