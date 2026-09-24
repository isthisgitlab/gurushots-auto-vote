import { AsyncActionButton } from './AsyncActionButton';
import { StrokeIcon } from './StrokeIcon';

/**
 * AsyncActionButton whose idle content is a StrokeIcon followed by a label —
 * the shape of the per-card Vote / Run buttons and the list-wide Vote All /
 * Run buttons. Every other prop passes straight through.
 *
 * @param {object} props
 * @param {string} props.icon            - StrokeIcon path data (ICON_PATHS entry)
 * @param {import('react').ReactNode} props.label - idle label after the icon
 */
export function IconActionButton({ icon, label, ...buttonProps }) {
    return (
        <AsyncActionButton
            {...buttonProps}
            idleContent={
                <>
                    <StrokeIcon d={icon} className="w-4 h-4 mr-1" />
                    {label}
                </>
            }
        />
    );
}
