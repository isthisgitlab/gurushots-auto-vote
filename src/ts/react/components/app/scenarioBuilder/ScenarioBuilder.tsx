import { useState, useEffect, useId, useMemo, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ToneNote } from '@/components/ui/ToneNote';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useScenarios } from '@/api/useScenarios';
import { useScenarioCapabilities } from '@/api/useScenarioCapabilities';
import { useSimulationSubjects } from '@/api/useSimulationSubjects';
import { usePhaseProfiles } from '@/api/usePhaseProfiles';
import { usePhotoPools } from '@/api/usePhotoPools';
import { useAsyncIpcAction } from '@/api/useAsyncIpcAction';
import { EffectOutcomeNotice } from '@/components/ui/EffectOutcomeNotice';
import { BusyContent } from '@/components/ui/LoadingSpinner';
import { ipcErrorText } from '@/api/ipcErrorText';
import * as ipc from '@/api/ipc';
import { useLatestRef } from '@/hooks/useLatestRef';
import { valuesEqual } from '@/utils/valuesEqual';
import { SettingInput, SettingLabel } from '../SettingInput';
import { ScenarioError, failureIssuesOf } from '../ScenarioError';
import { ConditionList, ActionList, LiteralByDescriptor } from './ItemEditors';
import { ExpressionEditor } from './ExpressionEditor';
import { ScheduleEditor } from './ScheduleEditor';
import { useListFocus } from './listFocus';
import type { ListFocus } from './listFocus';
import { scenarioRefusalText, restrictionText } from '@/utils/scenarioIssueText';
import {
    REPEAT_MODES,
    LIMIT_KEYS,
    SCOPE_STAGES,
    SIMULATION_OPERATIONS,
    SIMULATION_OUTCOMES,
} from '../../../../core/scenarios/vocabulary';
import {
    SCHEDULE_REPLACED_KEYS,
    POOL_REPLACED_KEYS,
    expectedOfDescriptor,
} from '../../../../core/scenarios/builderSpec';
import {
    setIn,
    moveItem,
    addPhase,
    renamePhase,
    removePhase,
    newRule,
    isEditableDraft,
    bindPhotoPool,
} from '../../../../core/scenarios/builderModel';

import type { ComponentChildren, TargetedKeyboardEvent } from 'preact';
import type { WindowApi } from '../../../../core/types/ipc';
import type { ScenarioDraft, ScenarioDraftPhase, ScenarioDraftRule } from '../../../../core/types/scenarioBuilder';
import type { RendererSchema } from '../../../../core/types/settingsEditor';
import type { ScenarioErrorInfo } from '../ScenarioError';
import type { BuilderScope } from './ItemEditors';
import type { ScenarioStage, SimulationOutcome } from '../../../../core/types/scenario';
import type { ScenarioScope } from '../../../../core/types/settings';

/**
 * A successful simulate-scenario: the what-if timeline and why it stopped.
 */
type SimulationResult = Extract<Awaited<ReturnType<WindowApi['simulateScenario']>>, { success: true }>;

/**
 * The visual scenario builder: every part of a scenario document as a form —
 * name, scope, start phase and limits; each phase's settings overlay, live-value
 * bindings, dynamic schedules, profile, pins, photo pool and rules; each rule's
 * stages, conditions and actions — plus the same document as JSON, the capability
 * catalogue, a what-if simulation, and save. It edits a plain draft and never
 * validates it itself: save and simulate run the real validator and the problems
 * come back by path.
 */

const CONTROL = 'input input-sm w-full';
const TABS = ['builder', 'json', 'keys'] as const;

/** The tab a key moves to from `index` (the arrows wrap, Home / End jump to the ends), or null for any other key. */
function tabAfterKey(key: string, index: number): number | null {
    if (key === 'ArrowRight') return (index + 1) % TABS.length;
    if (key === 'ArrowLeft') return (index + TABS.length - 1) % TABS.length;
    if (key === 'Home') return 0;
    return key === 'End' ? TABS.length - 1 : null;
}

/** The stages a rule of `scope` runs in when it declares none. */
const defaultStages = (scope: ScenarioScope): ScenarioStage[] => (scope === 'installation' ? ['account'] : ['active']);

/** A rule's stages as the document holds them: the ones it declares in this scope, else the scope's default. */
const stagesOf = (rule: ScenarioDraftRule, scope: ScenarioScope): ScenarioStage[] => {
    const declared = (rule.stages ?? []).filter((stage) =>
        (SCOPE_STAGES[scope] as readonly string[]).includes(stage),
    ) as ScenarioStage[];
    return declared.length > 0 ? declared : defaultStages(scope);
};

/** The keys a phase's schedules replace, and its photo pool's Chosen Photos keys: not offered next to what replaces them. */
const keysTakenByHoldings = (phase: ScenarioDraftPhase): string[] => [
    ...(['submit', 'vote', 'pause'] as const).flatMap((kind) =>
        phase.schedules && typeof phase.schedules === 'object' && (phase.schedules as Record<string, unknown>)[kind]
            ? SCHEDULE_REPLACED_KEYS[kind]
            : [],
    ),
    ...(phase.photoPool ? POOL_REPLACED_KEYS : []),
];

/** A heading the keyboard lands on when the row it was on is removed: a removed button cannot keep the focus. */
function useFocusAnchor() {
    const ref = useRef<HTMLDivElement>(null);
    return { ref, focus: () => ref.current?.focus() };
}

/**
 * A phase's settings overlay: literal values, one row per key the phase sets.
 */
