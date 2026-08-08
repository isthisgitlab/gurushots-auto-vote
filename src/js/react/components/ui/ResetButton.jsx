/**
 * Shared "reset to default" iconography. The circular-arrows SVG was
 * copy-pasted across SettingInput, SettingsModal, and ChallengesSection;
 * it lives here once now. ResetIcon is exported separately for callers
 * that embed the glyph in a differently-styled button (action rows,
 * refresh button).
 */

export function ResetIcon({ className = 'w-4 h-4' }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
        </svg>
    );
}

/**
 * Small ghost icon button that resets a setting to its default. Renders
 * exactly the markup the inline copies produced: `btn btn-ghost btn-sm`
 * with the ResetIcon; `title` is optional (omitted → no attribute).
 */
export function ResetButton({ title, onClick }) {
    return (
        <button className="btn btn-ghost btn-sm" title={title} onClick={onClick}>
            <ResetIcon />
        </button>
    );
}
