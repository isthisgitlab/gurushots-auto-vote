import { useTranslation } from '@/contexts/TranslationContext';

import type { ComponentChildren } from 'preact';

/**
 * A failed action's message next to the control that failed. It is announced when it appears (role="alert") and
 * stays until the user dismisses it or starts the next action — a message that vanishes on a timer is gone before a
 * screen-reader user or a slow reader gets to it.
 *
 * @param props.onDismiss - clears the message; the dismiss button shows only when this is given
 * @param props.className - layout classes of the wrapper (spacing, display)
 */
export function InlineError({
    children,
    onDismiss,
    className = '',
}: {
    children: ComponentChildren;
    onDismiss?: () => void;
    className?: string;
}) {
    const { t } = useTranslation();
    return (
        <div role="alert" className={`text-error text-xs ${className}`.trim()}>
            <span>{children}</span>
            {onDismiss && (
                <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-square ml-1 align-middle"
                    aria-label={t('errors.dismiss')}
                    title={t('errors.dismiss')}
                    onClick={onDismiss}
                >
                    <span aria-hidden="true">×</span>
                </button>
            )}
        </div>
    );
}