function PhaseSettings({
    phase,
    onPhase,
    catalogue,
    schema,
}: {
    phase: ScenarioDraftPhase;
    onPhase: (next: ScenarioDraftPhase) => void;
    catalogue: BuilderScope;
    schema: RendererSchema | null;
}) {
    const { t } = useTranslation();
    // Every input of this phase has its own id, so two phases that set the same key never share one.
    const idBase = useId();
    const anchor = useFocusAnchor();
    const current = phase.settings ?? {};
    const keys = Object.keys(current);
    const taken = keysTakenByHoldings(phase);
    const offered = catalogue.writableKeys.filter(
        (key) =>
            !keys.includes(key) &&
            !Object.prototype.hasOwnProperty.call(phase.bindings ?? {}, key) &&
            !taken.includes(key),
    );
    return (
        <div className="space-y-2">
            <div ref={anchor.ref} tabIndex={-1} className="text-xs font-medium">
                {t('app.sbPhaseSettings')}
            </div>
            {keys.length === 0 && <p className="text-xs text-base-content/70">{t('app.sbNoSettings')}</p>}
            {keys.map((key) => {
                const config = schema?.[key];
                const descriptor = catalogue.descriptors[key];
                const inputId = `${idBase}-${key}`;
                return (
                    <div key={key} className="flex flex-wrap items-center gap-2">
                        {config ? (
                            <>
                                <div className="w-40 shrink-0 text-xs">
                                    <SettingLabel inputId={inputId} type={config.type} config={config}>
                                        <span>{t(config.label)}</span>
                                    </SettingLabel>
                                </div>
                                <SettingInput
                                    settingKey={key}
                                    id={inputId}
                                    config={config}
                                    value={current[key]}
                                    onChange={(settingKey, value) =>
                                        onPhase({ ...phase, settings: { ...current, [settingKey]: value } })
                                    }
                                    onReset={(settingKey) =>
                                        onPhase({ ...phase, settings: { ...current, [settingKey]: config.default } })
                                    }
                                />
                            </>
                        ) : (
                            <>
                                <span className="text-xs w-40 shrink-0">{key}</span>
                                {descriptor && (
                                    <LiteralByDescriptor
                                        label={key}
                                        descriptor={descriptor as never}
                                        value={current[key]}
                                        onChange={(next) =>
                                            onPhase({ ...phase, settings: { ...current, [key]: next } })
                                        }
                                    />
                                )}
                            </>
                        )}
                        <button
                            type="button"
                            className="btn btn-sm btn-ghost text-error"
                            aria-label={t('app.actionOnItem', {
                                action: t('app.sbRemove'),
                                item: config ? t(config.label) : key,
                            })}
                            onClick={() => {
                                anchor.focus();
                                onPhase({ ...phase, settings: setIn(current, [key], undefined) });
                            }}
                        >
                            {t('app.sbRemove')}
                        </button>
                        {/* A scenario has no state until its challenge is joined, so a join never sees this list. */}
                        {key === 'chosenPhotos' && (
                            <ToneNote tone="info" className="w-full text-xs">
                                {t('app.chosenPhotosScenarioHint')}
                            </ToneNote>
                        )}
                    </div>
                );
            })}
            {offered.length > 0 && (
                <select
                    className="select select-sm"
                    aria-label={t('app.sbAddSetting')}
                    value=""
                    onChange={(e) => {
                        const key = e.currentTarget.value;
                        // Only a listed key can be picked, and the list comes from the capability catalogue.
                        onPhase({
                            ...phase,
                            settings: {
                                ...current,
                                [key]: schema?.[key] ? schema[key].default : literalDefault(catalogue.descriptors[key]),
                            },
                        });
                    }}
                >
                    <option value="">{t('app.sbPickSetting')}</option>
                    {offered.map((key) => (
                        <option key={key} value={key}>
                            {labelOf(key, schema, t)}
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}

/** A setting key's label: its setting's name when the schema or translations hold none for it. */
const labelOf = (key: string, schema: RendererSchema | null, t: (key: string) => string): string => {
    const config = schema?.[key];
    if (config) return t(config.label);
    const label = t(`app.${key}`);
    return label === `app.${key}` ? key : label;
};

/** A literal a key with no schema entry starts on, from its value descriptor. */
const literalDefault = (descriptor: { kind: string; values?: readonly string[] } | undefined): unknown => {
    switch (descriptor?.kind) {
        case 'boolean':
            return false;
        case 'enum':
            return descriptor.values?.[0];
        case 'string':
            return '';
        case 'list':
            return [];
        default:
            return 0;
    }
};

/**
 * A phase's live-value bindings: the settings whose value is worked out when the phase is published.
 */
function PhaseBindings({
    phase,
    onPhase,
    catalogue,
    schema,
    ruleStages,
}: {
    phase: ScenarioDraftPhase;
    onPhase: (next: ScenarioDraftPhase) => void;
    catalogue: BuilderScope;
    schema: RendererSchema | null;
    ruleStages: readonly ScenarioStage[];
}) {
    const { t } = useTranslation();
    const anchor = useFocusAnchor();
    const current = phase.bindings ?? {};
    const keys = Object.keys(current);
    const taken = keysTakenByHoldings(phase);
    const offered = catalogue.writableKeys.filter(
        (key) =>
            !keys.includes(key) &&
            !Object.prototype.hasOwnProperty.call(phase.settings ?? {}, key) &&
            !taken.includes(key) &&
            expectedOfDescriptor(catalogue.descriptors[key]) !== null,
    );
    return (
        <div className="space-y-2">
            <div ref={anchor.ref} tabIndex={-1} className="text-xs font-medium">
                {t('app.sbPhaseBindings')}
            </div>
            {keys.length === 0 && <p className="text-xs text-base-content/70">{t('app.sbNoBindings')}</p>}
            {keys.map((key) => (
                <div key={key} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs w-40 shrink-0">{labelOf(key, schema, t)}</span>
                        <button
                            type="button"
                            className="btn btn-sm btn-ghost text-error"
                            aria-label={t('app.actionOnItem', {
                                action: t('app.sbRemove'),
                                item: labelOf(key, schema, t),
                            })}
                            onClick={() => {
                                anchor.focus();
                                onPhase({ ...phase, bindings: setIn(current, [key], undefined) });
                            }}
                        >
                            {t('app.sbRemove')}
                        </button>
                    </div>
                    <ExpressionEditor
                        value={current[key]}
                        onChange={(next) => onPhase({ ...phase, bindings: { ...current, [key]: next } })}
                        expected={expectedOfDescriptor(catalogue.descriptors[key]) ?? 'any'}
                        context={{
                            stages: ruleStages,
                            settingKeys: catalogue.readableKeys,
                            descriptors: catalogue.descriptors,
                            baseOnly: true,
                        }}
                    />
                </div>
            ))}
            {offered.length > 0 && (
                <select
                    className="select select-sm"
                    aria-label={t('app.sbAddBinding')}
                    value=""
                    onChange={(e) =>
                        onPhase({ ...phase, bindings: { ...current, [e.currentTarget.value]: undefined } })
                    }
                >
                    <option value="">{t('app.sbPickBinding')}</option>
                    {offered.map((key) => (
                        <option key={key} value={key}>
                            {labelOf(key, schema, t)}
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}

/**
 * A phase's pins and photo pool: which photo each power is pinned to, and the named pool its photos come from.
 */
function PhaseHoldings({
    phase,
    onPhase,
    onBindPool,
    onPoolPending,
    catalogue,
    ruleStages,
}: {
    phase: ScenarioDraftPhase;
    onPhase: (next: ScenarioDraftPhase) => void;
    /** Binds a pool to this phase on the draft as it is when the pool is known to exist (a late reply patches only this). */
    onBindPool: (pool: string) => void;
    /** Told whether a pool create of this phase has no final answer (the scenario cannot be saved meanwhile). */
    onPoolPending: (pending: boolean) => void;
    catalogue: BuilderScope;
    ruleStages: readonly ScenarioStage[];
}) {
    const { t } = useTranslation();
    const { pools, refetch, confirm } = usePhotoPools(true);
    const poolNames = Object.keys(pools);
    const pool = phase.photoPool && typeof phase.photoPool === 'object' ? phase.photoPool : undefined;
    const boundPool = pool && typeof pool.name === 'string' && poolNames.includes(pool.name) ? pool.name : undefined;
    // A new pool: its name and photo ids are typed, then saved and bound.
    const [creating, setCreating] = useState<null | { name: string; ids: string }>(null);
    const poolValue = creating === null ? (boundPool ?? (pool ? '__gone' : '')) : '__new';
    // A pool replaces the phase's own Chosen Photos settings, so it is not offered over ones the phase already holds.
    const poolBlocked =
        pool === undefined &&
        POOL_REPLACED_KEYS.some(
            (key) =>
                Object.prototype.hasOwnProperty.call(phase.settings ?? {}, key) ||
                Object.prototype.hasOwnProperty.call(phase.bindings ?? {}, key),
        );
    // The identity of the create form: any choice in the pool select (another pool, none, or the form again) moves it on. A create
    // binds its pool only if the form it was sent from is still the one the user is on.
    const form = useRef(0);
    const sentFrom = useRef(-1);
    // A pool that landed is put into the shared list first, so it never reads as missing and its options show; it is bound only if
    // the user is still on the form that asked for it (the pool exists either way), and the list is then read again.
    const finishCreate = (name: string, ids: string[]) => {
        confirm(name, ids);
        if (sentFrom.current === form.current) {
            onBindPool(name);
            setCreating(null);
        }
        void refetch();
    };
    const create = useAsyncIpcAction(
        ipc.createPhotoPool,
        { failureMessage: 'not-saved' },
        {
            // The reply was lost but the pool was made: what was sent is what is confirmed.
            onApplied: ([name, ids]) => finishCreate(name, ids),
        },
    );
    const pending = create.loading || create.outcome !== null;
    const reportPending = useLatestRef(onPoolPending);
    useEffect(() => reportPending.current(pending), [pending, reportPending]);
    useEffect(() => () => reportPending.current(false), [reportPending]);

    const createPool = async (draft: { name: string; ids: string }) => {
        const ids = draft.ids
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
        const name = draft.name.trim();
        sentFrom.current = form.current;
        // A name another pool holds is refused by the create itself: it never replaces what another scenario draws from.
        const result = await create.run(name, ids);
        if (result.success && ipc.effectOutcomeOf(result) === null) finishCreate(name, ids);
    };

    const profile = typeof phase.profile === 'string' ? phase.profile : undefined;
    return (
        <div className="space-y-2">
            <label className="flex flex-col text-xs gap-1">
                <span className="opacity-70">{t('app.sbPhaseProfile')}</span>
                <select
                    className="select select-sm"
                    aria-label={t('app.sbPhaseProfile')}
                    value={profile ?? ''}
                    onChange={(e) => onPhase(setIn(phase, ['profile'], e.currentTarget.value || undefined))}
                >
                    <option value="">{t('app.sbProfileNone')}</option>
                    {catalogue.profiles.map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                    {profile !== undefined && !catalogue.profiles.includes(profile) && (
                        <option value={profile}>{t('app.scenarioMissingOption', { name: profile })}</option>
                    )}
                </select>
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
                {(['boost', 'turbo'] as const).map((power) => {
                    const pins = phase.pins && typeof phase.pins === 'object' ? phase.pins : {};
                    const value = pins[power];
                    const mode = value === undefined ? 'keep' : value === null ? 'none' : 'photo';
                    return (
                        <label key={power} className="flex flex-col text-xs gap-1">
                            <span className="opacity-70">{t(`app.sbPin_${power}`)}</span>
                            <select
                                className="select select-sm"
                                aria-label={t(`app.sbPin_${power}`)}
                                value={mode}
                                onChange={(e) => {
                                    const next =
                                        e.currentTarget.value === 'keep'
                                            ? undefined
                                            : e.currentTarget.value === 'none'
                                              ? null
                                              : '';
                                    const nextPins = setIn(pins, [power], next);
                                    onPhase(
                                        Object.keys(nextPins).length === 0
                                            ? setIn(phase, ['pins'], undefined)
                                            : { ...phase, pins: nextPins },
                                    );
                                }}
                            >
                                <option value="keep">{t('app.sbPinKeepSaved')}</option>
                                <option value="none">{t('app.sbPinNone')}</option>
                                <option value="photo">{t('app.sbPinThisPhoto')}</option>
                            </select>
                            {mode === 'photo' && (
                                <input
                                    type="text"
                                    className={CONTROL}
                                    placeholder="photo id"
                                    aria-label={t('app.sbPinPhoto', { power: t(`app.sbPin_${power}`) })}
                                    value={String(value)}
                                    onChange={(e) =>
                                        onPhase({ ...phase, pins: { ...pins, [power]: e.currentTarget.value } })
                                    }
                                />
                            )}
                        </label>
                    );
                })}
            </div>
            <label className="flex flex-col text-xs gap-1">
                <span className="opacity-70">{t('app.sbPhotoPool')}</span>
                <select
                    className="select select-sm"
                    aria-label={t('app.sbPhotoPool')}
                    disabled={poolBlocked}
                    value={poolValue}
                    onChange={(e) => {
                        const next = e.currentTarget.value;
                        form.current += 1;
                        if (next === '') {
                            setCreating(null);
                            onPhase({ ...phase, photoPool: undefined });
                        } else if (next === '__new') {
                            setCreating({ name: '', ids: '' });
                        } else {
                            setCreating(null);
                            onPhase({ ...phase, photoPool: { name: next } });
                        }
                    }}
                >
                    <option value="">{t('app.sbPoolNone')}</option>
                    {poolNames.map((name) => (
                        <option key={name} value={name}>
                            {name} ({pools[name].length})
                        </option>
                    ))}
                    {poolValue === '__gone' && <option value="__gone">{t('app.sbPoolGone')}</option>}
                    <option value="__new">{t('app.sbPoolNew')}</option>
                </select>
            </label>
            {poolBlocked && (
                <ToneNote tone="info" className="text-xs">
                    {t('app.sbPoolBlocked')}
                </ToneNote>
            )}
            {creating !== null && (
                <div className="space-y-1">
                    <label className="flex flex-col text-xs gap-1">
                        <span className="opacity-70">{t('app.sbPoolName')}</span>
                        <input
                            type="text"
                            className={CONTROL}
                            aria-label={t('app.sbPoolName')}
                            value={creating.name}
                            onChange={(e) => setCreating({ ...creating, name: e.currentTarget.value })}
                        />
                    </label>
                    <label className="flex flex-col text-xs gap-1">
                        <span className="opacity-70">{t('app.sbPoolPhotos')}</span>
                        <input
                            type="text"
                            className={CONTROL}
                            placeholder="p1, p2"
                            aria-label={t('app.sbPoolPhotos')}
                            value={creating.ids}
                            onChange={(e) => setCreating({ ...creating, ids: e.currentTarget.value })}
                        />
                    </label>
                    <button
                        type="button"
                        className="btn btn-sm"
                        disabled={
                            creating.name.trim() === '' ||
                            creating.ids.trim() === '' ||
                            create.loading ||
                            create.outcome !== null
                        }
                        onClick={() => void createPool(creating)}
                    >
                        {t('app.sbPoolCreate')}
                    </button>
                </div>
            )}
            {create.error !== null && (
                <ToneNote tone="warning" role="status" className="text-xs">
                    {scenarioRefusalText(create.error, t) ?? ipcErrorText(create.error, t)}
                </ToneNote>
            )}
            <EffectOutcomeNotice
                outcome={create.outcome}
                onCheck={create.checkStatus}
                onDismiss={create.dismissOutcome}
            />
            {boundPool !== undefined && pool !== undefined && (
                <div className="flex flex-wrap gap-4">
                    <label className="label cursor-pointer gap-2 text-xs">
                        <input
                            type="checkbox"
                            className="checkbox checkbox-sm"
                            checked={pool.only === true}
                            onChange={(e) =>
                                onPhase({
                                    ...phase,
                                    photoPool: { ...pool, only: e.currentTarget.checked || undefined },
                                })
                            }
                        />
                        {t('app.sbPoolOnly')}
                    </label>
                    <label className="label cursor-pointer gap-2 text-xs">
                        <input
                            type="checkbox"
                            className="checkbox checkbox-sm"
                            checked={pool.inOrder === true}
                            onChange={(e) =>
                                onPhase({
                                    ...phase,
                                    photoPool: { ...pool, inOrder: e.currentTarget.checked || undefined },
                                })
                            }
                        />
                        {t('app.sbPoolInOrder')}
                    </label>
                </div>
            )}
            {/* The schedule editor reads the same stages the phase's bindings do. */}
            <ScheduleEditor
                schedules={phase.schedules}
                onChange={(next) =>
                    onPhase(next === undefined ? setIn(phase, ['schedules'], undefined) : { ...phase, schedules: next })
                }
                context={{
                    stages: ruleStages,
                    settingKeys: catalogue.readableKeys,
                    descriptors: catalogue.descriptors,
                    baseOnly: true,
                }}
                heldKeys={[...Object.keys(phase.settings ?? {}), ...Object.keys(phase.bindings ?? {})]}
            />
        </div>
    );
}

/**
 * One rule: its name, stages, repeat mode, conditions and actions.
 */
function RuleEditor({
    rule,
    onChange,
    phases,
    scope,
    scopeStages,
    controls,
    rowMarks,
}: {
    rule: ScenarioDraftRule;
    onChange: (next: ScenarioDraftRule) => void;
    phases: string[];
    scope: BuilderScope;
    scopeStages: readonly ScenarioStage[];
    controls: ComponentChildren;
    /** The rules list's marks for a row (where the focus lands after an add). */
    rowMarks: ListFocus['row'];
}) {
    const { t } = useTranslation();
    const stages = stagesOf(rule, scope.scope);
    const setStages = (next: ScenarioStage[]) => {
        // The default set (the scope's own) writes no stages field.
        const defaults = defaultStages(scope.scope);
        const isDefault = next.length === defaults.length && defaults.every((stage) => next.includes(stage));
        onChange({ ...rule, stages: isDefault ? undefined : next });
    };
    return (
        <div {...rowMarks} className="rounded border border-base-300 p-2 space-y-2 bg-base-100">
            <div className="flex flex-wrap gap-2 items-end">
                <label className="flex flex-col text-xs gap-1 flex-1 min-w-40">
                    <span className="opacity-70">{t('app.sbRuleLabel')}</span>
                    <input
                        type="text"
                        className={CONTROL}
                        value={rule.label ?? ''}
                        placeholder={rule.id}
                        onChange={(e) => onChange(setIn(rule, ['label'], e.currentTarget.value || undefined))}
                    />
                </label>
                <label className="flex flex-col text-xs gap-1">
                    <span className="opacity-70">{t('app.sbRepeat')}</span>
                    <select
                        className="select select-sm"
                        value={rule.repeat ?? 'always'}
                        onChange={(e) => onChange({ ...rule, repeat: e.currentTarget.value })}
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
            {scopeStages.length > 1 && (
                <fieldset className="text-xs">
                    <legend className="opacity-70 mb-1">{t('app.sbStages')}</legend>
                    <div className="flex flex-wrap gap-3">
                        {scopeStages.map((stage) => (
                            <label key={stage} className="label cursor-pointer gap-2">
                                <input
                                    type="checkbox"
                                    className="checkbox checkbox-sm"
                                    checked={stages.includes(stage)}
                                    // A rule always runs in at least one stage, so the last checked box stays on.
                                    disabled={stages.length === 1 && stages[0] === stage}
                                    onChange={(e) =>
                                        setStages(
                                            e.currentTarget.checked
                                                ? scopeStages.filter((name) => name === stage || stages.includes(name))
                                                : stages.filter((name) => name !== stage),
                                        )
                                    }
                                />
                                {t(`app.sbStage_${stage}`)}
                            </label>
                        ))}
                    </div>
                </fieldset>
            )}
            <div className="text-xs font-medium">{t('app.sbConditions')}</div>
            {(rule.if ?? []).length === 0 && (
                <p className="text-xs text-base-content/70">{t('app.sbConditionsEmpty')}</p>
            )}
            <ConditionList
                value={rule.if}
                onChange={(next) => onChange({ ...rule, if: next })}
                phases={phases}
                scope={scope}
            />
            <div className="text-xs font-medium">{t('app.sbActions')}</div>
            <ActionList
                value={rule.do}
                onChange={(next) => onChange({ ...rule, do: next })}
                phases={phases}
                scope={scope}
            />
        </div>
    );
}

/**
 * One phase: its name, settings overlay, bindings, holdings, schedules and rules.
 */
function PhaseEditor({
    name,
    phase,
    draft,
    onDraft,
    onUpdate,
    onPoolPending,
    phases,
    base,
    schema,
    focus,
    position,
}: {
    name: string;
    phase: ScenarioDraftPhase;
    draft: ScenarioDraft;
    onDraft: (next: ScenarioDraft) => void;
    /** An edit made on the draft as it is when it applies (a reply that arrives later), not on the one the caller saw. */
    onUpdate: (edit: (current: ScenarioDraft) => ScenarioDraft) => void;
    /** Told whether a pool create of the phase `name` has no final answer. */
    onPoolPending: (phase: string, pending: boolean) => void;
    phases: string[];
    /** The scope's keys and names; each rule's editor adds the rule's own stages. */
    base: BuilderScope;
    schema: RendererSchema | null;
    /** The phases list's focus rule, and this phase's place in it. */
    focus: ListFocus;
    position: number;
}) {
    const { t } = useTranslation();
    const ruleFocus = useListFocus();
    const [editingName, setEditingName] = useState(name);
    const rules = phase.rules ?? [];
    const scopeName = draft.scope ?? 'challenge';
    const scopeStages = (SCOPE_STAGES as Record<ScenarioScope, readonly ScenarioStage[]>)[scopeName];
    const setRules = (next: ScenarioDraftRule[]) => onDraft(setIn(draft, ['phases', name, 'rules'], next));
    const setPhase = (next: ScenarioDraftPhase) => onDraft(setIn(draft, ['phases', name], next));
    // Every rule repeats the same three buttons: the rule's position makes each one's accessible name unique.
    const ruleActionLabel = (actionKey: string, index: number) =>
        t('app.actionOnItem', { action: t(actionKey), item: t('app.sbRuleN', { n: index + 1 }) });
    return (
        <section {...focus.row} className="rounded-lg border border-base-300 p-3 space-y-3">
            <div className="flex gap-2 items-end">
                <label className="flex flex-col text-xs gap-1 flex-1">
                    <span className="opacity-70">{t('app.sbPhaseName')}</span>
                    <input
                        type="text"
                        className={CONTROL}
                        value={editingName}
                        onChange={(e) => setEditingName(e.currentTarget.value)}
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
                    {...focus.remove}
                    disabled={phases.length <= 1}
                    aria-label={t('app.actionOnItem', { action: t('app.sbRemovePhase'), item: name })}
                    onClick={() => {
                        focus.afterRemove(position);
                        onDraft(removePhase(draft, name));
                    }}
                >
                    {t('app.sbRemovePhase')}
                </button>
            </div>
            <PhaseSettings phase={phase} onPhase={setPhase} catalogue={base} schema={schema} />
            <PhaseBindings
                phase={phase}
                onPhase={setPhase}
                catalogue={base}
                schema={schema}
                ruleStages={defaultStages(scopeName)}
            />
            {scopeName === 'challenge' && (
                <PhaseHoldings
                    phase={phase}
                    onPhase={setPhase}
                    onBindPool={(pool) => onUpdate((current) => bindPhotoPool(current, name, pool))}
                    onPoolPending={(pending) => onPoolPending(name, pending)}
                    catalogue={base}
                    ruleStages={defaultStages(scopeName)}
                />
            )}
            {scopeName === 'installation' && (
                <p className="text-xs text-base-content/70">{t('app.sbInstallationNote')}</p>
            )}
            <div className="text-xs font-medium">{t('app.sbRules')}</div>
            {rules.map((rule, index) => (
                <RuleEditor
                    key={rule.id}
                    rowMarks={ruleFocus.row}
                    rule={rule}
                    phases={phases}
                    scope={{ ...base, stages: stagesOf(rule, scopeName) }}
                    scopeStages={scopeStages}
                    onChange={(next) => setRules(rules.map((old, i) => (i === index ? next : old)))}
                    controls={
                        <div className="flex gap-1">
                            <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={index === 0}
                                aria-label={ruleActionLabel('app.sbMoveUp', index)}
                                onClick={() => setRules(moveItem(rules, index, -1))}
                            >
                                {t('app.sbMoveUp')}
                            </button>
                            <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={index === rules.length - 1}
                                aria-label={ruleActionLabel('app.sbMoveDown', index)}
                                onClick={() => setRules(moveItem(rules, index, 1))}
                            >
                                {t('app.sbMoveDown')}
                            </button>
                            <button
                                type="button"
                                className="btn btn-sm btn-ghost text-error"
                                {...ruleFocus.remove}
                                aria-label={ruleActionLabel('app.sbRemove', index)}
                                onClick={() => {
                                    ruleFocus.afterRemove(index);
                                    setRules(rules.filter((_, i) => i !== index));
                                }}
                            >
                                {t('app.sbRemove')}
                            </button>
                        </div>
                    }
                />
            ))}
            <button
                type="button"
                className="btn btn-sm"
                {...ruleFocus.add}
                onClick={() => {
                    ruleFocus.afterAdd(rules.length);
                    setRules([...rules, newRule(draft, name)]);
                }}
            >
                {t('app.sbAddRule')}
            </button>
        </section>
    );
}

/**
 * The scenario's name, scope, description, start phase and spending limits.
 */
function ScenarioHeader({
    draft,
    onDraft,
    phases,
}: {
    draft: ScenarioDraft;
    onDraft: (next: ScenarioDraft) => void;
    phases: string[];
}) {
    const { t } = useTranslation();
    return (
        <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col text-xs gap-1">
                <span className="opacity-70">{t('app.sbName')}</span>
                <input
                    type="text"
                    className={CONTROL}
                    value={draft.name}
                    onChange={(e) => onDraft({ ...draft, name: e.currentTarget.value })}
                />
            </label>
            <label className="flex flex-col text-xs gap-1">
                <span className="opacity-70">{t('app.sbScope')}</span>
                <select
                    className="select select-sm"
                    value={draft.scope ?? 'challenge'}
                    onChange={(e) =>
                        onDraft(
                            setIn(
                                draft,
                                ['scope'],
                                e.currentTarget.value === 'challenge' ? undefined : e.currentTarget.value,
                            ),
                        )
                    }
                >
                    <option value="challenge">{t('app.sbScope_challenge')}</option>
                    <option value="installation">{t('app.sbScope_installation')}</option>
                </select>
            </label>
            <label className="flex flex-col text-xs gap-1">
                <span className="opacity-70">{t('app.sbStart')}</span>
                <select
                    className="select select-sm"
                    value={draft.start}
                    onChange={(e) => onDraft({ ...draft, start: e.currentTarget.value })}
                >
                    {phases.map((phase) => (
                        <option key={phase} value={phase}>
                            {phase}
                        </option>
                    ))}
                </select>
            </label>
            <label className="flex flex-col text-xs gap-1 sm:col-span-2">
                <span className="opacity-70">{t('app.sbDescription')}</span>
                <input
                    type="text"
                    className={CONTROL}
                    value={draft.description ?? ''}
                    onChange={(e) => onDraft(setIn(draft, ['description'], e.currentTarget.value || undefined))}
                />
            </label>
            <fieldset className="sm:col-span-2 text-xs">
                <legend className="opacity-70 mb-1">{t('app.sbLimits')}</legend>
                <div className="flex flex-wrap gap-2">
                    {LIMIT_KEYS.map((key) => (
                        <label key={key} className="flex flex-col gap-1">
                            <span>{t(`app.sbCurrency_${key}`)}</span>
                            <input
                                type="number"
                                min={0}
                                className="input input-sm w-24"
                                value={draft.limits?.[key] ?? ''}
                                onChange={(e) => {
                                    const input = e.currentTarget;
                                    onDraft(
                                        setIn(
                                            draft,
                                            ['limits', key],
                                            input.value === '' ? undefined : Number(input.value),
                                        ),
                                    );
                                }}
                            />
                        </label>
                    ))}
                </div>
            </fieldset>
        </div>
    );
}

/**
 * The draft as editable JSON text. Text that is not a document the forms can render never reaches the draft, so
 * `onTextDirty` reports whether the text differs from the draft's own JSON (false once the tab closes).
 */
function JsonTab({
    draft,
    onDraft,
    onTextDirty,
}: {
    draft: ScenarioDraft;
    onDraft: (next: ScenarioDraft) => void;
    onTextDirty: (dirty: boolean) => void;
}) {
    const { t } = useTranslation();
    const [text, setText] = useState(() => JSON.stringify(draft, null, 2));
    const [invalid, setInvalid] = useState(false);
    const textDirty = text !== JSON.stringify(draft, null, 2);
    useEffect(() => onTextDirty(textDirty), [textDirty, onTextDirty]);
    useEffect(() => () => onTextDirty(false), [onTextDirty]);
    return (
        <div className="space-y-2">
            <p className="text-xs text-base-content/70">{t('app.sbJsonHint')}</p>
            <textarea
                className="textarea w-full font-mono text-xs"
                rows={16}
                spellcheck={false}
                autoCapitalize="off"
                aria-label={t('app.sbTabJson')}
                value={text}
                onChange={(e) => {
                    const textarea = e.currentTarget;
                    setText(textarea.value);
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(textarea.value);
                    } catch {
                        parsed = undefined;
                    }
                    // Only a document the forms can render becomes the draft.
                    const editable = isEditableDraft(parsed);
                    if (editable) onDraft(parsed as ScenarioDraft);
                    setInvalid(!editable);
                }}
            />
            {invalid && (
                <ToneNote tone="warning" role="status" className="text-xs">
                    {t('app.sbJsonInvalid')}
                </ToneNote>
            )}
        </div>
    );
}

/**
 * The capability catalogue: every configuration key, its class, whether a scenario may read or change it, and the
 * plain reason when only the user may. A read that failed shows that, never an empty catalogue.
 */
function CatalogueTab() {
    const { t } = useTranslation();
    const { rows } = useScenarioCapabilities();
    const grouped = useMemo(() => {
        const by: Record<string, typeof rows> = {};
        for (const row of rows) (by[row.disposition] ??= []).push(row);
        return by;
    }, [rows]);
    if (rows.length === 0) return <p className="text-xs text-base-content/70">{t('app.sbCatalogueFailed')}</p>;
    return (
        <div className="space-y-3">
            <p className="text-xs text-base-content/70">{t('app.sbCatalogueHint')}</p>
            {Object.entries(grouped).map(([disposition, list]) => (
                <section key={disposition} className="rounded border border-base-300 p-2">
                    <h6 className="text-xs font-medium mb-1">{t(`app.sbClass_${disposition}`)}</h6>
                    <ul className="space-y-1">
                        {list.map((row) => (
                            <li key={row.key} className="text-xs text-base-content/80">
                                <span className="font-medium">
                                    {t(`app.${row.key}`) === `app.${row.key}` ? row.key : t(`app.${row.key}`)}
                                </span>
                                {' — '}
                                {t(row.read === 'value' ? 'app.sbRead_value' : 'app.sbRead_projection')}
                                {', '}
                                {row.phaseWrite.length > 0
                                    ? t('app.sbWriteIn', {
                                          stages: row.phaseWrite
                                              .map((scope) =>
                                                  scope === 'challenge'
                                                      ? t('app.sbScope_challenge')
                                                      : t('app.sbScope_installation'),
                                              )
                                              .join(', '),
                                      })
                                    : restrictionText(row.restriction, t)}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

/** The wording of an operation a request names; an operation the app has no name for is "a request". */
const operationText = (operation: string, t: ReturnType<typeof useTranslation>['t']): string =>
    (SIMULATION_OPERATIONS as readonly string[]).includes(operation)
        ? t(`app.sbAssumed_${operation}`)
        : t('app.sbOperationOther');

/** One event of the timeline in plain words: a rule that ran, a request and its outcome, a phase change, a notice. */
const eventText = (event: SimulationResult['events'][number], t: ReturnType<typeof useTranslation>['t']): string => {
    switch (event.type) {
        case 'rule':
            return `[${event.phase}] ${event.ruleId}`;
        case 'operation':
            return t('app.sbEventOperation', {
                operation: operationText(event.operation, t),
                outcome: t(`app.sbOutcome_${event.outcome}`),
            });
        case 'phase':
            return t('app.sbToPhase', { phase: event.to });
        case 'published':
            return `[${event.phase}]`;
        case 'notice':
            // A notice is shown as it was written: it is the scenario's own text.
            return event.message;
        case 'preview':
            // Where the run would look next: shown, never applied.
            return t('app.sbEventPreview');
    }
};

/** Why a run halted, in plain words: the reasons the app knows by name, else that it could not go on. */
const haltedText = (halted: string, t: ReturnType<typeof useTranslation>['t']): string => {
    if (halted === 'timezone-unavailable') return t('app.sbHalted_timezone');
    if (halted === 'simulation-isolation-breached') return t('app.sbHalted_isolation');
    return t('app.sbHalted_other');
};

/** The place a diagnostic value came from, in plain words. */
const PROVENANCE_KEYS: Record<string, string> = {
    draft: 'draft',
    'saved scenario': 'saved',
    installation: 'installation',
    'open-list': 'open',
    'active-list': 'active',
    'completed-list': 'completed',
    'installation setting': 'setting',
    'assumed: the challenge ran under this scenario from its start phase': 'assumedStart',
    'clock when the request was made': 'clock',
    request: 'request',
    'account read before the run': 'account',
    'read failed; not assumed': 'readFailed',
};
const DIAGNOSTIC_KEYS = ['scenario', 'subject', 'timezone', 'progress', 'start', 'until', 'bankroll'] as const;

/** One value the run used: what it is, its value and where it came from, in plain words. */
const diagnosticText = (
    diagnostic: SimulationResult['diagnostics'][number],
    t: ReturnType<typeof useTranslation>['t'],
): string => {
    const known = (DIAGNOSTIC_KEYS as readonly string[]).includes(diagnostic.key);
    const timeValue =
        (diagnostic.key === 'start' || diagnostic.key === 'until') && typeof diagnostic.value === 'number';
    let value = String(diagnostic.value);
    if (timeValue) value = new Date((diagnostic.value as number) * 1000).toLocaleString();
    else if (diagnostic.key === 'subject' && diagnostic.value === 'installation') value = t('app.sbStage_account');
    else if (diagnostic.key === 'bankroll')
        value = t(diagnostic.value === 'read' ? 'app.sbDiagValue_read' : 'app.sbDiagValue_unknown');
    const from = Object.hasOwn(PROVENANCE_KEYS, diagnostic.provenance)
        ? t(`app.sbDiagFrom_${PROVENANCE_KEYS[diagnostic.provenance]}`)
        : t('app.sbDiagFrom_other');
    return `${known ? t(`app.sbDiagKey_${diagnostic.key}`) : t('app.sbDiagKey_other')}: ${value} (${from})`;
};

/** A resolved deadline in words: which photo count is due when, a voting or pause window, the publication's own end. */
const deadlineText = (
    deadline: SimulationResult['deadlines'][number],
    t: ReturnType<typeof useTranslation>['t'],
): string => {
    const when = (at: number | null) =>
        at === null ? t('app.sbDeadlineUnknown') : new Date(at * 1000).toLocaleString();
    switch (deadline.kind) {
        case 'submit':
            return t('app.sbDeadline_submit', { count: deadline.count, at: when(deadline.at) });
        case 'vote':
        case 'pause':
            return t(`app.sbDeadline_${deadline.kind}`, { from: when(deadline.start), to: when(deadline.end) });
        case 'publication':
            return t('app.sbDeadline_publication', { at: when(deadline.validUntil) });
    }
};

/**
 * A what-if run of the draft: on which subject, to which horizon, with which assumed outcomes.
 */
function SimulatePanel({ draft }: { draft: ScenarioDraft }) {
    const { t } = useTranslation();
    const scope = draft.scope ?? 'challenge';
    const kinds: readonly ('installation' | 'candidate' | 'active' | 'completed')[] =
        scope === 'installation' ? ['installation'] : ['candidate', 'active', 'completed'];
    const [pickedKind, setKind] = useState<'installation' | 'candidate' | 'active' | 'completed'>(kinds[0]);
    const kind = kinds.includes(pickedKind) ? pickedKind : kinds[0];
    const [challengeId, setChallengeId] = useState('');
    const [untilText, setUntilText] = useState('');
    const [assumed, setAssumed] = useState<Partial<Record<(typeof SIMULATION_OPERATIONS)[number], SimulationOutcome>>>(
        {},
    );
    const [result, setResult] = useState<SimulationResult | null>(null);
    const [error, setError] = useState<ScenarioErrorInfo | null>(null);
    const listing = useSimulationSubjects(kind === 'installation' ? 'active' : kind, kind !== 'installation');

    // A datetime-local input answers a date-time or the empty string; anything that is not a finite time is no horizon.
    const untilOf = (text: string): number => Math.floor(new Date(text).getTime() / 1000);
    const subjects = listing.subjects;
    // The inputs a run needs: a horizon still ahead, and (for a challenge) one that the current list holds.
    const inputsAreValid = (): boolean => {
        const horizon = untilOf(untilText);
        const ahead = Number.isFinite(horizon) && horizon > Date.now() / 1000;
        return ahead && (kind === 'installation' || (subjects ?? []).some((subject) => subject.id === challengeId));
    };
    const horizonPast = untilText !== '' && !(untilOf(untilText) > Date.now() / 1000);
    const valid = inputsAreValid();

    const run = async () => {
        // The button is off for invalid inputs; the run checks them again, as the list or the clock may have moved.
        if (!inputsAreValid()) return;
        const outcomes = Object.fromEntries(
            SIMULATION_OPERATIONS.filter((operation) => assumed[operation] !== undefined).map((operation) => [
                operation,
                assumed[operation],
            ]),
        );
        const response = await ipc.callOrNull(() =>
            ipc.simulateScenario({
                scenario: { draft },
                subject:
                    kind === 'installation'
                        ? { kind: 'installation' }
                        : { kind: kind as 'candidate' | 'active' | 'completed', challengeId },
                until: untilOf(untilText),
                ...(Object.keys(outcomes).length === 0 ? {} : { assumptions: { outcomes } }),
            }),
        );
        if (response?.success) {
            setResult(response);
            setError(null);
        } else if (response && 'error' in response && response.error === 'challenge-data-incomplete') {
            // A marked challenge refuses the preview: nothing is wrong with the scenario, so the refusal words its
            // own next step.
            setResult(null);
            setError({ what: 'app.sbSimulateDataIncomplete', next: 'app.scenarioErrorNextRefresh' });
        } else {
            setResult(null);
            setError({
                what: 'app.sbSimulateFailed',
                issues: failureIssuesOf(response),
            });
        }
    };

    return (
        <div className="space-y-2">
            <div className="text-xs font-medium">{t('app.sbSimulateTitle')}</div>
            <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col text-xs gap-1">
                    <span className="opacity-70">{t('app.sbSimulateKind')}</span>
                    <select
                        className="select select-sm"
                        value={kind}
                        onChange={(e) => {
                            setKind(e.currentTarget.value as (typeof kinds)[number]);
                            setChallengeId('');
                        }}
                    >
                        {kinds.map((name) => (
                            <option key={name} value={name}>
                                {t(name === 'installation' ? 'app.sbStage_account' : `app.sbSubject_${name}`)}
                            </option>
                        ))}
                    </select>
                </label>
                {kind !== 'installation' && (subjects === null || subjects.length > 0) && (
                    <label className="flex flex-col text-xs gap-1">
                        <span className="opacity-70">{t('app.sbSimulateOn')}</span>
                        <select
                            className="select select-sm"
                            value={challengeId}
                            onChange={(e) => setChallengeId(e.currentTarget.value)}
                            disabled={listing.failed}
                        >
                            <option value="">{t('app.sbSimulatePick')}</option>
                            {(subjects ?? []).map((subject) => (
                                <option key={subject.id} value={subject.id}>
                                    {subject.label}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                <label className="flex flex-col text-xs gap-1">
                    <span className="opacity-70">{t('app.sbSimulateUntil')}</span>
                    <input
                        type="datetime-local"
                        className="input input-sm"
                        value={untilText}
                        onChange={(e) => setUntilText(e.currentTarget.value)}
                    />
                </label>
            </div>
            {horizonPast && (
                <ToneNote tone="warning" role="status" className="text-xs">
                    {scenarioRefusalText('until-in-past', t)}
                </ToneNote>
            )}
            {kind !== 'installation' && listing.failed && (
                <div className="text-xs space-y-1">
                    <ToneNote tone="warning" role="status">
                        {t('app.sbSubjectsFailed')}
                    </ToneNote>
                    <button type="button" className="btn btn-sm" onClick={listing.retry}>
                        {t('app.sbSubjectsRetry')}
                    </button>
                </div>
            )}
            {kind !== 'installation' && subjects !== null && subjects.length === 0 && (
                <p className="text-xs text-base-content/70">{t('app.sbNoSubjects')}</p>
            )}
            <fieldset className="text-xs">
                <legend className="opacity-70 mb-1">{t('app.sbAssumptions')}</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                    {SIMULATION_OPERATIONS.map((operation) => (
                        <label key={operation} className="flex items-center gap-2">
                            <span className="flex-1">{t(`app.sbAssumed_${operation}`)}</span>
                            <select
                                className="select select-sm"
                                aria-label={t(`app.sbAssume_${operation}`)}
                                value={assumed[operation] ?? ''}
                                onChange={(e) =>
                                    setAssumed({
                                        ...assumed,
                                        [operation]:
                                            e.currentTarget.value === ''
                                                ? undefined
                                                : (e.currentTarget.value as SimulationOutcome),
                                    })
                                }
                            >
                                <option value="">{t('app.sbAssume_none')}</option>
                                {SIMULATION_OUTCOMES.map((outcome) => (
                                    <option key={outcome} value={outcome}>
                                        {t(`app.sbOutcome_${outcome}`)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ))}
                </div>
            </fieldset>
            <button type="button" className="btn btn-sm" disabled={!valid} onClick={() => void run()}>
                {t('app.sbSimulate')}
            </button>
            <ScenarioError error={error} />
            {result && (
                <div className="text-xs bg-base-200 rounded p-2 space-y-1">
                    {result.manualOnly && <ToneNote tone="warning">{t('app.sbSimulatePausedManual')}</ToneNote>}
                    {result.events.length === 0 ? (
                        <p>{t('app.sbSimulateNothing')}</p>
                    ) : (
                        <ol className="space-y-0.5">
                            {result.events.map((event, index) => (
                                <li key={`${event.at}:${event.type}:${index}`}>
                                    <span className="font-mono">{new Date(event.at * 1000).toLocaleString()}</span> ·{' '}
                                    {eventText(event, t)}
                                    {event.applied ? null : ` (${t('app.sbEventNotRun')})`}
                                </li>
                            ))}
                        </ol>
                    )}
                    {result.deadlines.length > 0 && (
                        <div className="space-y-0.5">
                            <div className="font-medium">{t('app.sbDeadlines')}</div>
                            <ul className="list-disc ml-4">
                                {result.deadlines.map((deadline, index) => (
                                    <li key={index}>{deadlineText(deadline, t)}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {result.needs !== null && (
                        <p>{t('app.sbNeeds', { operation: t(`app.sbAssumed_${result.needs.operation}`) })}</p>
                    )}
                    {result.diagnostics.length > 0 && (
                        <div className="space-y-0.5">
                            <div className="font-medium">{t('app.sbDiagnostics')}</div>
                            <ul className="list-disc ml-4">
                                {result.diagnostics.map((diagnostic, index) => (
                                    <li key={index}>{diagnosticText(diagnostic, t)}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {(() => {
                        // The assumed answers the run carried, as one line of plain text.
                        const echoes = SIMULATION_OPERATIONS.flatMap((operation) => {
                            const outcome = result.assumptions?.outcomes?.[operation];
                            return outcome === undefined
                                ? []
                                : [
                                      t('app.sbAssumedAs', {
                                          operation: t(`app.sbAssumed_${operation}`),
                                          outcome: t(`app.sbOutcome_${outcome}`),
                                      }),
                                  ];
                        });
                        return echoes.length > 0 ? (
                            <p>
                                {t('app.sbAssumedList')} {echoes.join(', ')}
                            </p>
                        ) : null;
                    })()}
                    <p>{t(`app.sbStop_${result.stopReason}`)}</p>
                    {result.halted && <ToneNote tone="warning">{haltedText(result.halted, t)}</ToneNote>}
                </div>
            )}
        </div>
    );
}

/**
 * @param props
 *   originalName: the stored name being edited, or null for a new scenario
 *   revision: the revision of the stored scenarios when the builder opened; an overwrite states it
 *   onDirtyChange: told whether the draft (or the JSON tab's text) differs from what was opened; false when it closes
 */
export function ScenarioBuilder({
    initial,
    originalName,
    revision,
    onSaved,
    onRenamed,
    onCancel,
    onDirtyChange,
    onBusyChange,
}: {
    initial: ScenarioDraft;
    originalName: string | null;
    revision: number | null;
    onSaved: () => void;
    /** Told when a rename landed (even when the save after it failed), so the list can show the new name. */
    onRenamed?: (newName: string) => void;
    onCancel: () => void;
    onDirtyChange: (dirty: boolean) => void;
    /** Told whether a save is running (its answer is not final): whoever holds this builder must not close it or save around it. */
    onBusyChange?: (busy: boolean) => void;
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(initial);
    const [baseline] = useState(initial);
    // The collection as it was when the builder opened: a save over it is refused if another editor changed it since.
    const [loadedRevision, setLoadedRevision] = useState(revision);
    const [jsonDirty, setJsonDirty] = useState(false);
    const dirty = jsonDirty || !valuesEqual(draft, baseline);
    const report = useLatestRef(onDirtyChange);
    useEffect(() => report.current(dirty), [dirty, report]);
    useEffect(() => () => report.current(false), [report]);
    // The name the scenario is stored under right now: a rename that went through before a refused save must not be
    // attempted again on retry.
    const [storedName, setStoredName] = useState(originalName);
    const [tab, setTab] = useState<(typeof TABS)[number]>('builder');
    const idBase = useId();
    const tabId = (name: string) => `${idBase}-tab-${name}`;
    const panelId = `${idBase}-panel`;
    // WAI-ARIA tabs: the tab that takes focus is the selected one.
    const onTabKeyDown = (event: TargetedKeyboardEvent<HTMLButtonElement>, index: number) => {
        const next = tabAfterKey(event.key, index);
        if (next === null) return;
        event.preventDefault();
        setTab(TABS[next]);
        document.getElementById(tabId(TABS[next]))?.focus();
    };
    const [error, setError] = useState<ScenarioErrorInfo | null>(null);
    const phases = Object.keys(draft.phases);
    const phaseFocus = useListFocus();
    const scope = draft.scope ?? 'challenge';
    // A failed schema read sends an empty `{}` schema, which is a (keyless) RendererSchema too.
    const { schema } = useSettingsSchema();
    const capabilities = useScenarioCapabilities();
    const { scenarios: stored } = useScenarios();
    const profiles = usePhaseProfiles();
    const base = useMemo<BuilderScope>(
        () => ({
            scope,
            stages: defaultStages(scope),
            writableKeys: capabilities.writableKeys(scope),
            readableKeys: capabilities.readableKeys,
            descriptors: capabilities.descriptors,
            // A handoff keeps the subject's kind, so only scenarios of this scenario's own scope are offered.
            scenarios: Object.keys(stored).filter(
                (name) => ((stored[name] as { scope?: string } | undefined)?.scope ?? 'challenge') === scope,
            ),
            // The host says which profiles a phase may apply (the runner's own check), so no profile is offered that it refuses.
            profiles,
        }),
        [capabilities, scope, stored, profiles],
    );

    // The name a rename already landed on while the save after it failed: the user must see both facts.
    const [renamedNotSaved, setRenamedNotSaved] = useState<string | null>(null);
    // The collection kept the rename: the scenario is stored under its new name, one change further on.
    const renameLanded = (name: string) => {
        setStoredName(name);
        setLoadedRevision((value) => (value === null ? null : value + 1));
        // The list shows the new name, whatever the save after it does.
        onRenamed?.(name);
    };
    const rename = useAsyncIpcAction(
        ipc.renameScenario,
        { failureMessage: 'not-saved' },
        {
            // The reply was lost but the rename went through: what is left is the save, under the name the rename was sent with.
            onApplied: ([, to]) => {
                renameLanded(to);
                setRenamedNotSaved(to);
            },
        },
    );
    const saveAction = useAsyncIpcAction(
        ipc.saveScenario,
        { failureMessage: 'not-saved' },
        {
            onApplied: () => {
                // The reply was lost but the save went through.
                setRenamedNotSaved(null);
                onSaved();
            },
        },
    );
    // One save at a time, from the validation read until the result is confirmed or failed. `inFlight` is taken before anything is
    // awaited, so a second call that comes before the page has drawn the first one's busy state is turned away too.
    const inFlight = useRef(false);
    const [validating, setValidating] = useState(false);
    const writing =
        validating || rename.loading || saveAction.loading || rename.outcome !== null || saveAction.outcome !== null;
    // A pool create with no final answer may still bind into the draft: Save waits for it (or for it to be dismissed).
    const [poolPending, setPoolPending] = useState<Record<string, boolean>>({});
    const setPhasePoolPending = (phase: string, pending: boolean) =>
        setPoolPending((held) => (held[phase] === pending ? held : { ...held, [phase]: pending }));
    const saveBlocked = writing || Object.values(poolPending).some(Boolean);
    // Whether this builder is still on the page: a save that started in it does not go on after it is gone.
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const reportBusy = useLatestRef(onBusyChange);
    useEffect(() => reportBusy.current?.(writing), [writing, reportBusy]);
    useEffect(() => () => reportBusy.current?.(false), [reportBusy]);

    const save = async () => {
        if (inFlight.current || saveBlocked) return;
        inFlight.current = true;
        setValidating(true);
        try {
            await runSave();
        } finally {
            inFlight.current = false;
            setValidating(false);
        }
    };

    const runSave = async () => {
        setError(null);
        // Validate before anything is renamed, so a draft with problems changes nothing.
        const checked = await ipc.callOrNull(() => ipc.checkScenario(draft));
        if (!mounted.current) return;
        if (!checked?.success) {
            setError({
                what: 'app.sbSaveFailed',
                issues: failureIssuesOf(checked),
            });
            return;
        }
        const renamed = storedName !== null && storedName.toLowerCase() !== String(draft.name).toLowerCase();
        let expectedDefinitionRevision = loadedRevision ?? undefined;
        if (renamed) {
            const moved = await rename.run(storedName, draft.name, { expectedDefinitionRevision });
            if (!mounted.current) return;
            // Not final: the notice checks it, and the save waits for that answer.
            if (ipc.effectOutcomeOf(moved) !== null) return;
            if (!moved.success) {
                setError({ what: 'app.sbSaveFailed', issues: failureIssuesOf(moved) });
                return;
            }
            setRenamedNotSaved(null);
            renameLanded(moved.name);
            // The rename advanced the collection by one change: what follows (a retry too) expects exactly that.
            if (expectedDefinitionRevision !== undefined) expectedDefinitionRevision += 1;
        }
        const result = await saveAction.run(draft, { overwrite: storedName !== null, expectedDefinitionRevision });
        if (!mounted.current) return;
        if (ipc.effectOutcomeOf(result) !== null) {
            // The rename (if one ran in this save) is already in the collection; the save waits for its check.
            if (renamed) setRenamedNotSaved(draft.name);
            return;
        }
        if (result.success) {
            setRenamedNotSaved(null);
            onSaved();
        } else {
            // The rename (if one ran in this save) is already in the collection; only the rest is lost.
            if (renamed) setRenamedNotSaved(draft.name);
            // A refusal of the lifecycle gate carries its reason code instead of validator issues: it words itself.
            setError({ what: 'app.sbSaveFailed', issues: failureIssuesOf(result) });
        }
    };
    // A check that found the change refused after all (not applied) reads like any other refusal.
    const heldFailure = rename.error ?? saveAction.error;
    const shownError: ScenarioErrorInfo | null =
        error ??
        (heldFailure === null ? null : { what: 'app.sbSaveFailed', issues: failureIssuesOf({ error: heldFailure }) });

    return (
        <div className="border border-base-300 rounded-lg p-3 space-y-3">
            <h5 className="font-semibold">{t(originalName === null ? 'app.sbTitleNew' : 'app.sbTitleEdit')}</h5>
            {/* While a save runs the draft cannot change under it: everything it holds is off until the result is final. */}
            <fieldset className="min-w-0 border-0 p-0 m-0 space-y-3" disabled={writing} aria-busy={writing}>
                <div role="tablist" className="tabs tabs-border">
                    {TABS.map((name, index) => (
                        <button
                            key={name}
                            id={tabId(name)}
                            type="button"
                            role="tab"
                            aria-selected={tab === name}
                            aria-controls={tab === name ? panelId : undefined}
                            tabIndex={tab === name ? 0 : -1}
                            className={`tab ${tab === name ? 'tab-active' : ''}`}
                            onClick={() => setTab(name)}
                            onKeyDown={(event) => onTabKeyDown(event, index)}
                        >
                            {t(
                                name === 'builder'
                                    ? 'app.sbTabBuilder'
                                    : name === 'json'
                                      ? 'app.sbTabJson'
                                      : 'app.sbTabKeys',
                            )}
                        </button>
                    ))}
                </div>
                <div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
                    {tab === 'json' ? (
                        <JsonTab draft={draft} onDraft={setDraft} onTextDirty={setJsonDirty} />
                    ) : tab === 'keys' ? (
                        <CatalogueTab />
                    ) : (
                        <div className="space-y-3">
                            <ScenarioHeader draft={draft} onDraft={setDraft} phases={phases} />
                            <div className="text-sm font-medium">{t('app.sbPhases')}</div>
                            {phases.map((name, position) => (
                                <PhaseEditor
                                    key={name}
                                    focus={phaseFocus}
                                    position={position}
                                    name={name}
                                    phase={draft.phases[name]}
                                    draft={draft}
                                    onDraft={setDraft}
                                    onUpdate={setDraft}
                                    onPoolPending={setPhasePoolPending}
                                    phases={phases}
                                    base={base}
                                    schema={schema}
                                />
                            ))}
                            <button
                                type="button"
                                className="btn btn-sm"
                                {...phaseFocus.add}
                                onClick={() => {
                                    phaseFocus.afterAdd(phases.length);
                                    setDraft(addPhase(draft));
                                }}
                            >
                                {t('app.sbAddPhase')}
                            </button>
                        </div>
                    )}
                </div>
                <SimulatePanel draft={draft} />
            </fieldset>
            {renamedNotSaved !== null && (
                <div className="alert alert-warning py-2 text-sm" role="status">
                    {t('app.sbRenamedNotSaved', { name: renamedNotSaved })}
                </div>
            )}
            <ScenarioError error={shownError} />
            <EffectOutcomeNotice
                outcome={rename.outcome}
                onCheck={rename.checkStatus}
                onDismiss={rename.dismissOutcome}
            />
            <EffectOutcomeNotice
                outcome={saveAction.outcome}
                onCheck={saveAction.checkStatus}
                onDismiss={saveAction.dismissOutcome}
            />
            <div className="flex gap-2">
                <button
                    type="button"
                    className="btn btn-sm btn-neutral"
                    disabled={saveBlocked}
                    aria-busy={writing}
                    onClick={() => void save()}
                >
                    <BusyContent busy={validating || rename.loading || saveAction.loading} label={t('app.sbSave')} />
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={writing} onClick={onCancel}>
                    {t('app.cancel')}
                </button>
            </div>
        </div>
    );
}
