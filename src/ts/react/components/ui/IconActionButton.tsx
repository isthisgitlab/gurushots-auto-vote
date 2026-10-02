import { AsyncActionButton } from './AsyncActionButton';
import { StrokeIcon } from './StrokeIcon';
import type { AsyncActionButtonProps } from './AsyncActionButton';
import type { ComponentChildren } from 'preact';

/**
 * AsyncActionButton whose idle content is a StrokeIcon followed by a label —
 * the shape of the per-card Vote / Run buttons and the list-wide Vote All /
 * Run buttons. Every other prop passes straight through.
 *
 * @param props - `icon` is StrokeIcon path data (an ICON_PATHS entry); `label` is the idle label after the icon.
 */
export function IconActionButton({
    icon,
    label,
    ...buttonProps
}: Omit<AsyncActionButtonProps, 'idleContent'> & {
    icon: string | string[];
    label: ComponentChildren;
}) {
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
