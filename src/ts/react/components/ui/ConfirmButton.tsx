import { useTranslation } from '@/contexts/TranslationContext';

/**
 * The confirming button of a dialog whose action is a call that takes a moment. It stays focusable while the call
 * is under way (aria-disabled, not disabled: a disabled button drops focus and announces nothing), says what it is
 * doing, and ignores clicks then.
 *
 * @param label - translation key of the button
 * @param workingLabel - translation key of the button while the call is out
 */
export function ConfirmButton({
    working,
    onConfirm,
    label,
    workingLabel,
}: {
    working: boolean;
    onConfirm: () => void;
    label: string;
    workingLabel: string;
}) {
    const { t } = useTranslation();
    return (
        <button
            className={`btn btn-error btn-sm ${working ? 'btn-disabled' : ''}`}
            onClick={() => {
                if (!working) onConfirm();
            }}
            aria-disabled={working}
            aria-busy={working}
        >
            {working ? t(workingLabel) : t(label)}
        </button>
    );
}
