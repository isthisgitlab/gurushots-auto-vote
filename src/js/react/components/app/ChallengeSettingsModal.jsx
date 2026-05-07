import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { SettingInput } from './SettingInput';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * Per-challenge settings modal
 */
export function ChallengeSettingsModal({ isOpen, onClose, challengeId, challengeTitle }) {
    const { t } = useTranslation();
    const { schema, defaults, refetch: refetchSchema, loading: schemaLoading } = useSettingsSchema();

    // Local state for override values
    const [overrides, setOverrides] = useState({});
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(true);

    // Refresh global defaults each time the modal opens so the
    // "Global default: …" hint reflects current persisted state.
    useEffect(() => {
        if (isOpen) {
            refetchSchema();
        }
    }, [isOpen, refetchSchema]);

    // Load existing overrides when modal opens
    useEffect(() => {
        const loadOverrides = async () => {
            if (!isOpen || !challengeId || !schema) return;

            setLoading(true);
            const loadedOverrides = {};

            try {
                for (const key of Object.keys(schema)) {
                    if (schema[key].perChallenge) {
                        const override = await window.api.getChallengeOverride(key, challengeId.toString());
                        if (override !== null) {
                            loadedOverrides[key] = override;
                        }
                    }
                }
                setOverrides(loadedOverrides);
            } catch (err) {
                await window.api.logError(`Error loading challenge overrides: ${err.message || err}`);
            } finally {
                setLoading(false);
            }
        };

        loadOverrides();
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
        if (!challengeId) return;

        setSaving(true);
        try {
            // First, clear all existing overrides for this challenge
            for (const key of Object.keys(schema)) {
                if (schema[key].perChallenge) {
                    await window.api.removeChallengeOverride(key, challengeId.toString());
                }
            }

            // Then set new overrides
            for (const [key, value] of Object.entries(overrides)) {
                await window.api.setChallengeOverride(key, challengeId.toString(), value);
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
                    {/* Info about overrides */}
                    <div className="alert alert-info text-sm">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>{t('app.challengeOverrideInfo')}</span>
                    </div>

                    {/* Settings List */}
                    {schema && Object.entries(schema).map(([key, config]) => {
                        // Only show settings that support per-challenge overrides
                        if (!config.perChallenge) return null;

                        const hasOverride = key in overrides;
                        const globalDefault = defaults?.[key] ?? config.default;
                        const currentValue = hasOverride ? overrides[key] : globalDefault;

                        return (
                            <div key={key} className="form-control">
                                <label className="label">
                                    <span className="label-text font-medium">{t(config.label)}</span>
                                    <div className="flex gap-1">
                                        {hasOverride ? (
                                            <span className="badge badge-accent badge-xs">{t('app.overridden')}</span>
                                        ) : (
                                            <span className="badge badge-ghost badge-xs">{t('app.usingGlobal')}</span>
                                        )}
                                    </div>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t(config.description)}</p>
                                <SettingInput
                                    settingKey={key}
                                    config={config}
                                    value={currentValue}
                                    onChange={handleOverrideChange}
                                    onReset={hasOverride ? handleClearOverride : null}
                                />
                                <p className="text-xs text-base-content/40 mt-1">
                                    {t('app.globalDefault')}: {String(globalDefault)}
                                </p>
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
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
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
