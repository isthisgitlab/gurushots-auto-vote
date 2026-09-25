import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useActiveChallenges } from '@/api/useActiveChallenges';
import { interp } from '@/utils/interp';
import * as ipc from '@/api/ipc';
import { SettingInput } from '../SettingInput';
import { ScenarioError } from '../ScenarioError';
import { ConditionList, ActionList } from './ItemEditors';
import { REPEAT_MODES, LIMIT_KEYS } from '../../../../scenarios/vocabulary';
import {
    setIn,
    moveItem,
    addPhase,
    renamePhase,
    removePhase,
    newRule,
    isEditableDraft,
} from '../../../../scenarios/builderModel';

/**
 * The visual scenario builder: every part of a scenario document as a form —
 * name, start phase and limits; each phase's settings overlay and rules; each
 * rule's conditions and actions — plus the same document as JSON, a what-if
 * simulation against a live challenge, and save. It edits a plain draft and
 * never validates it itself: save and simulate run the real validator and the
 * problems come back by path.
 */

const CONTROL = 'input input-sm input-bordered w-full';

/** A phase's settings overlay: per-challenge setting keys and their values. */
function PhaseSettings({ settings, onChange }) {
    const { t } = useTranslation();
    const { schema } = useSettingsSchema();
    const perChallenge = Object.entries(schema ?? {}).filter(
        ([key, config]) => config.perChallenge && key !== 'scenario',
    );
    const current = settings ?? {};
    const keys = Object.keys(current);
    return (
        <div className="space-y-2">
            <div className="text-xs font-medium">{t('app.sbPhaseSettings')}</div>
            {keys.length === 0 && <p className="text-xs text-base-content/60">{t('app.sbNoSettings')}</p>}
            {keys.map((key) => {
                const config = schema?.[key];
                return (
                    <div key={key} className="flex items-center gap-2">
                        <span className="text-xs w-40 shrink-0">{config ? t(config.label) : key}</span>
                        {config && (
                            <SettingInput
                                settingKey={key}
                                id={`sb-setting-${key}`}
                                config={config}
                                value={current[key]}
                                onChange={(settingKey, value) => onChange({ ...current, [settingKey]: value })}
                                onReset={(settingKey) => onChange({ ...current, [settingKey]: config.default })}
                            />
                        )}
                        <button
                            type="button"
                            className="btn btn-xs btn-ghost text-error"
                            onClick={() => onChange(setIn(current, [key], undefined))}
                        >
                            {t('app.sbRemove')}
                        </button>
                    </div>
                );
            })}
            <select
                className="select select-xs select-bordered"
                aria-label={t('app.sbAddSetting')}
                value=""
                onChange={(e) => onChange({ ...current, [e.target.value]: schema[e.target.value].default })}
            >
                <option value="">{t('app.sbPickSetting')}</option>
                {perChallenge
                    .filter(([key]) => !keys.includes(key))
                    .map(([key, config]) => (
                        <option key={key} value={key}>
                            {t(config.label)}
                        </option>
                    ))}
            </select>
        </div>
    );
}

/** One rule: its name, repeat mode, conditions and actions. */
function RuleEditor({ rule, onChange, phases, controls }) {
    const { t } = useTranslation();
    return (
        <div className="rounded border border-base-300 p-2 space-y-2 bg-base-100">
            <div className="flex flex-wrap gap-2 items-end">
                <label className="form-control text-xs gap-1 flex-1 min-w-40">
                    <span className="opacity-70">{t('app.sbRuleLabel')}</span>
                    <input
                        type="text"
                        className={CONTROL}
                        value={rule.label ?? ''}
                        placeholder={rule.id}
                        onChange={(e) => onChange(setIn(rule, ['label'], e.target.value || undefined))}
                    />
                </label>
                <label className="form-control text-xs gap-1">
                    <span className="opacity-70">{t('app.sbRepeat')}</span>
                    <select
                        className="select select-sm select-bordered"
                        value={rule.repeat ?? 'always'}
                        onChange={(e) => onChange({ ...rule, repeat: e.target.value })}
                    >
                        {REPEAT_MODES.map((mode) => (
                            <option key={mode} value={mode}>
                                {t(`app.sbRepeat_${mode}`)}
                            </option>
                        ))}
                    </select>
                </label>
                {controls}
            </div>
            <div className="text-xs font-medium">{t('app.sbConditions')}</div>
            {(rule.if ?? []).length === 0 && (
                <p className="text-xs text-base-content/60">{t('app.sbConditionsEmpty')}</p>
            )}
            <ConditionList value={rule.if} onChange={(next) => onChange({ ...rule, if: next })} phases={phases} />
            <div className="text-xs font-medium">{t('app.sbActions')}</div>
            <ActionList value={rule.do} onChange={(next) => onChange({ ...rule, do: next })} phases={phases} />
        </div>
    );
}

