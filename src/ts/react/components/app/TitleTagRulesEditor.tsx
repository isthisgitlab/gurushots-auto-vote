import { useTranslation } from '@/contexts/TranslationContext';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { RuleProfileSelect, RuleScenarioSelect, RuleTagsField, TAG_FIELDS } from './RuleFields';
import { RuleTitleList } from './RuleTitleList';
import { RuleClassConditions } from './RuleConditions';
import { RuleBehaviour } from './RuleBehaviour';
import { hasRuleCondition, rulePatterns, sortRulesByDefaultOrder } from '../../../settings/challengeRules';

import type { LooseRecord, TitleRule } from '../../../types/settings';
import type { RulePatchHandler } from './RuleFields';

/**
 * Position badge plus the reorder / remove controls of one rule card.
 */
function RuleHeader({
    index,
    count,
    onMove,
    onRemove,
}: {
    index: number;
    count: number;
    onMove: (delta: number) => void;
    onRemove: () => void;
}) {
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
const isBroadSpendingRule = (rule: TitleRule): boolean =>
    rulePatterns(rule).length === 0 && hasRuleCondition(rule) && (rule.autoJoin === true || rule.autoFill === true);

/**
 * One rule: conditions, then the behaviour it applies to matching challenges.
 */
function RuleCard({
    index,
    count,
    rule,
    profiles,
    onPatch,
    onMove,
    onRemove,
}: {
    index: number;
    count: number;
    rule: TitleRule;
    profiles: Record<string, unknown>;
    onPatch: RulePatchHandler;
    onMove: (delta: number) => void;
    onRemove: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="rounded-box border border-base-300 p-3 space-y-3">
            <RuleHeader index={index} count={count} onMove={onMove} onRemove={onRemove} />
            <div className="flex items-center gap-2">
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
 * MATCHING: a rule matches on any mix of titles (any one is enough; each title's
 * mode is is-exactly, starts-with or contains), the
 * challenge's OWN tag (Exhibition, Comm, …, not a photo tag), its type, its
 * photo count and its runtime range in hours. Every filled condition must hold.
 *
 * ORDER: the list order is the precedence — for each setting the first matching
 * rule that sets it wins (see `ruleValuesFor` in settings/ruleResolution.ts). The user reorders
 * with the arrows or resets to the default order (settings/challengeRules.ts
 * `sortRulesByDefaultOrder`: title rules, then photos + runtime, photos,
 * runtime).
 *
 * BEHAVIOUR: a rule inherits an optional named profile, merges optional
 * Must/Should Include PHOTO tags at fill time, and may override auto-join,
 * auto-submit, the join timing, Submit Only Chosen Photos and the Chosen
 * Photos list INLINE. Inline wins over the profile. An omitted key means
 * "inherit"; the editor spells that as '' and the settings sanitizer drops it.
 * The chosen-photos list is the one array-valued inline key: '' inherits, an
 * explicit [] means "no chosen photos".
 *
 * Controlled: `value` is the rules array and `onChange(nextRules)` is called
 * with a new array on every edit. Each rule is
 * `{ title: string, titles?: string[], match?: 'exact'|'starts'|'contains', challengeTag?: string,
 *    type?: string, pics?: number, minHours?: number, maxHours?: number,
 *    profile?: string, mustIncludeTags: string[], shouldIncludeTags: string[],
 *    autoJoin?: boolean, autoFill?: boolean, autoJoinWithinHoursOfEnd?: number,
 *    autoJoinAfterPercentElapsed?: number, chosenPhotos?: string[],
 *    chosenPhotosOnly?: boolean }`.
 * `types` feeds the challenge-type suggestions; the field stays free text.
 */
export function TitleTagRulesEditor({
    value,
    onChange,
    profiles = {},
    types = [],
}: {
    value: TitleRule[] | null | undefined;
    onChange: (rules: TitleRule[]) => void;
    profiles?: Record<string, unknown>;
    types?: string[];
}) {
    const { t } = useTranslation();
    const rules = Array.isArray(value) ? value : [];

    const updateRule = (index: number, patch: LooseRecord) => {
        onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    };

    const moveRule = (index: number, delta: number) => {
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
