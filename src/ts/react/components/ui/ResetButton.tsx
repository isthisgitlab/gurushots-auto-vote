import { StrokeIcon, ICON_PATHS } from './StrokeIcon';

/**
 * Shared "reset to default" iconography. ResetIcon is exported separately for
 * callers that embed the glyph in a differently-styled button (action rows,
 * refresh button).
 */
export function ResetIcon({ className = 'w-4 h-4' }: { className?: string }) {
    return <StrokeIcon d={ICON_PATHS.reset} className={className} />;
}

/**
 * Small outlined icon button that resets a setting to its default. Uses
 * `btn btn-outline btn-sm` with the ResetIcon. The icon carries no text, so `label` is
 * the button's accessible name and its tooltip.
 */
export function ResetButton({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button type="button" className="btn btn-outline btn-sm" title={label} aria-label={label} onClick={onClick}>
            <ResetIcon />
        </button>
    );
}
