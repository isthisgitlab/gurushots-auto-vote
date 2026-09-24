import { useTranslation } from '@/contexts/TranslationContext';
import { TagsField } from './SettingInput';
import { hasRuleCondition, rulePatterns, sortRulesByDefaultOrder } from '../../../settings/challengeRules';

// Tri-state boolean override. '' = inherit (the key is omitted from the saved
// rule entirely, so the rule never freezes today's default into storage);
// 'on'/'off' are explicit. Kept as strings because a <select> value is a string
// and `false` would otherwise round-trip through '' and read as "inherit".
const TRISTATE = { true: 'on', false: 'off' };

const triValue = (value) => (value === true || value === false ? TRISTATE[value] : '');

const triPatch = (key, raw) => ({ [key]: raw === 'on' ? true : raw === 'off' ? false : '' });

/**
 * Photo counts a rule may be keyed on. GuruShots challenges carry at most four
 * submissions, and the settings sanitizer bounds the stored value independently
 * — this list only decides what the dropdown offers.
 */
const PICS_CHOICES = [1, 2, 3, 4];

// Mirrors MAX_RULE_RUNTIME_HOURS in settings/challengeRules.js; the sanitizer is
// the real gate.
const MAX_RUNTIME_HOURS = 2000;

function renderTristate(index, rule, key, labelKey, updateRule, t) {
    return (
        <div className="form-control gap-1">
            <span className="label-text text-sm">{t(labelKey)}</span>
            <select
                aria-label={t(labelKey)}
                className="select select-bordered select-sm w-full"
                value={triValue(rule[key])}
                onChange={(event) => updateRule(index, triPatch(key, event.target.value))}
            >
                <option value="">{t('app.titleRuleInherit')}</option>
                <option value="on">{t('app.titleRuleOn')}</option>
                <option value="off">{t('app.titleRuleOff')}</option>
            </select>
        </div>
    );
}

/**
 * A number field that distinguishes "empty" from an explicit 0.
 *
 * An empty field is saved as '' — for a behaviour override that means inherit,
 * for a runtime condition "any length" — and the settings sanitizer drops it.
 * 0 is the explicit "off" value for an override, so this cannot just coerce
 * with Number().
 */
