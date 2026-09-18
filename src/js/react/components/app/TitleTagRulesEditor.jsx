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

/**
 * Editor for title-keyed challenge rules. GuruShots challenges rotate with a fresh
 * id each time, so id-keyed per-challenge overrides are lost on every rotation;
 * these rules match on the stable title, inherit an optional named profile,
 * and merge optional Must/Should Include tags at fill time.
 *
 * Beyond tags, a rule may override behaviour for its title INLINE — auto-join,
 * auto-fill, and the join window — without needing a named profile. Inline wins
 * over the profile, which wins over the global default. An omitted key means
 * "inherit"; the editor spells that as '' and the settings sanitizer drops it.
 *
 * Controlled: `value` is the rules array and `onChange(nextRules)` is called
 * with a new array on every edit. Each rule is
 * `{ title: string, profile?: string, mustIncludeTags: string[], shouldIncludeTags: string[],
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
                        <input
                            type="text"
                            className="input input-bordered input-sm flex-1"
                            placeholder={t('app.titleTagRuleTitlePlaceholder')}
                            aria-label={t('app.titleTagRuleTitle')}
                            value={rule.title ?? ''}
                            onChange={(e) => updateRule(index, { title: e.target.value })}
                        />
                        <button
                            className="btn btn-ghost btn-sm text-error"
                            title={t('app.removeTitleTagRule')}
                            aria-label={t('app.removeTitleTagRule')}
                            onClick={() => removeRule(index)}
                        >
                            ×
                        </button>
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
                        <label className="label py-1">
                            <span className="label-text text-sm">{t('app.mustIncludeTags')}</span>
                        </label>
                        <TagsField
                            settingKey="mustIncludeTags"
                            value={rule.mustIncludeTags}
                            onChange={(_key, tags) => updateRule(index, { mustIncludeTags: tags })}
                            placeholder={t('app.tagsPlaceholder')}
                        />
                    </div>

                    <div className="form-control">
                        <label className="label py-1">
                            <span className="label-text text-sm">{t('app.shouldIncludeTags')}</span>
                        </label>
                        <TagsField
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
