import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { SETTINGS_SECTION_TITLES } from '@/contexts/SettingsNavContext';
import { ToneNote } from '@/components/ui/ToneNote';
import { useScenarios } from '@/api/useScenarios';
import {
    useInstallationScenario,
    useSetInstallationScenario,
    useTransferInstallationOwner,
} from '@/api/useInstallationScenario';
import { EffectOutcomeNotice } from '@/components/ui/EffectOutcomeNotice';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import * as ipc from '@/api/ipc';
import { ScenarioError, issuesOf, failureIssuesOf } from './ScenarioError';
import { scenarioRefusalText } from '@/utils/scenarioIssueText';
import { ipcErrorText } from '@/api/ipcErrorText';
import { ScenarioBuilder } from './scenarioBuilder/ScenarioBuilder';
import { SettingsSectionPanel } from './SettingsSectionPanel';
import { newScenario } from '../../../core/scenarios/builderModel';
import { platformKind } from '../../../core/platform/kind';

import type { WindowApi } from '../../../core/types/ipc';
import type { ScenarioDraft } from '../../../core/types/scenarioBuilder';
import type { ScenarioDocument } from '../../../core/settings/scenarioSchema';
import type { ScenarioErrorInfo } from './ScenarioError';

/**
 * A successful preview-scenario-import: the parsed scenario, what it does and
 * whether importing it would replace a stored one.
 */
type ImportPreviewResult = Extract<Awaited<ReturnType<WindowApi['previewScenarioImport']>>, { success: true }>;

// How long an armed delete stays armed before it disarms itself.
const CONFIRM_TIMEOUT_MS = 4000;

/**
 * What a scenario does before it is imported: its phases, spends and limits.
 */
function ImportPreview({ preview }: { preview: ImportPreviewResult['preview'] }) {
    const { t } = useTranslation();
    const limits = Object.entries(preview.limits);
    return (
        <div className="text-xs bg-base-200 rounded p-2 space-y-1">
            <div className="font-medium">
                {preview.name} — {t('app.scenarioStartsIn', { phase: preview.start })}
            </div>
            {preview.description && <p className="text-base-content/70">{preview.description}</p>}
            <ul className="list-disc ml-4">
                {preview.phases.map((phase) => (
                    <li key={phase.name}>
                        {t('app.scenarioPhaseSummary', { phase: phase.name, count: phase.rules })}
                        {phase.settings.length > 0 && ` (${phase.settings.map((key) => t(`app.${key}`)).join(', ')})`}
                    </li>
                ))}
            </ul>
            <div>
                {preview.spending.length > 0
                    ? t('app.scenarioSpends', {
                          actions: preview.spending
                              .map((spend) => `${t(`app.sbAct_${spend.action}`)} (${spend.rule})`)
                              .join(', '),
                      })
                    : t('app.scenarioSpendsNothing')}
            </div>
            {preview.flagged.length > 0 && (
                <ToneNote tone="warning" as="div">
                    {t('app.scenarioFlagged', {
                        settings: preview.flagged
                            .map(
                                (item) =>
                                    `${t(`app.${item.key}`)} (${t('app.scenarioStatusPhase', { phase: item.phase })})`,
                            )
                            .join(', '),
                    })}
                </ToneNote>
            )}
            <div>
                {limits.length > 0
                    ? t('app.scenarioLimits', {
                          limits: limits.map(([key, n]) => `${n} ${t(`app.sbCurrency_${key}`)}`).join(', '),
                      })
                    : t('app.scenarioNoLimits')}
            </div>
        </div>
    );
}

/**
 * Paste shared scenario JSON, see what it does, then import it.
 */
