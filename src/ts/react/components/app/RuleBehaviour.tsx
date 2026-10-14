import { useId } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ChosenPhotosControl, photoIdsOf } from './ChosenPhotosField';
import { SettingHintList, chosenPhotosOnlyReachHint, manualPhotosOnlyHint } from './SettingHints';
import { isDroppedOffValue } from '../../../settings/ruleBehaviour';
import { RuleNumberField } from './RuleFields';

import type { LooseRecord, TitleRule } from '../../../types/settings';
import type { RuleFieldProps, RulePatchHandler } from './RuleFields';
import type { SettingHint } from '../../../types/settingsEditor';

// Tri-state boolean override. '' = inherit (the key is omitted from the saved
// rule entirely, so the rule never freezes today's default into storage);
// 'on'/'off' are explicit. Kept as strings because a <select> value is a string
// and `false` would otherwise round-trip through '' and read as "inherit".
const TRISTATE = { true: 'on', false: 'off' };

const triValue = (value: unknown): string => (value === true || value === false ? TRISTATE[`${value}`] : '');

const triPatch = (key: string, raw: string): LooseRecord => ({
    [key]: raw === 'on' ? true : raw === 'off' ? false : '',
});

// `onOnly`: a key whose `false` a rule never holds (see ON_ONLY_KEYS), so the select offers inherit / on alone.
// `hints` sit directly under the select.
function TristateSelect({
    rule,
    settingKey,
    labelKey,
    onPatch,
    onOnly = false,
    hints,
}: RuleFieldProps & { onOnly?: boolean; hints: SettingHint[] }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t(labelKey)}</span>
            <select
                aria-label={t(labelKey)}
                className="select select-sm w-full"
                value={isDroppedOffValue(settingKey, rule[settingKey]) ? '' : triValue(rule[settingKey])}
                onChange={(event) => onPatch(triPatch(settingKey, event.currentTarget.value))}
            >
                <option value="">{t('app.titleRuleInherit')}</option>
                <option value="on">{t('app.titleRuleOn')}</option>
                {!onOnly && <option value="off">{t('app.titleRuleOff')}</option>}
            </select>
            <SettingHintList hints={hints} />
        </div>
    );
}

// Inline behaviour overrides: inherit when blank.
const TRISTATE_OVERRIDES = [
    { settingKey: 'autoJoin', labelKey: 'app.titleRuleAutoJoin' },
    { settingKey: 'autoFill', labelKey: 'app.titleRuleAutoFill' },
    { settingKey: 'chosenPhotosOnly', labelKey: 'app.chosenPhotosOnly' },
    { settingKey: 'chosenPhotosInOrder', labelKey: 'app.chosenPhotosInOrder' },
    { settingKey: 'manualPhotosOnly', labelKey: 'app.manualPhotosOnly', onOnly: true },
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
                    <TristateSelect
                        key={field.settingKey}
                        {...field}
                        rule={rule}
                        onPatch={onPatch}
                        hints={
                            field.settingKey === 'manualPhotosOnly' && rule.manualPhotosOnly === true
                                ? [manualPhotosOnlyHint(t, 'app.manualPhotosOnlyRuleHint')]
                                : []
                        }
                    />
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