/** One phase: its name, settings overlay and rules. */
function PhaseEditor({ name, phase, draft, onDraft, phases }) {
    const { t } = useTranslation();
    const [editingName, setEditingName] = useState(name);
    const rules = phase.rules ?? [];
    const setRules = (next) => onDraft(setIn(draft, ['phases', name, 'rules'], next));
    return (
        <section className="rounded-lg border border-base-300 p-3 space-y-3">
            <div className="flex gap-2 items-end">
                <label className="form-control text-xs gap-1 flex-1">
                    <span className="opacity-70">{t('app.sbPhaseName')}</span>
                    <input
                        type="text"
                        className={CONTROL}
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => {
                            const renamed = renamePhase(draft, name, editingName.trim());
                            if (renamed === draft) setEditingName(name);
                            else onDraft(renamed);
                        }}
                    />
                </label>
                <button
                    type="button"
                    className="btn btn-sm btn-ghost text-error"
                    disabled={phases.length <= 1}
                    onClick={() => onDraft(removePhase(draft, name))}
                >
                    {t('app.sbRemovePhase')}
                </button>
            </div>
            <PhaseSettings
                settings={phase.settings}
                onChange={(next) => onDraft(setIn(draft, ['phases', name, 'settings'], next))}
            />
            <div className="text-xs font-medium">{t('app.sbRules')}</div>
            {rules.map((rule, index) => (
                <RuleEditor
                    key={rule.id}
                    rule={rule}
                    phases={phases}
                    onChange={(next) => setRules(rules.map((old, i) => (i === index ? next : old)))}
                    controls={
                        <div className="flex gap-1">
                            <button
                                type="button"
                                className="btn btn-xs btn-ghost"
                                disabled={index === 0}
                                onClick={() => setRules(moveItem(rules, index, -1))}
                            >
                                {t('app.sbMoveUp')}
                            </button>
                            <button
                                type="button"
                                className="btn btn-xs btn-ghost"
                                disabled={index === rules.length - 1}
                                onClick={() => setRules(moveItem(rules, index, 1))}
                            >
                                {t('app.sbMoveDown')}
                            </button>
                            <button
                                type="button"
                                className="btn btn-xs btn-ghost text-error"
                                onClick={() => setRules(rules.filter((_, i) => i !== index))}
                            >
                                {t('app.sbRemove')}
                            </button>
                        </div>
                    }
                />
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setRules([...rules, newRule(draft, name)])}>
                {t('app.sbAddRule')}
            </button>
        </section>
    );
}

/** The scenario's name, description, start phase and spending limits. */
function ScenarioHeader({ draft, onDraft, phases }) {
    const { t } = useTranslation();
    return (
        <div className="grid gap-2 sm:grid-cols-2">
            <label className="form-control text-xs gap-1">
                <span className="opacity-70">{t('app.sbName')}</span>
                <input
                    type="text"
                    className={CONTROL}
                    value={draft.name}
                    onChange={(e) => onDraft({ ...draft, name: e.target.value })}
                />
            </label>
            <label className="form-control text-xs gap-1">
                <span className="opacity-70">{t('app.sbStart')}</span>
                <select
                    className="select select-sm select-bordered"
                    value={draft.start}
                    onChange={(e) => onDraft({ ...draft, start: e.target.value })}
                >
                    {phases.map((phase) => (
                        <option key={phase} value={phase}>
                            {phase}
                        </option>
                    ))}
                </select>
            </label>
            <label className="form-control text-xs gap-1 sm:col-span-2">
                <span className="opacity-70">{t('app.sbDescription')}</span>
                <input
                    type="text"
                    className={CONTROL}
                    value={draft.description ?? ''}
                    onChange={(e) => onDraft(setIn(draft, ['description'], e.target.value || undefined))}
                />
            </label>
            <fieldset className="sm:col-span-2 text-xs">
                <legend className="opacity-70 mb-1">{t('app.sbLimits')}</legend>
                <div className="flex gap-2">
                    {LIMIT_KEYS.map((key) => (
                        <label key={key} className="form-control gap-1">
                            <span>{t(`app.sbCurrency_${key}`)}</span>
                            <input
                                type="number"
                                min={0}
                                className="input input-sm input-bordered w-24"
                                value={draft.limits?.[key] ?? ''}
                                onChange={(e) =>
                                    onDraft(
                                        setIn(
                                            draft,
                                            ['limits', key],
                                            e.target.value === '' ? undefined : Number(e.target.value),
                                        ),
                                    )
                                }
                            />
                        </label>
                    ))}
                </div>
            </fieldset>
        </div>
    );
}

/** The whole draft as JSON; a valid edit replaces the draft. */
function JsonTab({ draft, onDraft }) {
    const { t } = useTranslation();
    const [text, setText] = useState(() => JSON.stringify(draft, null, 2));
    const [invalid, setInvalid] = useState(false);
    return (
        <div className="space-y-2">
            <p className="text-xs text-base-content/60">{t('app.sbJsonHint')}</p>
            <textarea
                className="textarea textarea-bordered w-full font-mono text-xs"
                rows={16}
                aria-label={t('app.sbTabJson')}
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    let parsed;
                    try {
                        parsed = JSON.parse(e.target.value);
                    } catch {
                        parsed = undefined;
                    }
                    // Only a document the forms can render replaces the draft.
                    const editable = isEditableDraft(parsed);
                    if (editable) onDraft(parsed);
                    setInvalid(!editable);
                }}
            />
            {invalid && (
                <p className="text-xs text-warning" role="status">
                    {t('app.sbJsonInvalid')}
                </p>
            )}
        </div>
    );
}

