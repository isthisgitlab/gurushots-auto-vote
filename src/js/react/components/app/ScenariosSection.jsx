import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useScenarios } from '@/api/useScenarios';
import { InlineLoader } from '@/components/ui/LoadingSpinner';
import { interp } from '@/utils/interp';
import * as ipc from '@/api/ipc';
import { ScenarioError, issuesOf } from './ScenarioError';
import { ScenarioBuilder } from './scenarioBuilder/ScenarioBuilder';
import { newScenario } from '../../../scenarios/builderModel';

/**
 * @import { WindowApi } from '../../../types/ipc'
 * @import { ScenarioDraft } from '../../../types/scenarioBuilder'
 * @import { ScenarioDocument } from '../../../settings/scenarioSchema'
 * @import { ScenarioErrorInfo } from './ScenarioError'
 */

/**
 * A successful preview-scenario-import: the parsed scenario, what it does and
 * whether importing it would replace a stored one.
 *
 * @typedef {Extract<Awaited<ReturnType<WindowApi['previewScenarioImport']>>, { success: true }>} ImportPreviewResult
 */

// How long an armed delete stays armed before it disarms itself.
const CONFIRM_TIMEOUT_MS = 4000;

/**
 * What a scenario does before it is imported: its phases, spends and limits.
 *
 * @param {{ preview: ImportPreviewResult['preview'] }} props
 */
function ImportPreview({ preview }) {
    const { t } = useTranslation();
    const limits = Object.entries(preview.limits);
    return (
        <div className="text-xs bg-base-200 rounded p-2 space-y-1">
            <div className="font-medium">
                {preview.name} — {interp(t('app.scenarioStartsIn'), { phase: preview.start })}
            </div>
            {preview.description && <p className="text-base-content/70">{preview.description}</p>}
            <ul className="list-disc ml-4">
                {preview.phases.map((phase) => (
                    <li key={phase.name}>
                        {interp(t('app.scenarioPhaseSummary'), { phase: phase.name, rules: phase.rules })}
                        {phase.settings.length > 0 && ` (${phase.settings.join(', ')})`}
                    </li>
                ))}
            </ul>
            <div>
                {preview.spending.length > 0
                    ? interp(t('app.scenarioSpends'), {
                          actions: preview.spending.map((spend) => `${spend.action} (${spend.rule})`).join(', '),
                      })
                    : t('app.scenarioSpendsNothing')}
            </div>
            <div>
                {limits.length > 0
                    ? interp(t('app.scenarioLimits'), { limits: limits.map(([key, n]) => `${n} ${key}`).join(', ') })
                    : t('app.scenarioNoLimits')}
            </div>
        </div>
    );
}

/**
 * Paste shared scenario JSON, see what it does, then import it.
 *
 * @param {{ onDone: () => void, onCancel: () => void }} props
 */
