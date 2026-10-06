import { useId } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ChosenPhotosControl, photoIdsOf } from './ChosenPhotosField';
import { SettingHintList, chosenPhotosOnlyReachHint } from './SettingHints';
import { RuleNumberField } from './RuleFields';

import type { LooseRecord, TitleRule } from '../../../types/settings';
import type { RuleFieldProps, RulePatchHandler } from './RuleFields';

// Tri-state boolean override. '' = inherit (the key is omitted from the saved
// rule entirely, so the rule never freezes today's default into storage);
// 'on'/'off' are explicit. Kept as strings because a <select> value is a string
// and `false` would otherwise round-trip through '' and read as "inherit".
const TRISTATE = { true: 'on', false: 'off' };

const triValue = (value: unknown): string => (value === true || value === false ? TRISTATE[`${value}`] : '');

const triPatch = (key: string, raw: string): LooseRecord => ({
    [key]: raw === 'on' ? true : raw === 'off' ? false : '',
});

function TristateSelect({ rule, settingKey, labelKey, onPatch }: RuleFieldProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t(labelKey)}</span>
            <select
                aria-label={t(labelKey)}
                className="select select-sm w-full"
                value={triValue(rule[settingKey])}
                onChange={(event) => onPatch(triPatch(settingKey, event.currentTarget.value))}
            >
                <option value="">{t('app.titleRuleInherit')}</option>
                <option value="on">{t('app.titleRuleOn')}</option>
                <option value="off">{t('app.titleRuleOff')}</option>
            </select>
        </div>
    );
}

// Inline behaviour overrides: inherit when blank.
const TRISTATE_OVERRIDES = [
    { settingKey: 'autoJoin', labelKey: 'app.titleRuleAutoJoin' },
    { settingKey: 'autoFill', labelKey: 'app.titleRuleAutoFill' },
    { settingKey: 'chosenPhotosOnly', labelKey: 'app.chosenPhotosOnly' },
];
const JOIN_TIMING_FIELDS = [
    {
        settingKey: 'autoJoinAfterPercentElapsed',
        labelKey: 'app.titleRulePercentElapsed',
        unitKey: 'app.unitPercent',
        placeholderKey: 'app.titleRuleJoinWindowPlaceholder',
        min: 0,
        max: 99,
    },
    {
        settingKey: 'autoJoinWithinHoursOfEnd',
        labelKey: 'app.titleRuleJoinWindow',
        unitKey: 'app.unitHours',
        placeholderKey: 'app.titleRuleJoinWindowPlaceholder',
        min: 0,
        max: 720,
    },
];

// The rule's chosen photos: an explicit list (an empty one means "none", beating a
// lower layer's list) or inherit, which is how the rule stores ''.
function RulePhotosField({ rule, onPatch }: { rule: TitleRule; onPatch: RulePatchHandler }) {
    const { t } = useTranslation();
    const labelId = useId();
    return (
        <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1">
            <span id={labelId} className="text-sm">
                {t('app.chosenPhotos')}
            </span>
            <ChosenPhotosControl
                value={Array.isArray(rule.chosenPhotos) ? photoIdsOf(rule.chosenPhotos) : null}
                onChange={(ids) => onPatch({ chosenPhotos: ids })}
                onClear={() => onPatch({ chosenPhotos: '' })}
                clearLabel={t('app.titleRuleInherit')}
            />
        </div>
    );
}

export function RuleBehaviour({ rule, onPatch }: { rule: TitleRule; onPatch: RulePatchHandler }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-2">
            <span className="text-sm font-medium">{t('app.titleRuleOverridesLabel')}</span>
            <div className="grid gap-2 sm:grid-cols-2">
                {TRISTATE_OVERRIDES.map((field) => (
                    <TristateSelect key={field.settingKey} {...field} rule={rule} onPatch={onPatch} />
                ))}
                {JOIN_TIMING_FIELDS.map((field) => (
                    <RuleNumberField key={field.settingKey} {...field} rule={rule} onPatch={onPatch} />
                ))}
            </div>
            <RulePhotosField rule={rule} onPatch={onPatch} />
            {rule.chosenPhotosOnly === true && <SettingHintList hints={[chosenPhotosOnlyReachHint(t)]} />}
        </div>
    );
}
