import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Photo counts a rule may be keyed on. GuruShots challenges carry at most four
 * submissions, and the settings sanitizer bounds the stored value independently
 * — this list only decides what the dropdown offers.
 */
const PICS_CHOICES = [1, 2, 3, 4];

/**
 * A number override that distinguishes "inherit" from an explicit 0.
 *
 * An empty field means inherit (the key is dropped from the saved rule, so a
 * rule never freezes today's default into storage); 0 is the explicit "off"
 * value. Keeping the two distinct is why this cannot just coerce with Number().
 */
function renderNumberOverride({ index, rule, settingKey, labelKey, unitKey, max, updateRule, t }) {
    const raw = rule[settingKey];
    return (
        <div className="form-control gap-1">
            <span className="label-text text-sm">{t(labelKey)}</span>
            {/* A div, not a <label>: the input carries its own aria-label, and a
                wrapping label without a matching id trips jsx-a11y/label-has-for. */}
            <div className="input input-bordered input-sm flex items-center gap-2">
                <input
                    type="number"
                    min="0"
                    max={max}
                    step="1"
                    className="grow"
                    aria-label={t(labelKey)}
                    placeholder={t('app.categoryRuleInheritPlaceholder')}
                    value={raw === null || raw === undefined ? '' : raw}
                    onChange={(event) => {
                        const next = event.target.value;
                        updateRule(index, { [settingKey]: next === '' ? '' : Number(next) });
                    }}
                />
                <span className="text-xs opacity-60">{t(unitKey)}</span>
            </div>
        </div>
    );
}

/**
 * Editor for category-keyed join-timing rules.
 *
 * WHY: entry timing really tracks how LONG a challenge runs, and the payload's
 * `type` / `max_photo_submits` are the usable proxies for that — 4-photo
 * defaults run 24h, 2-photo ones 48h, 3-photo ones 72h, while a 4-photo
 * exhibition runs weeks. A title rule cannot express "every exhibition"; this
 * can.
 *
 * BEHAVIOUR: a rule matches on challenge type, on photo count, or on both (both
 * conditions must hold, and a rule naming both beats one naming either alone).
 * It may override the join window in hours or as a percentage of the
 * challenge's own length; the percentage wins when both are set. An omitted
 * value means "inherit", which the editor spells as '' and the settings
 * sanitizer drops. These rules sit BELOW title rules and ABOVE the global
 * defaults.
 *
 * Controlled: `value` is the rules array and `onChange(nextRules)` is called
 * with a new array on every edit. Each rule is
 * `{ type?: string, pics?: number, autoJoinWithinHoursOfEnd?: number,
 *    autoJoinAfterPercentElapsed?: number }`.
 */
export function CategoryRulesEditor({ value, onChange, types = [] }) {
    const { t } = useTranslation();
    const rules = Array.isArray(value) ? value : [];

    const updateRule = (index, patch) => {
        onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    };

    const removeRule = (index) => {
        onChange(rules.filter((_, i) => i !== index));
    };

    const addRule = () => {
        onChange([...rules, { type: '', pics: '' }]);
    };

    return (
        <div className="space-y-3">
            {rules.length === 0 && <p className="text-sm text-base-content/60">{t('app.noCategoryRules')}</p>}

            {rules.map((rule, index) => (
                // Index key: rows are only added at the end or removed, and every
                // input below is controlled, so values stay aligned with the row.
                <div key={index} className="rounded-box border border-base-300 p-3 space-y-3">
                    <div className="flex items-end gap-2">
                        <div className="form-control gap-1 flex-1">
                            <span className="label-text text-sm">{t('app.categoryRuleType')}</span>
                            <input
                                type="text"
                                list="gs-category-rule-types"
                                className="input input-bordered input-sm w-full"
                                placeholder={t('app.categoryRuleTypePlaceholder')}
                                aria-label={t('app.categoryRuleType')}
                                value={rule.type ?? ''}
                                onChange={(event) => updateRule(index, { type: event.target.value })}
                            />
                        </div>
                        <div className="form-control gap-1 w-32">
                            <span className="label-text text-sm">{t('app.categoryRulePics')}</span>
                            <select
                                aria-label={t('app.categoryRulePics')}
                                className="select select-bordered select-sm w-full"
                                value={rule.pics ?? ''}
                                onChange={(event) => {
                                    const next = event.target.value;
                                    updateRule(index, { pics: next === '' ? '' : Number(next) });
                                }}
                            >
                                <option value="">{t('app.categoryRuleAnyPics')}</option>
                                {PICS_CHOICES.map((count) => (
                                    <option key={count} value={count}>
                                        {count}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button
                            className="btn btn-ghost btn-sm text-error"
                            title={t('app.removeCategoryRule')}
                            aria-label={t('app.removeCategoryRule')}
                            onClick={() => removeRule(index)}
                        >
                            ×
                        </button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {renderNumberOverride({
                            index,
                            rule,
                            settingKey: 'autoJoinAfterPercentElapsed',
                            labelKey: 'app.categoryRulePercentElapsed',
                            unitKey: 'app.unitPercent',
                            max: 99,
                            updateRule,
                            t,
                        })}
                        {renderNumberOverride({
                            index,
                            rule,
                            settingKey: 'autoJoinWithinHoursOfEnd',
                            labelKey: 'app.categoryRuleJoinWindow',
                            unitKey: 'app.unitHours',
                            max: 720,
                            updateRule,
                            t,
                        })}
                    </div>
                    <p className="label-text-alt text-xs opacity-60">{t('app.categoryRuleHint')}</p>
                </div>
            ))}

            {/* Suggestions only — the field stays free text so a type this build
                has never seen can still be entered. */}
            <datalist id="gs-category-rule-types">
                {types.map((type) => (
                    // The text child is the suggestion's visible label; an empty
                    // <option> renders fine but reads as an unlabelled control.
                    <option key={type} value={type}>
                        {type}
                    </option>
                ))}
            </datalist>

            <button className="btn btn-sm btn-outline" onClick={addRule}>
                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                {t('app.addCategoryRule')}
            </button>
        </div>
    );
}
