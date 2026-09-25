import { useTranslation } from '@/contexts/TranslationContext';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { TagsField } from './SettingInput';
import { useScenarios } from '@/api/useScenarios';
import { interp } from '@/utils/interp';
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

function TristateSelect({ rule, settingKey, labelKey, onPatch }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t(labelKey)}</span>
            <select
                aria-label={t(labelKey)}
                className="select select-sm w-full"
                value={triValue(rule[settingKey])}
                onChange={(event) => onPatch(triPatch(settingKey, event.target.value))}
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
function RuleNumberField({ rule, settingKey, labelKey, unitKey, placeholderKey, min, max, onPatch }) {
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
                    value={raw === null || raw === undefined ? '' : raw}
                    onChange={(event) => {
                        const next = event.target.value;
                        onPatch({ [settingKey]: next === '' ? '' : Number(next) });
                    }}
                />
                <span className="text-xs opacity-60">{t(unitKey)}</span>
            </div>
        </div>
    );
}

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

// Inline behaviour overrides: inherit when blank.
const TRISTATE_OVERRIDES = [
    { settingKey: 'autoJoin', labelKey: 'app.titleRuleAutoJoin' },
    { settingKey: 'autoFill', labelKey: 'app.titleRuleAutoFill' },
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

// Must/Should Include PHOTO tags merged in at fill time.
const TAG_FIELDS = [
    { settingKey: 'mustIncludeTags', labelKey: 'app.mustIncludeTags' },
    { settingKey: 'shouldIncludeTags', labelKey: 'app.shouldIncludeTags' },
];

function RuleProfileSelect({ rule, profiles, onPatch }) {
    const { t } = useTranslation();
    const names = Object.keys(profiles).sort();
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t('app.titleRuleProfile')}</span>
            <select
                aria-label={t('app.titleRuleProfile')}
                className="select select-sm w-full"
                value={rule.profile ?? ''}
                onChange={(event) => onPatch({ profile: event.target.value })}
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
function RuleScenarioSelect({ rule, onPatch }) {
    const { t } = useTranslation();
    const { scenarios } = useScenarios();
    const names = Object.keys(scenarios);
    const current = rule.scenario ?? '';
    return (
        <div className="flex flex-col gap-1">
            <span className="text-sm">{t('app.scenario')}</span>
            <select
                aria-label={t('app.scenario')}
                className="select select-sm w-full"
                value={current}
                onChange={(event) => onPatch({ scenario: event.target.value })}
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

// Mirrors MAX_TITLES_PER_RULE in settings/titleRuleSanitize.js; the sanitizer is the real gate.
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

function RuleTitleList({ rule, onPatch }) {
    const { t } = useTranslation();
    const titles = ruleTitleRows(rule);
    const setTitles = (next) => onPatch(titlesPatch(next));
    return (
        <div className="space-y-2">
            {titles.map((title, titleIndex) => (
                // Index key: rows are only appended or removed, and the input is controlled.
                <div key={titleIndex} className="flex items-center gap-2">
                    <input
                        type="text"
                        className="input input-sm flex-1"
                        placeholder={t('app.titleTagRuleTitlePlaceholder')}
                        aria-label={`${t('app.titleTagRuleTitle')} ${titleIndex + 1}`}
                        value={title}
                        onChange={(e) => setTitles(titles.map((v, i) => (i === titleIndex ? e.target.value : v)))}
                    />
                    {titles.length > 1 && (
                        <button
                            type="button"
                            className="btn btn-outline btn-sm"
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
                className="btn btn-outline btn-sm"
                disabled={titles.length >= MAX_TITLES_PER_RULE}
                onClick={() => setTitles([...titles, ''])}
            >
                + {t('app.addTitleRuleTitle')}
            </button>
        </div>
    );
}

function RuleClassConditions({ rule, onPatch }) {
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
                    onChange={(e) => onPatch({ challengeTag: e.target.value })}
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
                    onChange={(e) => onPatch({ type: e.target.value })}
                />
            </div>
            <div className="flex flex-col gap-1">
                <span className="text-sm">{t('app.titleRulePics')}</span>
                <select
                    aria-label={t('app.titleRulePics')}
                    className="select select-sm w-full"
                    value={String(rule.pics ?? '')}
                    onChange={(event) => {
                        const next = event.target.value;
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
            <div className="grid grid-cols-2 gap-2">
                {RUNTIME_FIELDS.map((field) => (
                    <RuleNumberField key={field.settingKey} {...field} rule={rule} onPatch={onPatch} />
                ))}
            </div>
        </div>
    );
}

function RuleBehaviour({ rule, onPatch }) {
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
        </div>
    );
}

function RuleTagsField({ index, rule, settingKey, labelKey, onPatch }) {
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

/** Position badge plus the reorder / remove controls of one rule card. */
function RuleHeader({ index, count, onMove, onRemove }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2">
            <span className="badge badge-ghost badge-sm">{index + 1}</span>
            <span className="text-sm font-medium flex-1">{t('app.titleRuleConditionsLabel')}</span>
            <button
                type="button"
                className="btn btn-outline btn-sm"
                title={t('app.titleRuleMoveUp')}
                aria-label={`${t('app.titleRuleMoveUp')} ${index + 1}`}
                disabled={index === 0}
                onClick={() => onMove(-1)}
            >
                ↑
            </button>
            <button
                type="button"
                className="btn btn-outline btn-sm"
                title={t('app.titleRuleMoveDown')}
                aria-label={`${t('app.titleRuleMoveDown')} ${index + 1}`}
                disabled={index === count - 1}
                onClick={() => onMove(1)}
            >
                ↓
            </button>
            <button
                className="btn btn-outline btn-error btn-sm"
                title={t('app.removeTitleTagRule')}
                aria-label={t('app.removeTitleTagRule')}
                onClick={onRemove}
            >
                ×
            </button>
        </div>
    );
}

// A rule with conditions but no title reaches a whole class of challenges, so
// switching joining or auto-submit ON there spends coins / photos broadly.
const isBroadSpendingRule = (rule) =>
    rulePatterns(rule).length === 0 && hasRuleCondition(rule) && (rule.autoJoin === true || rule.autoFill === true);

/** One rule: conditions, then the behaviour it applies to matching challenges. */
function RuleCard({ index, count, rule, profiles, onPatch, onMove, onRemove }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-box border border-base-300 p-3 space-y-3">
            <RuleHeader index={index} count={count} onMove={onMove} onRemove={onRemove} />
            <div className="flex items-center gap-2">
                <select
                    aria-label={t('app.titleRuleMatch')}
                    className="select select-sm w-32"
                    value={rule.match ?? 'exact'}
                    onChange={(e) => onPatch({ match: e.target.value })}
                >
                    <option value="exact">{t('app.titleRuleMatchExact')}</option>
                    <option value="starts">{t('app.titleRuleMatchStarts')}</option>
                    <option value="contains">{t('app.titleRuleMatchContains')}</option>
                </select>
                <span className="text-sm flex-1">{t('app.titleRuleTitlesLabel')}</span>
            </div>
            <RuleTitleList rule={rule} onPatch={onPatch} />
            <RuleClassConditions rule={rule} onPatch={onPatch} />
            <p className="text-xs opacity-60">{t('app.titleRuleConditionsHint')}</p>
            <RuleProfileSelect rule={rule} profiles={profiles} onPatch={onPatch} />
            <RuleScenarioSelect rule={rule} onPatch={onPatch} />
            <RuleBehaviour rule={rule} onPatch={onPatch} />
            {isBroadSpendingRule(rule) && (
                <div role="alert" className="alert alert-warning py-2 text-sm">
                    <span>{t('app.titleRuleBroadWarning')}</span>
                </div>
            )}
            {TAG_FIELDS.map((field) => (
                <RuleTagsField key={field.settingKey} {...field} index={index} rule={rule} onPatch={onPatch} />
            ))}
        </div>
    );
}

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
 * rule that sets it wins (see `ruleValuesFor` in settings/ruleResolution.js). The user reorders
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
                    <p className="text-xs opacity-60 flex-1">{t('app.titleRuleOrderHint')}</p>
                    <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => onChange(sortRulesByDefaultOrder(rules))}
                    >
                        {t('app.titleRuleSortDefault')}
                    </button>
                </div>
            )}

            {rules.map((rule, index) => (
                // Index key: controlled inputs and TagsField's prop-fingerprint
                // re-sync keep values aligned with the row when rows move.
                <RuleCard
                    key={index}
                    index={index}
                    count={rules.length}
                    rule={rule}
                    profiles={profiles}
                    onPatch={(patch) => updateRule(index, patch)}
                    onMove={(delta) => moveRule(index, delta)}
                    onRemove={() => onChange(rules.filter((_, i) => i !== index))}
                />
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
                <StrokeIcon d={ICON_PATHS.plus} className="w-4 h-4 mr-1" />
                {t('app.addTitleTagRule')}
            </button>
        </div>
    );
}