function ImportPanel({ onDone, onCancel }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [preview, setPreview] = useState(/** @type {ImportPreviewResult | null} */ (null));
    const [overwrite, setOverwrite] = useState(false);
    const [error, setError] = useState(/** @type {ScenarioErrorInfo | null} */ (null));

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
        const result = await ipc.callOrNull(() => ipc.importScenario(text, { overwrite }));
        if (result?.success) onDone();
        else
            setError({
                what: 'app.scenarioImportFailed',
                issues: issuesOf(result),
            });
    };

    return (
        <div className="border border-base-300 rounded p-2 space-y-2">
            <label className="text-xs font-medium block" htmlFor="scenario-import-text">
                {t('app.scenarioImportLabel')}
            </label>
            <textarea
                id="scenario-import-text"
                className="textarea textarea-bordered w-full font-mono text-xs"
                rows={6}
                value={text}
                onChange={(e) => {
                    setText(/** @type {HTMLTextAreaElement} */ (e.target).value);
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
                        onChange={(e) => setOverwrite(/** @type {HTMLInputElement} */ (e.target).checked)}
                    />
                    {interp(t('app.scenarioOverwrite'), { name: preview.preview.name })}
                </label>
            )}
            <div className="flex gap-2">
                <button type="button" className="btn btn-sm" onClick={() => void runPreview()} disabled={!text.trim()}>
                    {t('app.scenarioPreview')}
                </button>
                <button
                    type="button"
                    className="btn btn-sm btn-primary"
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
 * One stored scenario: export, rename and a two-step delete.
 *
 * @param {{
 *   name: string,
 *   scenario: ScenarioDocument,
 *   onChanged: () => void,
 *   onError: (error: ScenarioErrorInfo) => void,
 *   onEdit: () => void,
 * }} props
 */
function ScenarioRow({ name, scenario, onChanged, onError, onEdit }) {
    const { t } = useTranslation();
    const [exported, setExported] = useState(/** @type {string | null} */ (null));
    const [renaming, setRenaming] = useState(/** @type {string | null} */ (null));
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        if (!armed) return undefined;
        const timer = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [armed]);

    const runExport = async () => {
        const result = await ipc.callOrNull(() => ipc.exportScenario(name));
        if (result?.success) setExported(result.json);
        else onError({ what: 'app.scenarioExportFailed' });
    };

    const runRename = async () => {
        const result = await ipc.callOrNull(() => ipc.renameScenario(name, renaming));
        if (result?.success) {
            setRenaming(null);
            onChanged();
        } else {
            onError({
                what: 'app.scenarioRenameFailed',
                issues: issuesOf(result),
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
        else onError({ what: 'app.scenarioDeleteFailed' });
    };

    return (
        <li className="border border-base-300 rounded p-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium flex-1 min-w-0 truncate" title={name}>
                    {name}
                </span>
                <span className="text-xs text-base-content/60">
                    {interp(t('app.scenarioPhaseCount'), { count: Object.keys(scenario.phases).length })}
                </span>
                <button type="button" className="btn btn-xs" onClick={onEdit}>
                    {t('app.sbEdit')}
                </button>
                <button type="button" className="btn btn-xs" onClick={() => void runExport()}>
                    {t('app.scenarioExport')}
                </button>
                <button type="button" className="btn btn-xs" onClick={() => setRenaming(name)}>
                    {t('app.scenarioRename')}
                </button>
                <button
                    type="button"
                    className={`btn btn-xs ${armed ? 'btn-error' : ''}`}
                    onClick={() => void runDelete()}
                >
                    {armed ? t('app.scenarioDeleteConfirm') : t('app.scenarioDelete')}
                </button>
            </div>
            {scenario.description && <p className="text-xs text-base-content/60">{scenario.description}</p>}
            {renaming !== null && (
                <div className="flex gap-2">
                    <input
                        type="text"
                        className="input input-sm flex-1"
                        aria-label={t('app.scenarioRenameLabel')}
                        value={renaming}
                        onChange={(e) => setRenaming(/** @type {HTMLInputElement} */ (e.target).value)}
                    />
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => void runRename()}>
                        {t('app.scenarioRenameSave')}
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>
                        {t('app.cancel')}
                    </button>
                </div>
            )}
            {exported !== null && (
                <div className="space-y-1">
                    <p className="text-xs text-base-content/60">{t('app.scenarioExportHint')}</p>
                    <textarea
                        className="textarea textarea-bordered w-full font-mono text-xs"
                        rows={6}
                        readOnly
                        aria-label={interp(t('app.scenarioExportLabel'), { name })}
                        value={exported}
                        onFocus={(e) => /** @type {HTMLTextAreaElement} */ (e.target).select()}
                    />
                    <button type="button" className="btn btn-xs btn-ghost" onClick={() => setExported(null)}>
                        {t('app.scenarioExportClose')}
                    </button>
                </div>
            )}
        </li>
    );
}

/**
 * A name for a copy of `base` that no stored scenario uses yet.
 *
 * @param {string} base
 * @param {string[]} taken
 */
const freeName = (base, taken) => {
    const lower = new Set(taken.map((name) => name.toLowerCase()));
    let name = base;
    for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    return name;
};

/**
 * The Scenarios section of the settings modal: the stored scenarios with
 * export / rename / delete, a copy from an example template, and import of a
 * shared file. Changes here are saved immediately (not with the modal's Save),
 * like the scenario files they are.
 *
 * @param {{ isOpen: boolean }} props
 */
export function ScenariosSection({ isOpen }) {
    const { t } = useTranslation();
    const { scenarios, templates, loading, error: loadError, refetch } = useScenarios(isOpen);
    const [importing, setImporting] = useState(false);
    const [templateId, setTemplateId] = useState('');
    const [error, setError] = useState(/** @type {ScenarioErrorInfo | null} */ (null));
    // The scenario open in the builder: {initial, originalName} (null name = new).
    const [editing, setEditing] = useState(
        /** @type {{ initial: ScenarioDraft, originalName: string | null } | null} */ (null),
    );

    const changed = useCallback(() => {
        setError(null);
        void refetch();
    }, [refetch]);

    const addTemplate = async () => {
        // The add button is disabled until a template is picked from this list.
        const template = /** @type {(typeof templates)[number]} */ (templates.find((item) => item.id === templateId));
        const name = freeName(template.scenario.name, Object.keys(scenarios));
        const result = await ipc.callOrNull(() =>
            ipc.saveScenario({ ...template.scenario, name }, { overwrite: false }),
        );
        if (result?.success) changed();
        else
            setError({
                what: 'app.scenarioTemplateFailed',
                issues: issuesOf(result),
            });
    };

    const names = Object.keys(scenarios);
    return (
        <div>
            <h4 className="font-semibold text-base mb-1 border-b border-base-300 pb-2">{t('app.scenarios')}</h4>
            <p className="text-xs text-base-content/60 mb-3">{t('app.scenariosDesc')}</p>
            {loading ? (
                <InlineLoader text={t('common.loading')} />
            ) : loadError ? (
                <div className="alert alert-error py-2 text-sm" role="alert">
                    <span>{t('app.scenariosLoadError')}</span>
                </div>
            ) : editing ? (
                <ScenarioBuilder
                    initial={editing.initial}
                    originalName={editing.originalName}
                    onSaved={() => {
                        setEditing(null);
                        changed();
                    }}
                    onCancel={() => setEditing(null)}
                />
            ) : (
                <div className="space-y-3">
                    <ScenarioError error={error} />
                    {names.length === 0 ? (
                        <p className="text-sm text-base-content/60">{t('app.scenariosEmpty')}</p>
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
                            className="btn btn-sm btn-primary"
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
                            onChange={(e) => setTemplateId(/** @type {HTMLSelectElement} */ (e.target).value)}
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
                            onDone={() => {
                                setImporting(false);
                                changed();
                            }}
                            onCancel={() => setImporting(false)}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
