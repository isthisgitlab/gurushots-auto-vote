import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

// How long an armed confirm button (delete / overwrite) stays armed before
// falling back to its idle state.
const CONFIRM_TIMEOUT_MS = 4000;

const normalizeName = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

/**
 * Named challenge-settings profiles bar for the per-challenge settings modal.
 *
 * Apply only loads the profile's values into the modal's form state via
 * `onApply` — nothing persists until the user reviews and hits the modal's
 * own Save. Saving snapshots the modal's current sparse `overrides` under a
 * name. Delete and same-name overwrite are two-step confirm buttons (first
 * click arms, second fires) so a single misclick can't destroy a profile.
 *
 * `profileLimits` comes from the get-settings-schema response so the caps the
 * facade enforces are never duplicated here; when absent the client checks
 * are skipped and the facade's fail-closed save still guards.
 */
export function ChallengeProfilesBar({ overrides, onApply, profileLimits }) {
    const { t } = useTranslation();
    const [profiles, setProfiles] = useState({});
    const [selectedName, setSelectedName] = useState('');
    const [newName, setNewName] = useState('');
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState('');
    const [applied, setApplied] = useState(false);
    // null | 'delete' | 'overwrite' — which destructive action is armed.
    const [confirming, setConfirming] = useState(null);
    const confirmTimerRef = useRef(null);

    const clearConfirmTimer = useCallback(() => {
        if (confirmTimerRef.current) {
            clearTimeout(confirmTimerRef.current);
            confirmTimerRef.current = null;
        }
    }, []);

    const disarm = useCallback(() => {
        clearConfirmTimer();
        setConfirming(null);
    }, [clearConfirmTimer]);

    const arm = useCallback(
        (action) => {
            clearConfirmTimer();
            setConfirming(action);
            confirmTimerRef.current = setTimeout(() => {
                confirmTimerRef.current = null;
                setConfirming(null);
            }, CONFIRM_TIMEOUT_MS);
        },
        [clearConfirmTimer],
    );

    useEffect(() => clearConfirmTimer, [clearConfirmTimer]);

    const refreshProfiles = useCallback(async () => {
        try {
            const result = await window.api.getChallengeProfiles();
            setProfiles(result && typeof result === 'object' ? result : {});
        } catch (err) {
            await window.api.logError(`Error loading challenge profiles: ${err.message || err}`);
            setProfiles({});
        }
    }, []);

    useEffect(() => {
        refreshProfiles();
    }, [refreshProfiles]);

    const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
    const selectedProfile = selectedName && profiles[selectedName] ? profiles[selectedName] : null;

    const handleSelect = (name) => {
        setSelectedName(name);
        setApplied(false);
        disarm();
    };

    const handleApply = () => {
        if (!selectedProfile) return;
        onApply(selectedProfile);
        setErrorText('');
        setApplied(true);
        disarm();
    };

    const handleDelete = async () => {
        if (!selectedProfile) return;
        if (confirming !== 'delete') {
            arm('delete');
            return;
        }
        disarm();
        setBusy(true);
        try {
            await window.api.deleteChallengeProfile(selectedName);
            setSelectedName('');
            await refreshProfiles();
        } catch (err) {
            await window.api.logError(`Error deleting challenge profile: ${err.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const handleSave = async () => {
        const trimmed = newName.trim();
        if (!trimmed) {
            setErrorText(t('app.profileNameRequired'));
            disarm();
            return;
        }
        const maxNameLength = profileLimits?.maxProfileNameLength;
        if (maxNameLength != null && trimmed.length > maxNameLength) {
            setErrorText(t('app.profileNameTooLong').replace('{0}', String(maxNameLength)));
            disarm();
            return;
        }
        const normalized = normalizeName(trimmed);
        const exists = names.some((name) => normalizeName(name) === normalized);
        const maxProfiles = profileLimits?.maxChallengeProfiles;
        if (!exists && maxProfiles != null && names.length >= maxProfiles) {
            setErrorText(t('app.profileLimitReached').replace('{0}', String(maxProfiles)));
            disarm();
            return;
        }
        if (exists && confirming !== 'overwrite') {
            setErrorText('');
            arm('overwrite');
            return;
        }

        disarm();
        setBusy(true);
        try {
            const saved = await window.api.saveChallengeProfile(trimmed, overrides);
            if (saved) {
                setErrorText('');
                setNewName('');
                await refreshProfiles();
                setSelectedName(trimmed);
            } else {
                setErrorText(t('app.profileSaveError'));
            }
        } catch (err) {
            await window.api.logError(`Error saving challenge profile: ${err.message || err}`);
            setErrorText(t('app.profileSaveError'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded-box border border-base-300 p-3 space-y-2">
            <h4 className="font-semibold text-sm">{t('app.challengeProfiles')}</h4>

            <div className="flex flex-wrap items-center gap-2">
                <select
                    className="select select-bordered select-sm flex-1 min-w-40"
                    aria-label={t('app.challengeProfiles')}
                    value={selectedName}
                    onChange={(e) => handleSelect(e.target.value)}
                >
                    <option value="">{names.length === 0 ? t('app.noProfiles') : '—'}</option>
                    {names.map((name) => (
                        <option key={name} value={name}>
                            {`${name} (${Object.keys(profiles[name]).length})`}
                        </option>
                    ))}
                </select>
                <button className="btn btn-sm" onClick={handleApply} disabled={!selectedProfile || busy}>
                    {t('app.applyProfile')}
                </button>
                <button
                    className="btn btn-sm btn-outline btn-error"
                    onClick={handleDelete}
                    disabled={!selectedProfile || busy}
                >
                    {confirming === 'delete' ? t('app.confirmDelete') : t('app.deleteProfile')}
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <input
                    type="text"
                    className="input input-bordered input-sm flex-1 min-w-40"
                    placeholder={t('app.profileNamePlaceholder')}
                    aria-label={t('app.saveAsProfile')}
                    value={newName}
                    onChange={(e) => {
                        setNewName(e.target.value);
                        setErrorText('');
                        if (confirming === 'overwrite') disarm();
                    }}
                />
                <button className="btn btn-sm btn-latvian" onClick={handleSave} disabled={busy}>
                    {busy && <span className="loading loading-spinner loading-xs" />}
                    {confirming === 'overwrite' ? t('app.confirmOverwrite') : t('app.saveAsProfile')}
                </button>
            </div>

            {/* Single polite live region: confirm-arm prompts, errors and the
                post-apply reminder are announced without stealing focus. */}
            <p aria-live="polite" className={errorText ? 'text-xs text-error' : 'text-xs text-info'}>
                {errorText ||
                    (confirming === 'delete' && t('app.confirmDelete')) ||
                    (confirming === 'overwrite' && t('app.confirmOverwrite')) ||
                    (applied && t('app.profileAppliedHint')) ||
                    ''}
            </p>
            <p className="text-xs opacity-60">
                {t('app.profileApplyHint')} {t('app.profileOverwriteHint')}
            </p>
        </div>
    );
}