function ImportPanel({
    revision,
    onDone,
    onCancel,
}: {
    revision: number | null;
    onDone: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    // The collection as it was when the panel opened: an overwrite is refused if another editor changed it since.
    const [loadedRevision] = useState(revision);
    const [text, setText] = useState('');
    const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
    const [overwrite, setOverwrite] = useState(false);
    const [error, setError] = useState<ScenarioErrorInfo | null>(null);

    const runPreview = async () => {
        setError(null);
        const result = await ipc.callOrNull(() => ipc.previewScenarioImport(text));
        if (result?.success) {
            setPreview(result);
        } else {
            setPreview(null);
            setError({
                what: 'app.scenarioImportInvalid',
                issues: issuesOf(result),
            });
        }
    };

    const runImport = async () => {
        const result = await ipc.callOrNull(() =>
            ipc.importScenario(text, { overwrite, expectedDefinitionRevision: loadedRevision ?? undefined }),
        );
        if (result?.success) onDone();
        else
            setError({
                what: 'app.scenarioImportFailed',
                issues: failureIssuesOf(result),
            });
    };

    return (
        <div className="border border-base-300 rounded p-2 space-y-2">
            <label className="text-xs font-medium block" htmlFor="scenario-import-text">
                {t('app.scenarioImportLabel')}
            </label>
            <textarea
                id="scenario-import-text"
                className="textarea w-full font-mono text-xs"
                rows={6}
                spellcheck={false}
                autoCapitalize="off"
                value={text}
                onChange={(e) => {
                    setText(e.currentTarget.value);
                    setPreview(null);
                }}
            />
            <ScenarioError error={error} />
            {preview && <ImportPreview preview={preview.preview} />}
            {preview?.exists && (
                <label className="label cursor-pointer justify-start gap-2 text-xs">
                    <input
                        type="checkbox"
                        className="checkbox checkbox-sm"
                        checked={overwrite}
                        onChange={(e) => setOverwrite(e.currentTarget.checked)}
                    />
                    {t('app.scenarioOverwrite', { name: preview.preview.name })}
                </label>
            )}
            <div className="flex gap-2">
                <button type="button" className="btn btn-sm" onClick={() => void runPreview()} disabled={!text.trim()}>
                    {t('app.scenarioPreview')}
                </button>
                <button
                    type="button"
                    className="btn btn-sm btn-neutral"
                    onClick={() => void runImport()}
                    disabled={!preview || (preview.exists && !overwrite)}
                >
                    {t('app.scenarioImportConfirm')}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
                    {t('app.cancel')}
                </button>
            </div>
        </div>
    );
}

/**
 * An exported scenario's JSON, and the settings the export left out (they belong to this account).
 */
type ExportedText = { json: string; omitted: string[] };

/**
 * The export panel of a scenario row: the JSON to copy and what was left out of it.
 */
function ExportedScenario({ name, exported, onHide }: { name: string; exported: ExportedText; onHide: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-1">
            <p className="text-xs text-base-content/70">{t('app.scenarioExportHint')}</p>
            {exported.omitted.length > 0 && (
                <ToneNote tone="warning" className="text-xs">
                    {t('app.scenarioExportOmitted', {
                        settings: exported.omitted.map((key) => t(`app.${key}`)).join(', '),
                    })}
                </ToneNote>
            )}
            <textarea
                className="textarea w-full font-mono text-xs"
                rows={6}
                spellcheck={false}
                autoCapitalize="off"
                readOnly
                aria-label={t('app.scenarioExportLabel', { name })}
                value={exported.json}
                onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn btn-sm btn-ghost" onClick={onHide}>
                {t('app.scenarioExportClose')}
            </button>
        </div>
    );
}

/**
 * One stored scenario: export, rename and a two-step delete.
 */
function ScenarioRow({
    name,
    scenario,
    onChanged,
    onError,
    onEdit,
}: {
    name: string;
    scenario: ScenarioDocument;
    onChanged: () => void;
    onError: (error: ScenarioErrorInfo) => void;
    onEdit: () => void;
}) {
    const { t } = useTranslation();
    const [exported, setExported] = useState<ExportedText | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [armed, setArmed] = useState(false);
    // Each row repeats the same four buttons: the scenario's name makes each one's accessible name unique.
    const rowLabel = (actionKey: string) => t('app.actionOnItem', { action: t(actionKey), item: name });

    useEffect(() => {
        if (!armed) return undefined;
        const timer = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [armed]);

    const runExport = async () => {
        const result = await ipc.callOrNull(() => ipc.exportScenario(name));
        if (result?.success) setExported({ json: result.json, omitted: result.omitted });
        else onError({ what: 'app.scenarioExportFailed' });
    };

    const runRename = async (newName: string) => {
        const result = await ipc.callOrNull(() => ipc.renameScenario(name, newName));
        if (result?.success) {
            setRenaming(null);
            onChanged();
        } else {
            onError({
                what: 'app.scenarioRenameFailed',
                issues: failureIssuesOf(result),
            });
        }
    };

    const runDelete = async () => {
        if (!armed) {
            setArmed(true);
            return;
        }
        setArmed(false);
        const result = await ipc.callOrNull(() => ipc.deleteScenario(name));
        if (result?.success) onChanged();
        else onError({ what: 'app.scenarioDeleteFailed', issues: failureIssuesOf(result) });
    };

    return (
        <li className="border border-base-300 rounded p-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium flex-1 min-w-0 truncate" title={name}>
                    {name}
                </span>
                <span className="text-xs text-base-content/70">
                    {t('app.scenarioPhaseCount', { count: Object.keys(scenario.phases).length })}
                </span>
                <button type="button" className="btn btn-sm" aria-label={rowLabel('app.sbEdit')} onClick={onEdit}>
                    {t('app.sbEdit')}
                </button>
                <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={rowLabel('app.scenarioExport')}
                    onClick={() => void runExport()}
                >
                    {t('app.scenarioExport')}
                </button>
                <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={rowLabel('app.scenarioRename')}
                    onClick={() => setRenaming(name)}
                >
                    {t('app.scenarioRename')}
                </button>
                <button
                    type="button"
                    className={`btn btn-sm ${armed ? 'btn-error' : ''}`}
                    aria-label={rowLabel(armed ? 'app.scenarioDeleteConfirm' : 'app.scenarioDelete')}
                    onClick={() => void runDelete()}
                >
                    {armed ? t('app.scenarioDeleteConfirm') : t('app.scenarioDelete')}
                </button>
            </div>
            {scenario.description && <p className="text-xs text-base-content/70">{scenario.description}</p>}
            {renaming !== null && (
                <div className="flex gap-2">
                    <input
                        type="text"
                        className="input input-sm flex-1"
                        aria-label={t('app.scenarioRenameLabel')}
                        value={renaming}
                        onChange={(e) => setRenaming(e.currentTarget.value)}
                    />
                    <button type="button" className="btn btn-sm btn-neutral" onClick={() => void runRename(renaming)}>
                        {t('app.scenarioRenameSave')}
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>
                        {t('app.cancel')}
                    </button>
                </div>
            )}
            {exported !== null && <ExportedScenario name={name} exported={exported} onHide={() => setExported(null)} />}
        </li>
    );
}

/**
 * A name for a copy of `base` that no stored scenario uses yet.
 */
const freeName = (base: string, taken: string[]) => {
    const lower = new Set(taken.map((name) => name.toLowerCase()));
    let name = base;
    for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    return name;
};

/** The runtimes that may own the installation scenario, in the order the picker shows them. */
const OWNERS = ['electron', 'cli', 'web', 'android-service', 'android-app'] as const;

/**
 * The installation scenario and its owner (who runs it): the stored installation-scope scenarios to pick from, the
 * owner of this host, and the generation a change states it was made under. Changing the scenario saves the whole
 * assignment; changing only the owner hands it over — a local operation a paired phone cannot make. An answer that
 * is not final keeps its request identity (the shared notice), and a refusal says its reason in plain words.
 */
function InstallationScenarioPanel() {
    const { t } = useTranslation();
    const { scenarios } = useScenarios();
    const { installation, generation, refetch } = useInstallationScenario();
    const [name, setName] = useState<string | null>(null);
    const [owner, setOwner] = useState<string | null>(null);
    // The generation is read again after a confirmed change; until that read is back no change may be sent under the old one.
    const [reading, setReading] = useState(false);
    const reread = () => {
        setReading(true);
        void refetch().finally(() => setReading(false));
    };
    // A change that was applied (its first reply or a later check says so) is what the form stood for: the picks go, so the
    // form shows what is stored now and a later Save cannot send the old picks again.
    const resetPicks = () => {
        setName(null);
        setOwner(null);
    };
    const apply = useSetInstallationScenario({ onApplied: resetPicks });
    const transfer = useTransferInstallationOwner({ onApplied: resetPicks });
    const names = Object.keys(scenarios).filter(
        (name) => (scenarios[name] as { scope?: string } | undefined)?.scope === 'installation',
    );
    // What the form shows: the stored assignment, or the user's unsaved pick.
    const currentName = installation === null ? '' : installation.scenario;
    const shownName = name ?? currentName;
    const shownOwner = owner ?? installation?.executor ?? OWNERS[0];
    // A paired phone chooses a scenario on its computer; it never changes who runs it.
    const phone = platformKind() === 'remote';
    const ownerOnlyChange =
        !phone && installation !== null && shownName === currentName && shownOwner !== installation.executor;
    // One change at a time: while either request has no final answer (or the generation is being read again) the form is frozen as
    // it was submitted and nothing more is sent; Save also waits for a generation that was read.
    const open = apply.outcome !== null || transfer.outcome !== null;
    const busy = apply.loading || transfer.loading || open || reading;
    const unowned = phone && installation === null;

    const save = async () => {
        if (generation === null || busy || unowned) return;
        const owner = phone && installation !== null ? installation.executor : (shownOwner as (typeof OWNERS)[number]);
        const result = ownerOnlyChange
            ? await transfer.run(owner, generation)
            : await apply.run(shownName === '' ? null : shownName, owner, generation);
        // A queued or unconfirmed change keeps the form as it is; the generation is read again once it is confirmed.
        if (result?.success && ipc.effectOutcomeOf(result) === null) {
            resetPicks();
            reread();
        }
    };
    // The notice's own request: its check and its dismissal act on that request's hook, whatever the form says now.
    const checked = (check: () => Promise<boolean>) => async () => {
        const settled = await check();
        if (settled) reread();
        return settled;
    };
    const failure = apply.error ?? transfer.error;

    return (
        <section className="border border-base-300 rounded p-2 space-y-2">
            <h6 className="text-sm font-medium">{t('app.installationTitle')}</h6>
            <p className="text-xs text-base-content/70">{t('app.installationDesc')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col text-xs gap-1">
                    <span className="opacity-70">{t('app.installationScenario')}</span>
                    <select
                        className="select select-sm"
                        value={shownName}
                        disabled={busy}
                        onChange={(e) => setName(e.currentTarget.value)}
                    >
                        <option value="">{t('app.scenarioNone')}</option>
                        {names.map((scenarioName) => (
                            <option key={scenarioName} value={scenarioName}>
                                {scenarioName}
                            </option>
                        ))}
                        {installation !== null && !names.includes(currentName) && (
                            <option value={currentName}>{t('app.scenarioMissingOption', { name: currentName })}</option>
                        )}
                    </select>
                </label>
                {phone ? (
                    <div className="flex flex-col text-xs gap-1">
                        <span className="opacity-70">{t('app.installationOwner')}</span>
                        <span className="text-sm">
                            {installation === null
                                ? t('app.installationOwnerOnComputer')
                                : t(`app.installationOwner_${installation.executor}`)}
                        </span>
                    </div>
                ) : (
                    <label className="flex flex-col text-xs gap-1">
                        <span className="opacity-70">{t('app.installationOwner')}</span>
                        <select
                            className="select select-sm"
                            value={shownOwner}
                            disabled={busy}
                            onChange={(e) => setOwner(e.currentTarget.value)}
                        >
                            {OWNERS.map((executor) => (
                                <option key={executor} value={executor}>
                                    {t(`app.installationOwner_${executor}`)}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    className="btn btn-sm btn-neutral max-sm:min-h-10"
                    disabled={busy || generation === null || unowned}
                    onClick={() => void save()}
                >
                    {t('app.installationSave')}
                </button>
                {generation !== null && (
                    <span className="text-xs text-base-content/70">
                        {t('app.installationGeneration', { n: generation })}
                    </span>
                )}
            </div>
            {failure !== null && (
                <div className="alert alert-error py-2 text-sm" role="alert">
                    <span>
                        {t('app.installationFailed')} {scenarioRefusalText(failure, t) ?? ipcErrorText(failure, t)}
                    </span>
                </div>
            )}
            <EffectOutcomeNotice
                outcome={apply.outcome}
                onCheck={checked(apply.checkStatus)}
                onDismiss={apply.dismissOutcome}
            />
            <EffectOutcomeNotice
                outcome={transfer.outcome}
                onCheck={checked(transfer.checkStatus)}
                onDismiss={transfer.dismissOutcome}
            />
        </section>
    );
}

/**
 * The Scenarios section of the settings modal: the stored scenarios with
 * export / rename / delete, a copy from an example template, and import of a
 * shared file. Changes here are saved immediately (not with the modal's Save),
 * like the scenario files they are.
 *
 * @param props.onDirtyChange - told whether the builder holds a draft that was not saved (false once it closes)
 * @param props.onBusyChange - told whether the builder's save is running (false once it closes): the modal must not close meanwhile
 */
export function ScenariosSection({
    isOpen,
    onDirtyChange,
    onBusyChange,
}: {
    isOpen: boolean;
    onDirtyChange: (dirty: boolean) => void;
    onBusyChange?: (busy: boolean) => void;
}) {
    const { t } = useTranslation();
    const { scenarios, templates, revision, loading, error: loadError, refetch } = useScenarios(isOpen);
    const [importing, setImporting] = useState(false);
    const [templateId, setTemplateId] = useState('');
    const [error, setError] = useState<ScenarioErrorInfo | null>(null);
    // The scenario open in the builder: {initial, originalName} (null name = new).
    const [editing, setEditing] = useState<{ initial: ScenarioDraft; originalName: string | null } | null>(null);

    const changed = useCallback(() => {
        setError(null);
        void refetch();
    }, [refetch]);

    const addTemplate = async () => {
        // The add button is disabled until a template is picked from this list.
        const template = templates.find((item) => item.id === templateId) as (typeof templates)[number];
        const name = freeName(template.scenario.name, Object.keys(scenarios));
        const result = await ipc.callOrNull(() =>
            ipc.saveScenario({ ...template.scenario, name }, { overwrite: false }),
        );
        if (result?.success) changed();
        else
            setError({
                what: 'app.scenarioTemplateFailed',
                issues: failureIssuesOf(result),
            });
    };

    const names = Object.keys(scenarios);
    return (
        <SettingsSectionPanel id="scenarios" title={t(SETTINGS_SECTION_TITLES.scenarios)}>
            <p className="text-xs text-base-content/70 mb-3">{t('app.scenariosDesc')}</p>
            {editing ? (
                <ScenarioBuilder
                    initial={editing.initial}
                    originalName={editing.originalName}
                    revision={revision}
                    onSaved={() => {
                        setEditing(null);
                        changed();
                    }}
                    onRenamed={() => void refetch()}
                    onCancel={() => setEditing(null)}
                    onDirtyChange={onDirtyChange}
                    onBusyChange={onBusyChange}
                />
            ) : loading ? (
                <InlineLoader text={t('common.loading')} />
            ) : loadError ? (
                <div className="alert alert-error py-2 text-sm" role="alert">
                    <span>{t('app.scenariosLoadError')}</span>
                </div>
            ) : (
                <div className="space-y-3">
                    <ScenarioError error={error} />
                    <InstallationScenarioPanel />
                    {names.length === 0 ? (
                        <p className="text-sm text-base-content/70">{t('app.scenariosEmpty')}</p>
                    ) : (
                        <ul className="space-y-2">
                            {names.map((name) => (
                                <ScenarioRow
                                    key={name}
                                    name={name}
                                    scenario={scenarios[name]}
                                    onChanged={changed}
                                    onError={setError}
                                    onEdit={() => setEditing({ initial: scenarios[name], originalName: name })}
                                />
                            ))}
                        </ul>
                    )}
                    <div className="flex flex-wrap gap-2 items-center">
                        <button
                            type="button"
                            className="btn btn-sm btn-neutral"
                            onClick={() =>
                                setEditing({
                                    initial: newScenario(freeName(t('app.sbNew'), names)),
                                    originalName: null,
                                })
                            }
                        >
                            {t('app.sbNew')}
                        </button>
                        <select
                            className="select select-sm"
                            aria-label={t('app.scenarioTemplatePick')}
                            value={templateId}
                            onChange={(e) => setTemplateId(e.currentTarget.value)}
                        >
                            <option value="">{t('app.scenarioTemplatePick')}</option>
                            {templates.map((template) => (
                                <option key={template.id} value={template.id}>
                                    {template.scenario.name}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void addTemplate()}
                            disabled={!templateId}
                        >
                            {t('app.scenarioAddTemplate')}
                        </button>
                        {!importing && (
                            <button type="button" className="btn btn-sm" onClick={() => setImporting(true)}>
                                {t('app.scenarioImport')}
                            </button>
                        )}
                    </div>
                    {importing && (
                        <ImportPanel
                            revision={revision}
                            onDone={() => {
                                setImporting(false);
                                changed();
                            }}
                            onCancel={() => setImporting(false)}
                        />
                    )}
                </div>
            )}
        </SettingsSectionPanel>
    );
}
