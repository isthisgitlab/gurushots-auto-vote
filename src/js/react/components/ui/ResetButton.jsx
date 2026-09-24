import { StrokeIcon, ICON_PATHS } from './StrokeIcon';

/**
 * Shared "reset to default" iconography. ResetIcon is exported separately for
 * callers that embed the glyph in a differently-styled button (action rows,
 * refresh button).
 */
export function ResetIcon({ className = 'w-4 h-4' }) {
    return <StrokeIcon d={ICON_PATHS.reset} className={className} />;
}

/**
 * Small outlined icon button that resets a setting to its default. Renders
 * exactly the markup the inline copies produced: `btn btn-outline btn-sm`
 * with the ResetIcon; `title` is optional (omitted → no attribute).
 */
export function ResetButton({ title, onClick }) {
    return (
        <button className="btn btn-outline btn-sm" title={title} onClick={onClick}>
            <ResetIcon />
        </button>
    );
}
