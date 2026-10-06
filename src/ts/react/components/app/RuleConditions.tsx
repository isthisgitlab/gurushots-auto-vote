import { useTranslation } from '@/contexts/TranslationContext';
import { RuleNumberField } from './RuleFields';

import type { TitleRule } from '../../../types/settings';
import type { RulePatchHandler } from './RuleFields';

/**
 * Photo counts a rule may be keyed on. GuruShots challenges carry at most four
 * submissions, and the settings sanitizer bounds the stored value independently
 * — this list only decides what the dropdown offers.
 */
const PICS_CHOICES = [1, 2, 3, 4];

// Mirrors MAX_RULE_RUNTIME_HOURS in settings/challengeRules.ts; the sanitizer is
// the real gate.
const MAX_RUNTIME_HOURS = 2000;

// Runtime-range conditions: any-length when blank.
const RUNTIME_FIELDS = [
    { settingKey: 'minHours', labelKey: 'app.titleRuleMinHours' },
    { settingKey: 'maxHours', labelKey: 'app.titleRuleMaxHours' },
].map((field) => ({
    ...field,
    unitKey: 'app.unitHours',
    placeholderKey: 'app.titleRuleAnyLength',
    min: 1,
    max: MAX_RUNTIME_HOURS,
}));

// The end time the challenge card shows (app timezone, any date); blank = any time.
function RuleClosesAtField({ rule, onPatch }: { rule: TitleRule; onPatch: RulePatchHandler }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t('app.titleRuleClosesAt')}</span>
            <input
                type="time"
                className="input input-sm w-full"
                aria-label={t('app.titleRuleClosesAt')}
                value={rule.closesAt ?? ''}
                onChange={(e) => onPatch({ closesAt: e.currentTarget.value })}
            />
        </div>
    );
}

export function RuleClassConditions({ rule, onPatch }: { rule: TitleRule; onPatch: RulePatchHandler }) {
    const { t } = useTranslation();
    return (
        <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
                <span className="text-sm">{t('app.titleRuleChallengeTag')}</span>
                <input
                    type="text"
                    className="input input-sm w-full"
                    placeholder={t('app.titleRuleChallengeTagPlaceholder')}
                    aria-label={t('app.titleRuleChallengeTag')}
                    value={rule.challengeTag ?? ''}
                    onChange={(e) => onPatch({ challengeTag: e.currentTarget.value })}
                />
            </div>
            <div className="flex flex-col gap-1">
                <span className="text-sm">{t('app.titleRuleType')}</span>
                <input
                    type="text"
                    list="gs-rule-types"
                    className="input input-sm w-full"
                    placeholder={t('app.titleRuleTypePlaceholder')}
                    aria-label={t('app.titleRuleType')}
                    value={rule.type ?? ''}
                    onChange={(e) => onPatch({ type: e.currentTarget.value })}
                />
            </div>
            <div className="flex flex-col gap-1">
                <span className="text-sm">{t('app.titleRulePics')}</span>
                <select
                    aria-label={t('app.titleRulePics')}
                    className="select select-sm w-full"
                    value={String(rule.pics ?? '')}
                    onChange={(event) => {
                        const next = event.currentTarget.value;
                        onPatch({ pics: next === '' ? '' : Number(next) });
                    }}
                >
                    <option value="">{t('app.titleRuleAnyPics')}</option>
                    {PICS_CHOICES.map((count) => (
                        <option key={count} value={count}>
                            {count}
                        </option>
                    ))}
                </select>
            </div>
            <RuleClosesAtField rule={rule} onPatch={onPatch} />
            <div className="grid grid-cols-2 gap-2">
                {RUNTIME_FIELDS.map((field) => (
                    <RuleNumberField key={field.settingKey} {...field} rule={rule} onPatch={onPatch} />
                ))}
            </div>
        </div>
    );
}
