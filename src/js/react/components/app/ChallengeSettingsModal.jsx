import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { groupSchemaEntries } from '@/utils/groupSettings';
import { getGroupApplicability } from '@/utils/challengeApplicability';
import { formatSettingDefault } from '@/utils/formatters';
import { SettingInput } from './SettingInput';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Per-challenge settings modal
 */
export function ChallengeSettingsModal({ isOpen, onClose, challengeId, challengeTitle, challenge = null }) {
    const { t } = useTranslation();
    const { schema, defaults, groups, refetch: refetchSchema, loading: schemaLoading } = useSettingsSchema();

    // Local state for override values
    const [overrides, setOverrides] = useState({});
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(true);
    // True when a setChallengeOverride write was rejected by validation —
    // shown as an alert and the modal stays open so the edit isn't lost.
    const [saveError, setSaveError] = useState(false);

    // Refresh global defaults each time the modal opens so the
    // "Global default: …" hint reflects current persisted state.
    useEffect(() => {
        if (isOpen) {
            refetchSchema();
            setSaveError(false);
        }
    }, [isOpen, refetchSchema]);

    // Load existing overrides once per (open, challengeId) session.
    //
    // Two intertwined concerns:
    //   1. Don't clobber in-progress user edits when useSettingsSchema
    //      refetches and hands us a new schema reference mid-session.
    //      Tracked by loadedForChallengeRef — once we've loaded for a
    //      given challengeId, the effect early-returns even if schema
    //      ref changes.
    //   2. Drop in-flight loads when the user closes the modal or the
    //      target challengeId changes before the IPC sequence resolves,
    //      so a stale setOverrides can never land. Tracked by the
    //      per-run `cancelled` flag set from the effect cleanup.
    //
    // The previous "single ref" guard handled (1) but missed (2), and
    // rapid open/close cycles could land stale state — which is the
    // most likely contributor to the blank page seen on rapid clicks.
    const loadedForChallengeRef = useRef(null);
    useEffect(() => {
        if (!isOpen) {
            loadedForChallengeRef.current = null;
            return undefined;
        }
        if (!challengeId || !schema) return undefined;
        if (loadedForChallengeRef.current === challengeId) return undefined;

        let cancelled = false;
        const load = async () => {
            setLoading(true);
            const loaded = {};
            try {
                for (const key of Object.keys(schema)) {
                    if (!schema[key].perChallenge) continue;
                    const value = await window.api.getChallengeOverride(key, challengeId.toString());
                    if (cancelled) return;
                    if (value !== null) loaded[key] = value;
                }
                if (cancelled) return;
                setOverrides(loaded);
                loadedForChallengeRef.current = challengeId;
            } catch (err) {
                if (cancelled) return;
                await window.api.logError(`Error loading challenge overrides: ${err.message || err}`);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        load();
        return () => {
            cancelled = true;
        };
    }, [isOpen, challengeId, schema]);

    const handleOverrideChange = useCallback((key, value) => {
        setOverrides((prev) => ({ ...prev, [key]: value }));
    }, []);

    const handleClearOverride = useCallback((key) => {
        setOverrides((prev) => {
            const newOverrides = { ...prev };
            delete newOverrides[key];
            return newOverrides;
        });
    }, []);

    const handleClearAll = useCallback(() => {
        setOverrides({});
    }, []);

    const handleSave = useCallback(async () => {
        // Schema can be null if its fetch failed but schemaLoading flipped
        // to false — the Save button is then reachable but Object.keys(null)
        // would throw. Bail out instead of crashing the boundary.
        if (!challengeId || !schema) return;

        setSaving(true);
        try {
            // Write the edited overrides FIRST. setChallengeOverride validates
            // and returns false on rejection (e.g. a duplicate-count auto-fill
            // schedule); bailing out here — before any removal below — means a
            // rejected edit leaves the key's previously valid override intact.
            // (The old clear-then-rewrite order silently dropped it: the clear
            // loop ran, the invalid rewrite never did, and closing the modal
            // lost the prior value with no trace.)
            let anyRejected = false;
            for (const [key, value] of Object.entries(overrides)) {
                const saved = await window.api.setChallengeOverride(key, challengeId.toString(), value);
                if (saved === false) anyRejected = true;
            }
            if (anyRejected) {
                setSaveError(true);
                return;
            }
            setSaveError(false);

            // Only after every write validated: drop the overrides the user
            // cleared this session (per-challenge keys absent from the local
            // overrides map).
            for (const key of Object.keys(schema)) {
                if (schema[key].perChallenge && !(key in overrides)) {
                    await window.api.removeChallengeOverride(key, challengeId.toString());
                }
            }

            // Notify threshold scheduling update
            if (window.handleThresholdSettingsChange) {
                await window.handleThresholdSettingsChange();
            }

            onClose();
        } catch (err) {
            await window.api.logError(`Error saving challenge settings: ${err.message || err}`);
        } finally {
            setSaving(false);
        }
    }, [challengeId, overrides, schema, onClose]);

    if (!isOpen) return null;

    const title = `${t('app.challengeSettings')}: ${challengeTitle}`;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={title}>
            {schemaLoading || loading ? (
                <LoadingSpinner text={t('common.loading')} />
            ) : (
                <div className="space-y-4">
                    {saveError && (
                        <div className="alert alert-error py-2 text-sm" role="alert">
                            <span>{t('app.settingsSaveError')}</span>
                        </div>
                    )}
                    {/* Info about overrides */}
                    <div className="alert alert-info text-sm">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                        </svg>
                        <span>{t('app.challengeOverrideInfo')}</span>
                    </div>

                    {/* Settings grouped into static sections. Groups whose
                        action can no longer apply to this challenge (boost/turbo
                        already used, all entry slots full) are greyed out and
                        their inputs disabled — a live, render-time hint derived
                        from the challenge prop, never persisted. */}
                    {groupSchemaEntries(schema, groups, { perChallengeOnly: true }).map(({ id, label, entries }) => {
                        const { applicable, reasonKey } = getGroupApplicability(id, challenge);
                        // When a group can't apply, tie its heading + reason note to
                        // the section via role="group"/aria-* so assistive tech
                        // announces *why* the inputs are disabled, not just that
                        // they are (WCAG 1.3.1 — the relationship must be
                        // programmatic, not only visual).
                        const headingId = `challenge-group-${id}`;
                        const reasonId = applicable ? undefined : `challenge-group-reason-${id}`;

                        return (
                            <div
                                key={id}
                                role={applicable ? undefined : 'group'}
                                aria-labelledby={applicable ? undefined : headingId}
                                aria-describedby={reasonId}
                            >
                                <h4
                                    id={headingId}
                                    className="font-semibold text-base mb-3 border-b border-base-300 pb-2 flex items-center justify-between gap-2"
                                >
                                    <span>{t(label)}</span>
                                    {!applicable && (
                                        <span className="badge badge-ghost badge-xs">{t('app.notApplicable')}</span>
                                    )}
                                </h4>
                                {/* Heading, badge and reason note stay at full opacity so the
                                    *why* remains readable; only the inert inputs below are dimmed.
                                    Dimming the whole group would compound with the muted text
                                    colours and push the explanation below WCAG AA contrast. */}
                                {!applicable && (
                                    <div id={reasonId} className="mb-3">
                                        <p className="text-xs text-base-content/80">{t(reasonKey)}</p>
                                        {/* Reassure that a stored override on this (now-inert) group is
                                            not lost — the "Overridden" badge below still shows it. */}
                                        <p className="text-xs text-base-content/70 mt-0.5">
                                            {t('app.notApplicableHint')}
                                        </p>
                                    </div>
                                )}
                                <div className={applicable ? 'space-y-4' : 'space-y-4 opacity-60'}>
                                    {entries.map(([key, config]) => {
                                        const hasOverride = key in overrides;
                                        const globalDefault = defaults?.[key] ?? config.default;
                                        const currentValue = hasOverride ? overrides[key] : globalDefault;

                                        return (
                                            <div key={key} className="form-control">
                                                <label className="label">
                                                    <span className="label-text font-medium">{t(config.label)}</span>
                                                    <div className="flex gap-1">
                                                        {hasOverride ? (
                                                            <span className="badge badge-accent badge-xs">
                                                                {t('app.overridden')}
                                                            </span>
                                                        ) : (
                                                            <span className="badge badge-ghost badge-xs">
                                                                {t('app.usingGlobal')}
                                                            </span>
                                                        )}
                                                    </div>
                                                </label>
                                                <p className="text-xs text-base-content/60 mb-2">
                                                    {t(config.description)}
                                                </p>
                                                <SettingInput
                                                    settingKey={key}
                                                    config={config}
                                                    value={currentValue}
                                                    onChange={handleOverrideChange}
                                                    onReset={applicable && hasOverride ? handleClearOverride : null}
                                                    disabled={!applicable}
                                                />
                                                <p className="text-xs text-base-content/40 mt-1">
                                                    {t('app.globalDefault')}:{' '}
                                                    {formatSettingDefault(globalDefault, config, t)}
                                                </p>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}

                    {/* Action Buttons */}
                    <div className="flex justify-end gap-2 pt-4 border-t border-base-300">
                        <button className="btn btn-latvian" onClick={handleSave} disabled={saving}>
                            {saving && <span className="loading loading-spinner loading-xs" />}
                            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                            </svg>
                            {t('app.save')}
                        </button>
                        <button className="btn btn-warning" onClick={handleClearAll}>
                            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth="2"
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                            </svg>
                            {t('app.clearAll')}
                        </button>
                        <button className="btn" onClick={onClose}>
                            {t('app.cancel')}
                        </button>
                    </div>
                </div>
            )}
        </Modal>
    );
}