function renderNumberField({ index, rule, settingKey, labelKey, unitKey, placeholderKey, min, max, updateRule, t }) {
    const raw = rule[settingKey];
    return (
        <div className="form-control gap-1">
            <span className="label-text text-sm">{t(labelKey)}</span>
            {/* A div, not a <label>: the input carries its own aria-label, and a
                wrapping label without a matching id trips jsx-a11y/label-has-for. */}
            <div className="input input-bordered input-sm flex items-center gap-2">
                <input
                    type="number"
                    min={min}
                    max={max}
                    step="1"
                    className="grow"
                    aria-label={t(labelKey)}
                    placeholder={t(placeholderKey)}
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

function renderTitleProfileSelect(index, rule, profiles, updateRule, t) {
    const names = Object.keys(profiles).sort();
    return (
        <div className="form-control gap-1">
            <span className="label-text text-sm">{t('app.titleRuleProfile')}</span>
            <select
                aria-label={t('app.titleRuleProfile')}
                className="select select-bordered select-sm w-full"
                value={rule.profile ?? ''}
                onChange={(event) => updateRule(index, { profile: event.target.value })}
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

// Mirrors MAX_TITLES_PER_RULE in settings.js; the sanitizer is the real gate.
const MAX_TITLES_PER_RULE = 50;

// The editable title list of a rule. Stored rules carry `titles` only when they
// list more than one (with `title` mirroring the first). Always at least one row
// so a fresh rule shows an input.
const ruleTitleRows = (rule) => {
    if (Array.isArray(rule.titles) && rule.titles.length > 0) return rule.titles;
    return [rule.title ?? ''];
};

// Patch for a new title list. `title` follows the first row so the saved shape
// stays readable by single-title code; the sanitizer drops empty rows.
const titlesPatch = (titles) => ({ titles, title: titles[0] ?? '' });

function renderTitleList(index, rule, updateRule, t) {
    const titles = ruleTitleRows(rule);
    const setTitles = (next) => updateRule(index, titlesPatch(next));
    return (
        <div className="space-y-2">
            {titles.map((title, titleIndex) => (
                // Index key: rows are only appended or removed, and the input is controlled.
                <div key={titleIndex} className="flex items-center gap-2">
                    <input
                        type="text"
                        className="input input-bordered input-sm flex-1"
                        placeholder={t('app.titleTagRuleTitlePlaceholder')}
                        aria-label={`${t('app.titleTagRuleTitle')} ${titleIndex + 1}`}
                        value={title}
                        onChange={(e) => setTitles(titles.map((v, i) => (i === titleIndex ? e.target.value : v)))}
                    />
                    {titles.length > 1 && (
                        <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            title={t('app.removeTitleRuleTitle')}
                            aria-label={`${t('app.removeTitleRuleTitle')} ${titleIndex + 1}`}
                            onClick={() => setTitles(titles.filter((_, i) => i !== titleIndex))}
                        >
                            ×
                        </button>
                    )}
                </div>
            ))}
            <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={titles.length >= MAX_TITLES_PER_RULE}
                onClick={() => setTitles([...titles, ''])}
            >
                + {t('app.addTitleRuleTitle')}
            </button>
        </div>
    );
}

function renderClassConditions(index, rule, updateRule, t) {
    return (
        <div className="grid gap-2 sm:grid-cols-2">
            <div className="form-control gap-1">
                <span className="label-text text-sm">{t('app.titleRuleChallengeTag')}</span>
                <input
                    type="text"
                    className="input input-bordered input-sm w-full"
                    placeholder={t('app.titleRuleChallengeTagPlaceholder')}
                    aria-label={t('app.titleRuleChallengeTag')}
                    value={rule.challengeTag ?? ''}
                    onChange={(e) => updateRule(index, { challengeTag: e.target.value })}
                />
            </div>
            <div className="form-control gap-1">
                <span className="label-text text-sm">{t('app.titleRuleType')}</span>
                <input
                    type="text"
                    list="gs-rule-types"
                    className="input input-bordered input-sm w-full"
                    placeholder={t('app.titleRuleTypePlaceholder')}
                    aria-label={t('app.titleRuleType')}
                    value={rule.type ?? ''}
                    onChange={(e) => updateRule(index, { type: e.target.value })}
                />
            </div>
            <div className="form-control gap-1">
                <span className="label-text text-sm">{t('app.titleRulePics')}</span>
                <select
                    aria-label={t('app.titleRulePics')}
                    className="select select-bordered select-sm w-full"
                    value={String(rule.pics ?? '')}
                    onChange={(event) => {
                        const next = event.target.value;
                        updateRule(index, { pics: next === '' ? '' : Number(next) });
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
            <div className="grid grid-cols-2 gap-2">
                {renderNumberField({
                    index,
                    rule,
                    settingKey: 'minHours',
                    labelKey: 'app.titleRuleMinHours',
                    unitKey: 'app.unitHours',
                    placeholderKey: 'app.titleRuleAnyLength',
                    min: 1,
                    max: MAX_RUNTIME_HOURS,
                    updateRule,
                    t,
                })}
                {renderNumberField({
                    index,
                    rule,
                    settingKey: 'maxHours',
                    labelKey: 'app.titleRuleMaxHours',
                    unitKey: 'app.unitHours',
                    placeholderKey: 'app.titleRuleAnyLength',
                    min: 1,
                    max: MAX_RUNTIME_HOURS,
                    updateRule,
                    t,
                })}
            </div>
        </div>
    );
}

function renderBehaviour(index, rule, updateRule, t) {
    return (
        <div className="space-y-2">
            <span className="label-text text-sm font-medium">{t('app.titleRuleOverridesLabel')}</span>
            <div className="grid gap-2 sm:grid-cols-2">
                {renderTristate(index, rule, 'autoJoin', 'app.titleRuleAutoJoin', updateRule, t)}
                {renderTristate(index, rule, 'autoFill', 'app.titleRuleAutoFill', updateRule, t)}
                {renderNumberField({
                    index,
                    rule,
                    settingKey: 'autoJoinAfterPercentElapsed',
                    labelKey: 'app.titleRulePercentElapsed',
                    unitKey: 'app.unitPercent',
                    placeholderKey: 'app.titleRuleJoinWindowPlaceholder',
                    min: 0,
                    max: 99,
                    updateRule,
                    t,
                })}
                {renderNumberField({
                    index,
                    rule,
                    settingKey: 'autoJoinWithinHoursOfEnd',
                    labelKey: 'app.titleRuleJoinWindow',
                    unitKey: 'app.unitHours',
                    placeholderKey: 'app.titleRuleJoinWindowPlaceholder',
                    min: 0,
                    max: 720,
                    updateRule,
                    t,
                })}
            </div>
        </div>
    );
}

// A rule with conditions but no title reaches a whole class of challenges, so
// switching joining or auto-submit ON there spends coins / photos broadly.
const isBroadSpendingRule = (rule) =>
    rulePatterns(rule).length === 0 && hasRuleCondition(rule) && (rule.autoJoin === true || rule.autoFill === true);

/**
 * Editor for challenge rules. GuruShots challenges rotate with a fresh id each
 * time, so id-keyed per-challenge overrides are lost on every rotation; these
 * rules match on what survives a rotation instead.
 *
 * MATCHING: a rule matches on any mix of titles (any one is enough; one `match`
 * mode — is-exactly, starts-with or contains — applies to all of them), the
 * challenge's OWN tag (Exhibition, Comm, …, not a photo tag), its type, its
 * photo count and its runtime range in hours. Every filled condition must hold.
 *
 * ORDER: the list order is the precedence — for each setting the first matching
 * rule that sets it wins (see settings.js `_ruleValuesFor`). The user reorders
 * with the arrows or resets to the default order (settings/challengeRules.js
 * `sortRulesByDefaultOrder`: title rules, then photos + runtime, photos,
 * runtime).
 *
 * BEHAVIOUR: a rule inherits an optional named profile, merges optional
 * Must/Should Include PHOTO tags at fill time, and may override auto-join,
 * auto-submit and the join timing INLINE. Inline wins over the profile. An
 * omitted key means "inherit"; the editor spells that as '' and the settings
 * sanitizer drops it.
 *
 * Controlled: `value` is the rules array and `onChange(nextRules)` is called
 * with a new array on every edit. Each rule is
 * `{ title: string, titles?: string[], match?: 'exact'|'starts'|'contains', challengeTag?: string,
 *    type?: string, pics?: number, minHours?: number, maxHours?: number,
 *    profile?: string, mustIncludeTags: string[], shouldIncludeTags: string[],
 *    autoJoin?: boolean, autoFill?: boolean, autoJoinWithinHoursOfEnd?: number,
 *    autoJoinAfterPercentElapsed?: number }`.
 * `types` feeds the challenge-type suggestions; the field stays free text.
 */
export function TitleTagRulesEditor({ value, onChange, profiles = {}, types = [] }) {
    const { t } = useTranslation();
    const rules = Array.isArray(value) ? value : [];

    const updateRule = (index, patch) => {
        onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    };

    const removeRule = (index) => {
        onChange(rules.filter((_, i) => i !== index));
    };

    const moveRule = (index, delta) => {
        const next = [...rules];
        [next[index], next[index + delta]] = [next[index + delta], next[index]];
        onChange(next);
    };

    const addRule = () => {
        onChange([...rules, { title: '', profile: '', mustIncludeTags: [], shouldIncludeTags: [] }]);
    };

    return (
        <div className="space-y-3">
            {rules.length === 0 && <p className="text-sm text-base-content/60">{t('app.noTitleTagRules')}</p>}

            {rules.length > 1 && (
                <div className="flex items-center gap-2">
                    <p className="label-text-alt text-xs opacity-60 flex-1">{t('app.titleRuleOrderHint')}</p>
                    <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => onChange(sortRulesByDefaultOrder(rules))}
                    >
                        {t('app.titleRuleSortDefault')}
                    </button>
                </div>
            )}

            {rules.map((rule, index) => (
                // Index key: controlled inputs and TagsField's prop-fingerprint
                // re-sync keep values aligned with the row when rows move.
                <div key={index} className="rounded-box border border-base-300 p-3 space-y-3">
                    <div className="flex items-center gap-2">
                        <span className="badge badge-ghost badge-sm">{index + 1}</span>
                        <span className="label-text text-sm font-medium flex-1">
                            {t('app.titleRuleConditionsLabel')}
                        </span>
                        <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            title={t('app.titleRuleMoveUp')}
                            aria-label={`${t('app.titleRuleMoveUp')} ${index + 1}`}
                            disabled={index === 0}
                            onClick={() => moveRule(index, -1)}
                        >
                            ↑
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            title={t('app.titleRuleMoveDown')}
                            aria-label={`${t('app.titleRuleMoveDown')} ${index + 1}`}
                            disabled={index === rules.length - 1}
                            onClick={() => moveRule(index, 1)}
                        >
                            ↓
                        </button>
                        <button
                            className="btn btn-ghost btn-sm text-error"
                            title={t('app.removeTitleTagRule')}
                            aria-label={t('app.removeTitleTagRule')}
                            onClick={() => removeRule(index)}
                        >
                            ×
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <select
                            aria-label={t('app.titleRuleMatch')}
                            className="select select-bordered select-sm w-32"
                            value={rule.match ?? 'exact'}
                            onChange={(e) => updateRule(index, { match: e.target.value })}
                        >
                            <option value="exact">{t('app.titleRuleMatchExact')}</option>
                            <option value="starts">{t('app.titleRuleMatchStarts')}</option>
                            <option value="contains">{t('app.titleRuleMatchContains')}</option>
                        </select>
                        <span className="label-text text-sm flex-1">{t('app.titleRuleTitlesLabel')}</span>
                    </div>
                    {renderTitleList(index, rule, updateRule, t)}
                    {renderClassConditions(index, rule, updateRule, t)}
                    <p className="label-text-alt text-xs opacity-60">{t('app.titleRuleConditionsHint')}</p>
                    {renderTitleProfileSelect(index, rule, profiles, updateRule, t)}
                    {renderBehaviour(index, rule, updateRule, t)}
                    {isBroadSpendingRule(rule) && (
                        <div role="alert" className="alert alert-warning py-2 text-sm">
                            <span>{t('app.titleRuleBroadWarning')}</span>
                        </div>
                    )}
                    <div className="form-control">
                        <label className="label py-1" htmlFor={`title-rule-${index}-mustIncludeTags`}>
                            <span className="label-text text-sm">{t('app.mustIncludeTags')}</span>
                        </label>
                        <TagsField
                            id={`title-rule-${index}-mustIncludeTags`}
                            settingKey="mustIncludeTags"
                            value={rule.mustIncludeTags}
                            onChange={(_key, tags) => updateRule(index, { mustIncludeTags: tags })}
                            placeholder={t('app.tagsPlaceholder')}
                        />
                    </div>

                    <div className="form-control">
                        <label className="label py-1" htmlFor={`title-rule-${index}-shouldIncludeTags`}>
                            <span className="label-text text-sm">{t('app.shouldIncludeTags')}</span>
                        </label>
                        <TagsField
                            id={`title-rule-${index}-shouldIncludeTags`}
                            settingKey="shouldIncludeTags"
                            value={rule.shouldIncludeTags}
                            onChange={(_key, tags) => updateRule(index, { shouldIncludeTags: tags })}
                            placeholder={t('app.tagsPlaceholder')}
                        />
                    </div>
                </div>
            ))}

            {/* Suggestions only — the type field stays free text so a type this
                build has never seen can still be entered. */}
            <datalist id="gs-rule-types">
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
                {t('app.addTitleTagRule')}
            </button>
        </div>
    );
}
