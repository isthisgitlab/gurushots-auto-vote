import { useId, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsChallengeId } from '@/contexts/SettingsChallengeContext';
import { SAVE_ERROR_ID } from '@/components/ui/ModalActionRow';
import { SettingResetButton } from './SettingResetButton';
import { PhotoChooserModal } from './PhotoChooserModal';

import type { SettingFieldProps } from '../../../types/settingsEditor';

/** The photo ids a stored value holds (a hand-edited settings file may hold anything). */
const photoIdsOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/**
 * One chosen photo: a text chip with its position and its id's start.
 */
function ChosenPhotoChip({ id, position }: { id: string; position: number }) {
    const short = id.slice(0, 8);
    return (
        <li className="inline-flex items-center gap-0.5">
            {/* The saved order, read as it is by a text chip. */}
            <span className="badge badge-neutral badge-xs">{position}</span>
            <span className="badge badge-ghost badge-sm">{short}</span>
        </li>
    );
}

/**
 * The chosen-photos control shared by every editor: the chosen photos as chips, a button opening the
 * chooser, and Clear. `value` null = nothing
 * set at this layer (a rule row inheriting); `onClear` decides what Clear
 * writes, `clearLabel` what it is called, and `clearHint` (when given) says in words what it does.
 */
export function ChosenPhotosControl({
    id,
    value,
    onChange,
    onClear,
    clearLabel,
    clearHint,
    disabled = false,
    invalid = false,
    challengeId = null,
}: {
    id?: string;
    value: string[] | null;
    onChange: (ids: string[]) => void;
    onClear: () => void;
    clearLabel: string;
    clearHint?: string;
    disabled?: boolean;
    /** The last Save refused this setting: the button that takes focus names the save-failed alert (a button cannot carry aria-invalid). */
    invalid?: boolean;
    challengeId?: string | number | null;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const hintId = useId();
    const ids = value ?? [];
    return (
        <div className="flex flex-wrap items-center gap-2">
            {value === null ? (
                <span className="text-base-content/70 text-sm">{t('app.titleRuleInherit')}</span>
            ) : ids.length === 0 ? (
                <span className="text-base-content/70 text-sm">{t('app.none')}</span>
            ) : (
                <ul className="flex flex-wrap items-center gap-1" aria-label={t('app.chosenPhotos')}>
                    {ids.map((photoId, index) => (
                        <ChosenPhotoChip key={photoId} id={photoId} position={index + 1} />
                    ))}
                </ul>
            )}
            <button
                id={id}
                type="button"
                className="btn btn-outline btn-sm"
                disabled={disabled}
                aria-describedby={invalid ? SAVE_ERROR_ID : undefined}
                onClick={() => setOpen(true)}
            >
                {t('app.choosePhotos')}
            </button>
            {value !== null && (
                <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={disabled}
                    aria-describedby={clearHint ? hintId : undefined}
                    onClick={onClear}
                >
                    {clearLabel}
                </button>
            )}
            {value !== null && clearHint && (
                <p id={hintId} className="basis-full text-xs text-base-content/70">
                    {clearHint}
                </p>
            )}
            <PhotoChooserModal
                isOpen={open}
                onClose={() => setOpen(false)}
                value={ids}
                challengeId={challengeId}
                onSave={(chosen) => {
                    onChange(chosen);
                    return true;
                }}
            />
        </div>
    );
}

/**
 * A schema `photos` setting: the chosen-photos control, with the surrounding
 * editor's challenge (if any) as the chooser's eligibility context. Clear
 * stores an explicit empty list, which overrides a list set at a lower layer:
 * in a challenge's settings it is offered as "Use none", with a hint that the
 * reset button brings the inherited list back.
 */
export function PhotosField({
    id,
    settingKey,
    config,
    value,
    onChange,
    onReset,
    disabled,
    rejected,
}: SettingFieldProps) {
    const { t } = useTranslation();
    const challengeId = useSettingsChallengeId();
    return (
        <div className="flex flex-wrap items-center gap-2">
            <ChosenPhotosControl
                id={id}
                value={photoIdsOf(value)}
                onChange={(ids) => onChange(settingKey, ids)}
                onClear={() => onChange(settingKey, [])}
                clearLabel={t(challengeId === null ? 'app.photosClear' : 'app.photosUseNone')}
                clearHint={challengeId === null ? undefined : t('app.photosUseNoneHint')}
                disabled={disabled}
                invalid={rejected}
                challengeId={challengeId}
            />
            <SettingResetButton settingKey={settingKey} labelKey={config.label} onReset={onReset} />
        </div>
    );
}

export { photoIdsOf };
