import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { RuleProfileSelect, RuleScenarioSelect, RuleTagsField, TAG_FIELDS } from './RuleFields';
import { RuleTitleList } from './RuleTitleList';
import { RuleClassConditions } from './RuleConditions';
import { RuleBehaviour } from './RuleBehaviour';
import {
    MAX_TITLE_LENGTH,
    hasRuleCondition,
    ruleDisplayName,
    rulePatterns,
    sortRulesByDefaultOrder,
} from '../../../core/settings/challengeRules';
import { ruleHasBehaviour } from '../../../core/settings/ruleBehaviour';
import { CONFIRM_TIMEOUT_MS } from '@/utils/profileName';

import type { LooseRecord, TitleRule } from '../../../core/types/settings';

// Dropdown / form labels read better without whatever whitespace a pasted name
// carries (newlines would survive inside an <option>'s text).
const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

// A rule with conditions but no title reaches a whole class of challenges, so
// switching joining or auto-submit ON there spends coins / photos broadly.
const isBroadSpendingRule = (rule: TitleRule): boolean =>
    rulePatterns(rule).length === 0 && hasRuleCondition(rule) && (rule.autoJoin === true || rule.autoSubmit === true);

/**
 * Editor for challenge rules. GuruShots challenges rotate with a fresh id each
 * time, so id-keyed per-challenge overrides are lost on every rotation; these
 * rules match on what survives a rotation instead.
 *
 * LAYOUT: a profiles-style dropdown picks the rule to edit (labeled `n.` plus
 * the rule's display-only name, else its first title, tag, type or close
 * times — `ruleDisplayName`), and ONE form below edits it. The order of the
 * dropdown entries is the precedence — for each setting the first matching
 * rule that sets it wins (see `ruleValuesFor` in settings/ruleResolution.ts).
 * The form header (position, reorder arrows, delete) sits OUTSIDE the keyed
 * field subtree, so reordering never remounts the buttons and keyboard focus
 * survives a move; the fields remount on a selection switch so stateful drafts
 * re-read from the freshly selected rule.
 *
 * SELECTION: an index into the rules array, reset to unselected ("—") whenever
 * it points past the end (a shrink-then-regrow must not resurrect it). It
 * follows the rule on ↑/↓, resets on Sort default and delete, and Add selects
 * the new rule. Deleting is two-step (arm, then confirm within
 * CONFIRM_TIMEOUT_MS) and disarms on any selection change, reorder, sort, add
 * or list-length change, so a confirm can never land on a rule the user did
 * not pick (a same-length background refresh swapping content under the armed
 * index within the window is accepted — every keystroke changes the array
 * identity, so keying the arm on it would disarm mid-edit).
 *
 * MATCHING: a rule matches on any mix of titles (any one is enough; each
 * title's mode is is-exactly, starts-with or contains), the challenge's OWN
 * tag (Exhibition, Comm, …, not a photo tag), its type, its photo count, its
 * runtime range in hours and its close time of day (the end time on the card,
 * app timezone, any date). Every filled condition must hold. The optional
 * `name` is display-only: it never matches and is not part of the de-dupe
 * identity, and a named rule with no condition and no behaviour is still
 * dropped on save (the form warns at edit time).
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
 * `{ name?: string, title: string, titles?: string[], match?: 'exact'|'starts'|'contains', challengeTag?: string,
 *    type?: string, pics?: number, minHours?: number, maxHours?: number,
 *    closesAt?: string, closesAtTimes?: string[],
 *    profile?: string, mustIncludeTags: string[], shouldIncludeTags: string[],
 *    autoJoin?: boolean, autoSubmit?: boolean, autoJoinAfterHoursFromStart?: number,
 *    autoJoinWithinHoursOfEnd?: number, autoJoinAfterPercentElapsed?: number, chosenPhotos?: string[],
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

    // The rule the form edits: null = none ("—" in the dropdown).
    const [selected, setSelected] = useState<number | null>(null);
    // The two-step delete: armed (first press) then confirmed (second press).
    const [deleteArmed, setDeleteArmed] = useState(false);
    const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearConfirmTimer = useCallback(() => {
        if (confirmTimerRef.current) {
            clearTimeout(confirmTimerRef.current);
            confirmTimerRef.current = null;
        }
    }, []);
    const disarm = useCallback(() => {
        clearConfirmTimer();
        setDeleteArmed(false);
    }, [clearConfirmTimer]);
    const arm = useCallback(() => {
        clearConfirmTimer();
        setDeleteArmed(true);
        confirmTimerRef.current = setTimeout(() => {
            confirmTimerRef.current = null;
            setDeleteArmed(false);
        }, CONFIRM_TIMEOUT_MS);
    }, [clearConfirmTimer]);
    useEffect(() => clearConfirmTimer, [clearConfirmTimer]);

    // Normalize the STORED selection when it points past the end (a background
    // refresh that shrank the list, or any other length change this component
    // did not cause itself). Only clamping at read time would resurrect the
    // stale index when the list regrows.
    useEffect(() => {
        setSelected((current) => (current !== null && current >= rules.length ? null : current));
    }, [rules.length]);
    // A list-length change must never leave a delete armed: the confirm would
    // fire against a list the user has not seen change.
    useEffect(() => {
        disarm();
    }, [rules.length, disarm]);

    const updateRule = (index: number, patch: LooseRecord) => {
        onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    };

    const pickRule = (raw: string) => {
        disarm();
        setSelected(raw === '' ? null : Number(raw));
    };

    // `index` comes from the header's own render, where the selection is
    // narrowed to a number — the arrows only exist for a picked rule.
    const moveRule = (index: number, delta: number) => {
        const next = [...rules];
        [next[index], next[index + delta]] = [next[index + delta], next[index]];
        disarm();
        setSelected(index + delta);
        onChange(next);
    };

    const sortDefault = () => {
        disarm();
        // Sorting scrambles indices, so following the selected rule through
        // sortRulesByDefaultOrder is not worth the tracking: deselect.
        setSelected(null);
        onChange(sortRulesByDefaultOrder(rules));
    };

    const addRule = () => {
        disarm();
        setSelected(rules.length);
        onChange([...rules, { name: '', title: '', profile: '', mustIncludeTags: [], shouldIncludeTags: [] }]);
    };

    const removeSelected = (index: number) => {
        if (!deleteArmed) {
            arm();
            return;
        }
        disarm();
        // No ghost rule: the form goes back to "—".
        setSelected(null);
        onChange(rules.filter((_, i) => i !== index));
    };

    // Selection changes (dropdown pick, reorder, sort, add, delete, the
    // normalize above) all flow through here-disarmed handlers or the effects,
    // so an armed confirm can never inherit another picked rule.
    useEffect(() => {
        disarm();
    }, [selected, disarm]);

    const selectedRule = selected !== null ? rules[selected] : undefined;

    // One polite live region: the picked rule's position announces on every
    // selection/reorder change, an armed delete announces its confirm prompt.
    const liveText = deleteArmed
        ? t('app.confirmDelete')
        : selected === null
          ? ''
          : rules[selected] !== undefined
            ? t('app.titleRulePositionOf', { n: selected + 1, m: rules.length })
            : '';
    // The name-only drop warning mirrors the sanitizer's two drop paths: no
    // match condition at all, or conditions without any behaviour.
    const nameOnlyWarning =
        selectedRule !== undefined &&
        typeof selectedRule.name === 'string' &&
        selectedRule.name.trim() !== '' &&
        (!hasRuleCondition(selectedRule) || !ruleHasBehaviour(selectedRule));

    return (
        <div className="space-y-3">
            {rules.length === 0 && <p className="text-sm text-base-content/70">{t('app.noTitleTagRules')}</p>}

            {rules.length > 0 && (
                <div className="flex items-center gap-2">
                    <select
                        className="select select-sm flex-1 min-w-40"
                        aria-label={t('app.titleRuleSelectRule')}
                        value={selected === null ? '' : String(selected)}
                        onChange={(e) => pickRule(e.currentTarget.value)}
                    >
                        {/* Not disabled: after a delete cleared the selection, "—"
                            must be selectable again. */}
                        <option value="">—</option>
                        {rules.map((rule, index) => {
                            const display = collapseWhitespace(ruleDisplayName(rule));
                            return (
                                <option key={index} value={String(index)}>
                                    {`${index + 1}. ${display || t('app.titleRuleUntitled')}`}
                                </option>
                            );
                        })}
                    </select>
                </div>
            )}

            {rules.length > 1 && (
                <div className="flex items-center gap-2">
                    <p className="text-xs text-base-content/70 flex-1">{t('app.titleRuleOrderHint')}</p>
                    <button type="button" className="btn btn-outline btn-sm" onClick={sortDefault}>
                        {t('app.titleRuleSortDefault')}
                    </button>
                </div>
            )}

            {selectedRule !== undefined && selected !== null && (
                <div className="rounded-box border border-base-300 p-3 space-y-3">
                    {/* The header stays OUTSIDE the keyed field subtree below, so
                    the move/delete buttons survive a reorder without remounting
                    and keyboard focus is not dropped after every move. */}
                    <div className="flex items-center gap-2">
                        <p aria-live="polite" className="text-sm font-medium">
                            {liveText}
                        </p>
                        <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            title={t('app.titleRuleMoveUp')}
                            aria-label={`${t('app.titleRuleMoveUp')} ${selected + 1}`}
                            disabled={selected === 0}
                            onClick={() => moveRule(selected, -1)}
                        >
                            ↑
                        </button>
                        <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            title={t('app.titleRuleMoveDown')}
                            aria-label={`${t('app.titleRuleMoveDown')} ${selected + 1}`}
                            disabled={selected === rules.length - 1}
                            onClick={() => moveRule(selected, 1)}
                        >
                            ↓
                        </button>
                        <button
                            type="button"
                            className={`btn btn-sm ml-auto ${deleteArmed ? 'btn-error' : 'btn-outline'}`}
                            title={t('app.removeTitleTagRule')}
                            aria-label={`${t('app.removeTitleTagRule')} ${selected + 1}`}
                            onClick={() => removeSelected(selected)}
                        >
                            {deleteArmed ? t('app.confirmDelete') : t('app.removeTitleTagRule')}
                        </button>
                    </div>

                    {/* Keyed on the selection: a switch remounts the fields so the
                    stateful list drafts (TagsField, close times, hours/minutes)
                    re-read from the freshly selected rule. */}
                    <div key={selected} className="space-y-3">
                        <div className="flex flex-col gap-1">
                            <label className="label py-1" htmlFor="title-rule-name">
                                <span className="text-sm">{t('app.titleRuleName')}</span>
                            </label>
                            <input
                                id="title-rule-name"
                                type="text"
                                className="input input-sm"
                                maxLength={MAX_TITLE_LENGTH}
                                aria-label={t('app.titleRuleName')}
                                value={typeof selectedRule.name === 'string' ? selectedRule.name : ''}
                                onChange={(e) => updateRule(selected, { name: e.currentTarget.value })}
                            />
                            <p className="text-xs text-base-content/70">{t('app.titleRuleNameHint')}</p>
                        </div>
                        {nameOnlyWarning && (
                            <div role="alert" className="alert alert-warning py-2 text-sm">
                                <span>{t('app.titleRuleNameOnlyWarning')}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <span className="text-sm flex-1">{t('app.titleRuleTitlesLabel')}</span>
                        </div>
                        <RuleTitleList rule={selectedRule} onPatch={(patch) => updateRule(selected, patch)} />
                        <RuleClassConditions rule={selectedRule} onPatch={(patch) => updateRule(selected, patch)} />
                        <p className="text-xs text-base-content/70">{t('app.titleRuleConditionsHint')}</p>
                        <RuleProfileSelect
                            rule={selectedRule}
                            profiles={profiles}
                            onPatch={(patch) => updateRule(selected, patch)}
                        />
                        <RuleScenarioSelect rule={selectedRule} onPatch={(patch) => updateRule(selected, patch)} />
                        <RuleBehaviour rule={selectedRule} onPatch={(patch) => updateRule(selected, patch)} />
                        {isBroadSpendingRule(selectedRule) && (
                            <div role="alert" className="alert alert-warning py-2 text-sm">
                                <span>{t('app.titleRuleBroadWarning')}</span>
                            </div>
                        )}
                        {TAG_FIELDS.map((field) => (
                            <RuleTagsField
                                key={field.settingKey}
                                {...field}
                                index={selected}
                                rule={selectedRule}
                                onPatch={(patch) => updateRule(selected, patch)}
                            />
                        ))}
                    </div>
                </div>
            )}

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
