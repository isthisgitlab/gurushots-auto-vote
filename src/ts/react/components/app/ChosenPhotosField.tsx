import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsChallengeId } from '@/contexts/SettingsChallengeContext';
import { useImageLoads } from '@/hooks/useImageLoads';
import { useChosenListAccount } from '@/api/useChosenPhotosOwner';
import { buildPhotoUrl } from '@/utils/formatters';
import { interp } from '@/utils/interp';
import { SettingResetButton } from './SettingResetButton';
import { PhotoChooserModal } from './PhotoChooserModal';

import type { SettingFieldProps } from '../../../types/settingsEditor';

// Edge length requested from the photo CDN for a chip; it renders at 32px.
const THUMB_PX = 64;

/** The photo ids a stored value holds (a hand-edited settings file may hold anything). */
const photoIdsOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/**
 * One chosen photo: its thumbnail when the owner's member id is trusted and the
 * image loads, else its id's start as text.
 */
function ChosenPhotoChip({ id, memberId }: { id: string; memberId: string | null }) {
    const { t } = useTranslation();
    const url = memberId ? buildPhotoUrl(memberId, id, { size: THUMB_PX }) : null;
    const showImage = useImageLoads(url);
    const short = id.slice(0, 8);
    return (
        <li className="inline-flex">
            {showImage ? (
                <img
                    src={url as string}
                    alt={interp(t('app.chosenPhotoThumbAlt'), { id: short })}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-8 w-8 rounded object-cover"
                />
            ) : (
                <span className="badge badge-ghost badge-sm">{short}</span>
            )}
        </li>
    );
}

/**
 * The chosen-photos control shared by every editor: the chosen photos as small
 * thumbnails, a button opening the chooser, and Clear. `value` null = nothing
 * set at this layer (a rule row inheriting); `onClear` decides what Clear
 * writes, `clearLabel` what it is called. A list saved under another account is
 * only counted, never shown.
 */
export function ChosenPhotosControl({
    id,
    value,
    onChange,
    onClear,
    clearLabel,
    disabled = false,
    challengeId = null,
}: {
    id?: string;
    value: string[] | null;
    onChange: (ids: string[]) => void;
    onClear: () => void;
    clearLabel: string;
    disabled?: boolean;
    challengeId?: string | number | null;
}) {
    const { t } = useTranslation();
    const { thumbMember: memberId, otherAccount } = useChosenListAccount();
    const [open, setOpen] = useState(false);
    const ids = value ?? [];
    return (
        <div className="flex flex-wrap items-center gap-2">
            {value === null ? (
                <span className="text-base-content/60 text-sm">{t('app.titleRuleInherit')}</span>
            ) : ids.length === 0 ? (
                <span className="text-base-content/60 text-sm">{t('app.none')}</span>
            ) : otherAccount ? (
                // Another account's photos are neither shown nor named, only counted.
                <span className="text-base-content/60 text-sm">
                    {interp(t('app.chosenPhotosOtherAccountCount'), { count: ids.length })}
                </span>
            ) : (
                <ul className="flex flex-wrap items-center gap-1" aria-label={t('app.chosenPhotos')}>
                    {ids.map((photoId) => (
                        <ChosenPhotoChip key={photoId} id={photoId} memberId={memberId} />
                    ))}
                </ul>
            )}
            <button
                id={id}
                type="button"
                className="btn btn-outline btn-sm"
                disabled={disabled}
                onClick={() => setOpen(true)}
            >
                {t('app.choosePhotos')}
            </button>
            {value !== null && (
                <button type="button" className="btn btn-outline btn-sm" disabled={disabled} onClick={onClear}>
                    {clearLabel}
                </button>
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
 * stores an explicit empty list, which overrides a list set at a lower layer.
 */
export function PhotosField({ id, settingKey, value, onChange, onReset, disabled }: SettingFieldProps) {
    const { t } = useTranslation();
    const challengeId = useSettingsChallengeId();
    return (
        <div className="flex flex-wrap items-center gap-2">
            <ChosenPhotosControl
                id={id}
                value={photoIdsOf(value)}
                onChange={(ids) => onChange(settingKey, ids)}
                onClear={() => onChange(settingKey, [])}
                clearLabel={t('app.photosClear')}
                disabled={disabled}
                challengeId={challengeId}
            />
            <SettingResetButton settingKey={settingKey} onReset={onReset} />
        </div>
    );
}

export { photoIdsOf };
