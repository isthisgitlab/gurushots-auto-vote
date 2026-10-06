import { useTranslation } from '@/contexts/TranslationContext';
import { TagsField } from './SettingInput';
import { useScenarios } from '@/api/useScenarios';
import { interp } from '@/utils/interp';

import type { LooseRecord, TitleRule } from '../../../types/settings';

/**
 * A rule edit merged over the rule. A cleared field is '' (inherit / any)
 * until the settings sanitizer drops it on save, so a patch is loose.
 */
export type RulePatchHandler = (patch: LooseRecord) => void;

/**
 * The props of one rule-bound field.
 */
export type RuleFieldProps = { rule: TitleRule; settingKey: string; labelKey: string; onPatch: RulePatchHandler };

/**
 * A number field that distinguishes "empty" from an explicit 0.
 *
 * An empty field is saved as '' — for a behaviour override that means inherit,
 * for a runtime condition "any length" — and the settings sanitizer drops it.
 * 0 is the explicit "off" value for an override, so this cannot just coerce
 * with Number().
 */
export function RuleNumberField({
    rule,
    settingKey,
    labelKey,
    unitKey,
    placeholderKey,
    min,
    max,
    onPatch,
}: RuleFieldProps & { unitKey: string; placeholderKey: string; min: number; max: number }) {
    const { t } = useTranslation();
    const raw = rule[settingKey];
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t(labelKey)}</span>
            {/* A div, not a <label>: the input carries its own aria-label, and a
                wrapping label without a matching id trips jsx-a11y/label-has-for. */}
            <div className="input input-sm flex items-center gap-2">
                <input
                    type="number"
                    min={min}
                    max={max}
                    step="1"
                    className="grow"
                    aria-label={t(labelKey)}
                    placeholder={t(placeholderKey)}
                    // A stored number or a draft ''; the DOM coerces either.
                    value={raw === null || raw === undefined ? '' : (raw as number | string)}
                    onChange={(event) => {
                        const next = event.currentTarget.value;
                        onPatch({ [settingKey]: next === '' ? '' : Number(next) });
                    }}
                />
                <span className="text-xs opacity-60">{t(unitKey)}</span>
            </div>
        </div>
    );
}

// Must/Should Include PHOTO tags merged in at fill time.
export const TAG_FIELDS = [
    { settingKey: 'mustIncludeTags', labelKey: 'app.mustIncludeTags' },
    { settingKey: 'shouldIncludeTags', labelKey: 'app.shouldIncludeTags' },
];

export function RuleProfileSelect({
    rule,
    profiles,
    onPatch,
}: {
    rule: TitleRule;
    profiles: Record<string, unknown>;
    onPatch: RulePatchHandler;
}) {
    const { t } = useTranslation();
    const names = Object.keys(profiles).sort();
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t('app.titleRuleProfile')}</span>
            <select
                aria-label={t('app.titleRuleProfile')}
                className="select select-sm w-full"
                value={rule.profile ?? ''}
                onChange={(event) => onPatch({ profile: event.currentTarget.value })}
            >
                <option value="">{t('app.none')}</option>
                {names.map((name) => (
                    <option key={name} value={name}>
                        {name}
                    </option>
                ))}
            </select>
        </div>
    );
}

// The scenario the rule assigns inline ('' = inherit). A name that no longer
// exists stays listed, marked missing, like the per-challenge picker.
export function RuleScenarioSelect({ rule, onPatch }: { rule: TitleRule; onPatch: RulePatchHandler }) {
    const { t } = useTranslation();
    const { scenarios } = useScenarios();
    const names = Object.keys(scenarios);
    // The sanitizer stores `scenario` as a name string.
    const current = (rule.scenario ?? '') as string;
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t('app.scenario')}</span>
            <select
                aria-label={t('app.scenario')}
                className="select select-sm w-full"
                value={current}
                onChange={(event) => onPatch({ scenario: event.currentTarget.value })}
            >
                <option value="">{t('app.titleRuleInherit')}</option>
                {names.map((name) => (
                    <option key={name} value={name}>
                        {name}
                    </option>
                ))}
                {current !== '' && !names.includes(current) && (
                    <option value={current}>{interp(t('app.scenarioMissingOption'), { name: current })}</option>
                )}
            </select>
        </div>
    );
}

export function RuleTagsField({ index, rule, settingKey, labelKey, onPatch }: RuleFieldProps & { index: number }) {
    const { t } = useTranslation();
    const id = `title-rule-${index}-${settingKey}`;
    return (
        <div className="flex flex-col">
            <label className="label py-1" htmlFor={id}>
                <span className="text-sm">{t(labelKey)}</span>
            </label>
            <TagsField
                id={id}
                settingKey={settingKey}
                value={rule[settingKey]}
                onChange={(_key, tags) => onPatch({ [settingKey]: tags })}
                placeholder={t('app.tagsPlaceholder')}
            />
        </div>
    );
}
