import { useTranslation } from '@/contexts/TranslationContext';
import { TagsField } from './SettingInput';

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
 * Controlled: `value` is the rules array and `onChange(nextRules)` is called
 * with a new array on every edit. Each rule is
 * `{ title: string, profile?: string, mustIncludeTags: string[], shouldIncludeTags: string[] }`.
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
