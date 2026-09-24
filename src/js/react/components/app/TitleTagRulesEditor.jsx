import { useTranslation } from '@/contexts/TranslationContext';
import { TagsField } from './SettingInput';

// Tri-state boolean override. '' = inherit (the key is omitted from the saved
// rule entirely, so the rule never freezes today's default into storage);
// 'on'/'off' are explicit. Kept as strings because a <select> value is a string
// and `false` would otherwise round-trip through '' and read as "inherit".
const TRISTATE = { true: 'on', false: 'off' };

const triValue = (value) => (value === true || value === false ? TRISTATE[value] : '');

const triPatch = (key, raw) => ({ [key]: raw === 'on' ? true : raw === 'off' ? false : '' });

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

function renderJoinWindow(index, rule, updateRule, t) {
    const raw = rule.autoJoinWithinHoursOfEnd;
    return (
        <div className="form-control gap-1">
            <span className="label-text text-sm">{t('app.titleRuleJoinWindow')}</span>
            {/* A div, not a <label>: the input carries its own aria-label, and a
                wrapping label without a matching id trips jsx-a11y/label-has-for. */}
            <div className="input input-bordered input-sm flex items-center gap-2">
                <input
                    type="number"
                    min="0"
                    step="1"
                    className="grow"
                    aria-label={t('app.titleRuleJoinWindow')}
                    placeholder={t('app.titleRuleJoinWindowPlaceholder')}
                    value={raw === null || raw === undefined ? '' : raw}
                    // An empty field means "inherit", not 0 — 0 is the explicit
                    // "join on sight" value, so the two must stay distinct.
                    onChange={(event) => {
                        const next = event.target.value;
                        updateRule(index, {
                            autoJoinWithinHoursOfEnd: next === '' ? '' : Number(next),
                        });
                    }}
                />
                <span className="text-xs opacity-60">{t('app.unitHours')}</span>
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
// list more than one (with `title` mirroring the first); an older rule has just
// `title`. Always at least one row so a fresh rule shows an input.
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

/**
 * Editor for challenge rules. GuruShots challenges rotate with a fresh id each
 * time, so id-keyed per-challenge overrides are lost on every rotation; these
 * rules match on what survives a rotation instead.
 *
 * MATCHING: a rule matches on one or more titles (any one is enough; one
 * `match` mode applies to all of them — is-exactly, which
 * is the default, starts-with, or contains) and/or on a `challengeTag` — the
 * challenge's OWN classifier from the API (Exhibition, Comm, Turbo, …), not a
 * photo tag. Both present means both must hold. When several rules match one
 * challenge the most specific wins (see settings.js `_findRuleIn`).
 *
 * BEHAVIOUR: a rule inherits an optional named profile, merges optional
 * Must/Should Include PHOTO tags at fill time, and may override auto-join,
 * auto-fill and the join window INLINE. Inline wins over the profile, which
 * wins over the global default. An omitted key means "inherit"; the editor
 * spells that as '' and the settings sanitizer drops it.
 *
 * Controlled: `value` is the rules array and `onChange(nextRules)` is called
 * with a new array on every edit. Each rule is
 * `{ title: string, titles?: string[], match?: 'exact'|'starts'|'contains', challengeTag?: string,
 *    profile?: string, mustIncludeTags: string[], shouldIncludeTags: string[],
 *    autoJoin?: boolean, autoFill?: boolean, autoJoinWithinHoursOfEnd?: number }`.
 */
export function TitleTagRulesEditor({ value, onChange, profiles = {} }) {
    const { t } = useTranslation();
    const rules = Array.isArray(value) ? value : [];

    const updateRule = (index, patch) => {
        onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    };

    const removeRule = (index) => {
        onChange(rules.filter((_, i) => i !== index));
    };

    const addRule = () => {
        onChange([...rules, { title: '', profile: '', mustIncludeTags: [], shouldIncludeTags: [] }]);
    };

    return (
        <div className="space-y-3">
            {rules.length === 0 && <p className="text-sm text-base-content/60">{t('app.noTitleTagRules')}</p>}

            {rules.map((rule, index) => (
                // Index key: rows are only added at the end or removed; controlled
                // inputs and TagsField's prop-fingerprint re-sync keep values correct.
                <div key={index} className="rounded-box border border-base-300 p-3 space-y-3">
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
                        <button
                            className="btn btn-ghost btn-sm text-error"
                            title={t('app.removeTitleTagRule')}
                            aria-label={t('app.removeTitleTagRule')}
                            onClick={() => removeRule(index)}
                        >
                            ×
                        </button>
                    </div>
                    {renderTitleList(index, rule, updateRule, t)}
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
                        <span className="label-text-alt text-xs opacity-60">{t('app.titleRuleChallengeTagHint')}</span>
                    </div>
                    {renderTitleProfileSelect(index, rule, profiles, updateRule, t)}
                    <div className="space-y-2">
                        <span className="label-text text-sm font-medium">{t('app.titleRuleOverridesLabel')}</span>
                        <div className="grid gap-2 sm:grid-cols-3">
                            {renderTristate(index, rule, 'autoJoin', 'app.titleRuleAutoJoin', updateRule, t)}
                            {renderTristate(index, rule, 'autoFill', 'app.titleRuleAutoFill', updateRule, t)}
                            {renderJoinWindow(index, rule, updateRule, t)}
                        </div>
                    </div>
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

            <button className="btn btn-sm btn-outline" onClick={addRule}>
                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                {t('app.addTitleTagRule')}
            </button>
        </div>
    );
}