/** A what-if timeline of the draft on one live challenge. */
function SimulatePanel({ draft }) {
    const { t } = useTranslation();
    const { data: challenges } = useActiveChallenges(false);
    const [challengeId, setChallengeId] = useState('');
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    const run = async () => {
        const response = await ipc.simulateScenario(challengeId, draft);
        if (response?.success) {
            setResult(response);
            setError(null);
        } else {
            setResult(null);
            setError({ what: 'app.sbSimulateFailed', issues: response?.issues });
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex gap-2 items-center">
                <select
                    className="select select-sm select-bordered"
                    aria-label={t('app.sbSimulateOn')}
                    value={challengeId}
                    onChange={(e) => setChallengeId(e.target.value)}
                >
                    <option value="">{t('app.sbSimulatePick')}</option>
                    {challenges.map((challenge) => (
                        <option key={challenge.id} value={String(challenge.id)}>
                            {challenge.title}
                        </option>
                    ))}
                </select>
                <button type="button" className="btn btn-sm" disabled={!challengeId} onClick={run}>
                    {t('app.sbSimulate')}
                </button>
            </div>
            <ScenarioError error={error} />
            {result && (
                <div className="text-xs bg-base-200 rounded p-2 space-y-1">
                    <p className="text-base-content/60">{t('app.sbSimulateAssume')}</p>
                    {result.events.length === 0 ? (
                        <p>{t('app.sbSimulateNothing')}</p>
                    ) : (
                        <ol className="space-y-0.5">
                            {result.events.map((event, index) => (
                                <li key={`${event.at}:${event.ruleId}:${index}`}>
                                    <span className="font-mono">{new Date(event.at * 1000).toLocaleString()}</span> · [
                                    {event.phase}] {event.label}: {event.actions.join(', ')}
                                    {event.toPhase && ` · ${interp(t('app.sbToPhase'), { phase: event.toPhase })}`}
                                </li>
                            ))}
                        </ol>
                    )}
                    <p>{t(`app.sbStop_${result.stoppedBecause}`)}</p>
                    {result.halted && <p className="text-warning">{result.halted}</p>}
                </div>
            )}
        </div>
    );
}

/**
 * @param {{initial: object, originalName: string|null, onSaved: Function, onCancel: Function}} props
 *   originalName: the stored name being edited, or null for a new scenario
 */
export function ScenarioBuilder({ initial, originalName, onSaved, onCancel }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(initial);
    const [tab, setTab] = useState('builder');
    const [error, setError] = useState(null);
    const phases = Object.keys(draft.phases);

    const save = async () => {
        setError(null);
        const renamed = originalName !== null && originalName.toLowerCase() !== String(draft.name).toLowerCase();
        if (renamed) {
            const moved = await ipc.renameScenario(originalName, draft.name);
            if (!moved?.success) {
                setError({ what: 'app.sbSaveFailed', issues: moved?.issues });
                return;
            }
        }
        const result = await ipc.saveScenario(draft, { overwrite: originalName !== null });
        if (result?.success) onSaved();
        else setError({ what: 'app.sbSaveFailed', issues: result?.issues });
    };

    return (
        <div className="border border-base-300 rounded-lg p-3 space-y-3">
            <h5 className="font-semibold">{t(originalName === null ? 'app.sbTitleNew' : 'app.sbTitleEdit')}</h5>
            <div role="tablist" className="tabs tabs-bordered">
                {['builder', 'json'].map((name) => (
                    <button
                        key={name}
                        type="button"
                        role="tab"
                        aria-selected={tab === name}
                        className={`tab ${tab === name ? 'tab-active' : ''}`}
                        onClick={() => setTab(name)}
                    >
                        {t(name === 'builder' ? 'app.sbTabBuilder' : 'app.sbTabJson')}
                    </button>
                ))}
            </div>
            {tab === 'json' ? (
                <JsonTab draft={draft} onDraft={setDraft} />
            ) : (
                <div className="space-y-3">
                    <ScenarioHeader draft={draft} onDraft={setDraft} phases={phases} />
                    <div className="text-sm font-medium">{t('app.sbPhases')}</div>
                    {phases.map((name) => (
                        <PhaseEditor
                            key={name}
                            name={name}
                            phase={draft.phases[name]}
                            draft={draft}
                            onDraft={setDraft}
                            phases={phases}
                        />
                    ))}
                    <button type="button" className="btn btn-sm" onClick={() => setDraft(addPhase(draft))}>
                        {t('app.sbAddPhase')}
                    </button>
                </div>
            )}
            <SimulatePanel draft={draft} />
            <ScenarioError error={error} />
            <div className="flex gap-2">
                <button type="button" className="btn btn-sm btn-primary" onClick={save}>
                    {t('app.sbSave')}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
                    {t('app.cancel')}
                </button>
            </div>
        </div>
    );
}
