import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { useAutovote } from '@/contexts/AutovoteContext';
import { tierSchemaEntries, SETTINGS_GRID_CLASS, SETTING_CELL_CLASS } from '@/utils/groupSettings';
import { SettingInput } from './SettingInput';
import { SettingHelp } from '@/components/ui/SettingHelp';
import { deriveWindowHints } from '@/utils/windowHints';
import { MAX_VOTING_PAUSE_MINUTES } from '../../../settings/limits';
import { DEFAULT_TIMEZONE } from '../../../settings/uiDefaults';
import { TitleTagRulesEditor } from './TitleTagRulesEditor';
import { CategoryRulesEditor } from './CategoryRulesEditor';

// Challenge types seen on the live API (verified 2026-09-19). Suggestions for
// the category-rule type field only — it stays free text, so a type this build
// has never seen can still be typed in.
const CATEGORY_RULE_TYPE_SUGGESTIONS = ['default', 'exhibition', 'flash', 'speed'];
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ResetButton } from '@/components/ui/ResetButton';
import { ModalActionRow } from '@/components/ui/ModalActionRow';
import { SettingsTierHeading } from '@/components/ui/SettingsTierHeading';

function useTitleRuleEditorState(isOpen) {
    const [titleRules, setTitleRules] = useState([]);
    const [profiles, setProfiles] = useState({});
    const [titleRulesError, setTitleRulesError] = useState(false);
    // Category rules load and save on the same latch as title rules: both are
    // rule arrays persisted outside the settings table, and a partial load must
    // not let a save overwrite either with an empty default.
    const [categoryRules, setCategoryRules] = useState([]);
    const [categoryRulesError, setCategoryRulesError] = useState(false);
    const loadedRef = useRef(false);

    useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        loadedRef.current = false;
        setTitleRulesError(false);
        setCategoryRulesError(false);
        Promise.all([window.api.getTitleRules(), window.api.getChallengeProfiles(), window.api.getCategoryRules()])
            .then(([saved, savedProfiles, savedCategories]) => {
                if (cancelled) return;
                setTitleRules(Array.isArray(saved) ? saved : []);
                setProfiles(savedProfiles && typeof savedProfiles === 'object' ? savedProfiles : {});
                setCategoryRules(Array.isArray(savedCategories) ? savedCategories : []);
                loadedRef.current = true;
            })
            .catch(async (error) => {
                await window.api.logError(`Error loading title rules: ${error?.message || error}`);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    return {
        titleRules,
        setTitleRules,
        profiles,
        titleRulesError,
        setTitleRulesError,
        categoryRules,
        setCategoryRules,
        categoryRulesError,
        setCategoryRulesError,
        loadedRef,
    };
}

/**
 * Global settings modal
 */
export function SettingsModal({ isOpen, onClose }) {
    const { t, language, setLanguage } = useTranslation();
    const { rearmSchedule } = useAutovote();
    const { settings, updateSetting, refetch: refetchSettings } = useSettings();
    const { schema, defaults, groups, tiers, refetch: refetchSchema, loading: schemaLoading } = useSettingsSchema();

    const {
        formValues,
        uiValues,
        saving,
        originalUiValues,
        handleFormChange,
        handleUiChange,
        handleResetGlobal,
        handleResetUi,
        handleResetAll,
        commit,
        revert,
    } = useSettingsForm({
        isOpen,
        schema,
        defaults,
        settings,
        refetchSettings,
        refetchSchema,
        updateSetting,
    });

    // Timezone "+" toggle — local UI state, never persisted, so it stays
    // out of the form hook.
    const [tzInputVisible, setTzInputVisible] = useState(false);
    const [tzInputValue, setTzInputValue] = useState('');
    const [tzInputError, setTzInputError] = useState(false);

    const {
        titleRules,
        setTitleRules,
        profiles,
        titleRulesError,
        setTitleRulesError,
        categoryRules,
        setCategoryRules,
        categoryRulesError,
        setCategoryRulesError,
        loadedRef,
    } = useTitleRuleEditorState(isOpen);
    // True when commit() reported schema writes rejected by validation —
    // shown as an alert and the modal stays open (mirrors titleRulesError).
    const [saveError, setSaveError] = useState(false);

    // Reset the timezone input on every open so a stale "+" panel from a
    // previous session doesn't carry over.
    useEffect(() => {
        if (isOpen) {
            setTzInputVisible(false);
            setTzInputValue('');
            setTzInputError(false);
            setSaveError(false);
        }
    }, [isOpen]);

    const isValidTimezone = (tz) => {
        try {
            new Intl.DateTimeFormat(undefined, { timeZone: tz });
            return true;
        } catch {
            return false;
        }
    };

    const handleTimezoneAdd = useCallback(() => {
        const value = tzInputValue.trim();
        if (!value || !isValidTimezone(value)) {
            setTzInputError(true);
            return;
        }
        const list = uiValues.customTimezones || [];
        const nextList = list.includes(value) ? list : [...list, value];
        handleUiChange('customTimezones', nextList);
        handleUiChange('timezone', value);
        setTzInputValue('');
        setTzInputError(false);
        setTzInputVisible(false);
    }, [tzInputValue, uiValues.customTimezones, handleUiChange]);

    const handleTimezoneRemove = useCallback(() => {
        const filtered = (uiValues.customTimezones || []).filter((tz) => tz !== uiValues.timezone);
        handleUiChange('customTimezones', filtered);
        handleUiChange('timezone', DEFAULT_TIMEZONE);
    }, [uiValues.customTimezones, uiValues.timezone, handleUiChange]);

    const handleCancel = useCallback(() => {
        // Revert theme DOM if the user changed it during this open session.
        if (originalUiValues && originalUiValues.theme !== uiValues.theme) {
            document.documentElement.setAttribute('data-theme', originalUiValues.theme);
        }
        revert();
        onClose();
    }, [originalUiValues, uiValues.theme, revert, onClose]);

    const handleSave = useCallback(async () => {
        try {
            // commit() returns the schema keys whose write was rejected by
            // validation (e.g. a duplicate-count auto-fill schedule). Surface
            // that and keep the modal open — same rationale as the title-rules
            // check below — so the edit isn't silently lost behind a closed
            // modal that looked like a successful save.
            const rejectedKeys = await commit();
            if (Array.isArray(rejectedKeys) && rejectedKeys.length > 0) {
                setSaveError(true);
                return;
            }
            setSaveError(false);
            // Persist title rules only when the initial load succeeded (else a
            // failed load could overwrite saved rules with the empty default).
            // setTitleRules returns false when the input is rejected (e.g. a tag
            // over the length cap); surface that and keep the modal open so the
            // edit isn't silently lost.
            if (loadedRef.current) {
                const saved = await window.api.setTitleRules(titleRules);
                if (saved === false) {
                    setTitleRulesError(true);
                    return;
                }
                // Same contract for the category rules: false means the facade
                // rejected a row (duplicate condition, out-of-range value), so
                // surface it and keep the modal open rather than lose the edit.
                const savedCategories = await window.api.setCategoryRules(categoryRules);
                if (savedCategories === false) {
                    setCategoryRulesError(true);
                    return;
                }
            }
            setTitleRulesError(false);
            setCategoryRulesError(false);
            if (uiValues.language !== language) {
                setLanguage(uiValues.language);
            }
            // Re-arm the cadence timer so a changed threshold / scheduled-fill
            // setting takes effect now, not after the current wait elapses.
            await rearmSchedule();
            onClose();
        } catch (err) {
            await window.api.logError(`Error saving settings: ${err.message || err}`);
        }
    }, [
        commit,
        titleRules,
        categoryRules,
        setCategoryRulesError,
        uiValues.language,
        language,
        setLanguage,
        rearmSchedule,
        onClose,
        loadedRef,
        setTitleRulesError,
    ]);

    if (!isOpen) return null;

    // Voting-pause warnings for the GLOBAL defaults. A nightly pause is most
    // naturally configured here rather than per challenge, so without these the
    // typical user would never see "enabled but no time set" or "this covers the
    // whole day". Only the daily entries can be judged globally — before-end
    // offsets are relative to a specific challenge's deadline, hence closeTime 0,
    // which yields no before-end candidates. The corruption policy must match
    // getVotingPauseState's, or the hint would describe a pause that never opens.
    const vpGlobal = deriveWindowHints({
        keys: {
            enabled: 'useVotingPause',
            times: 'votingPauseTime',
            beforeEnd: 'votingPauseBeforeEnd',
            duration: 'votingPauseDurationMinutes',
        },
        defaultDurationMin: 240,
        effectiveOf: (key) => formValues[key] ?? schema?.[key]?.default,
        timezone: uiValues.timezone || DEFAULT_TIMEZONE,
        nowSec: Math.floor(Date.now() / 1000),
        closeTime: 0,
        onCorruptDuration: 'off',
        maxDurationMin: MAX_VOTING_PAUSE_MINUTES,
    });
    // Per-setting inline warnings for the GLOBAL defaults, keyed by the setting the
    // warning belongs UNDER. Kept as one dispatch so the render site stays a single
    // map — add a case here rather than a second hint list.
    const settingHints = (key) => {
        const effective = (k) => formValues[k] ?? schema?.[k]?.default;
        const hints = [];
        if (key === 'useVotingPause') {
            const noTriggers =
                (formValues.votingPauseTime ?? []).length === 0 && (formValues.votingPauseBeforeEnd ?? []).length === 0;
            if (formValues.useVotingPause === true && noTriggers) {
                hints.push({ tone: 'text-warning', text: t('app.votingPauseNoTimesHint') });
            }
            if (vpGlobal.coversWholeDay) {
                hints.push({ tone: 'text-warning font-medium', text: t('app.votingPauseAllDayHint') });
            }
        }
        // The pre-boost fill spends votes, so onlyBoost ("never vote, only boost")
        // blocks it outright — it sits at the very top of the rule engine, above
        // every rule including this one. Two settings that each look correct alone
        // silently cancelling out is exactly what an inline warning is for.
        if (key === 'voteBeforeBoost' && effective('voteBeforeBoost') === true) {
            if (effective('onlyBoost') === true) {
                hints.push({ tone: 'text-warning font-medium', text: t('app.voteBeforeBoostOnlyBoostHint') });
            }
            if (effective('autoBoost') !== true) {
                hints.push({ tone: 'text-warning', text: t('app.voteBeforeBoostNoAutoBoostHint') });
            }
            // voteOnlyInLastMinute blocks above the pre-boost branch too, so it
            // cancels the fill just as silently as onlyBoost does.
            if (effective('voteOnlyInLastMinute') === true) {
                hints.push({ tone: 'text-warning', text: t('app.voteBeforeBoostLastMinuteOnlyHint') });
            }
            // Both boost clocks off (0 = off on each) means no boost is ever
            // auto-applied, so there is no instant to fill ahead of.
            if (Number(effective('boostTime')) === 0 && Number(effective('keyUnlockedBoostTime')) === 0) {
                hints.push({ tone: 'text-warning', text: t('app.voteBeforeBoostNoBoostTimeHint') });
            }
        }
        return hints;
    };

    return (
        <Modal isOpen={isOpen} onClose={handleCancel} title={t('app.globalSettings')} size="2xl">
            {schemaLoading ? (
                <LoadingSpinner text={t('common.loading')} />
            ) : (
                <div className="space-y-6">
                    {saveError && (
                        <div className="alert alert-error py-2 text-sm" role="alert">
                            <span>{t('app.settingsSaveError')}</span>
                        </div>
                    )}
                    {/* Top Action Buttons */}
                    <ModalActionRow
                        onSave={handleSave}
                        saving={saving}
                        onSecondary={handleResetAll}
                        secondaryLabel={t('app.resetAll')}
                        onCancel={handleCancel}
                    />

                    {/* Application Settings Section */}
                    <div>
                        <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">
                            {t('app.applicationSettings')}
                        </h4>
                        <div className={SETTINGS_GRID_CLASS}>
                            {/* Theme */}
                            <div className={SETTING_CELL_CLASS}>
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.theme')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.themeDesc')}</p>
                                <div className="flex items-center gap-2">
                                    <span className="text-sm">{t('common.light')}</span>
                                    <input
                                        type="checkbox"
                                        className="toggle toggle-sm"
                                        checked={uiValues.theme === 'dark'}
                                        onChange={(e) => handleUiChange('theme', e.target.checked ? 'dark' : 'light')}
                                    />
                                    <span className="text-sm">{t('common.dark')}</span>
                                    <ResetButton onClick={() => handleResetUi('theme')} />
                                </div>
                            </div>

                            {/* Language */}
                            <div className={SETTING_CELL_CLASS}>
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.language')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.languageDesc')}</p>
                                <div className="flex items-center gap-2">
                                    <select
                                        className="select select-bordered select-sm"
                                        value={uiValues.language}
                                        onChange={(e) => handleUiChange('language', e.target.value)}
                                    >
                                        <option value="en">{t('app.english')}</option>
                                        <option value="lv">{t('app.latvian')}</option>
                                    </select>
                                    <ResetButton onClick={() => handleResetUi('language')} />
                                </div>
                            </div>

                            {/* Timezone */}
                            <div className={SETTING_CELL_CLASS}>
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.timezone')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.timezoneDesc')}</p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <select
                                        className="select select-bordered select-sm w-48"
                                        value={uiValues.timezone}
                                        onChange={(e) => handleUiChange('timezone', e.target.value)}
                                    >
                                        <option value={DEFAULT_TIMEZONE}>{DEFAULT_TIMEZONE}</option>
                                        {(uiValues.customTimezones || []).map((tz) => (
                                            <option key={tz} value={tz}>
                                                {tz}
                                            </option>
                                        ))}
                                        {uiValues.timezone !== DEFAULT_TIMEZONE &&
                                            !(uiValues.customTimezones || []).includes(uiValues.timezone) && (
                                                <option value={uiValues.timezone}>{uiValues.timezone}</option>
                                            )}
                                    </select>
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        title={t('app.addCustomTimezone')}
                                        onClick={() => {
                                            setTzInputVisible((v) => !v);
                                            setTzInputError(false);
                                        }}
                                    >
                                        +
                                    </button>
                                    <button
                                        className={`btn btn-ghost btn-sm text-error ${uiValues.timezone !== DEFAULT_TIMEZONE ? '' : 'invisible'}`}
                                        title={t('app.removeCurrentTimezone')}
                                        onClick={handleTimezoneRemove}
                                    >
                                        ×
                                    </button>
                                    <ResetButton onClick={() => handleResetUi('timezone')} />
                                </div>
                                {tzInputVisible && (
                                    <input
                                        type="text"
                                        placeholder={t('app.timezonePlaceholder')}
                                        className={`input input-bordered input-sm mt-2 w-60 ${tzInputError ? 'input-error' : ''}`}
                                        value={tzInputValue}
                                        onChange={(e) => {
                                            setTzInputValue(e.target.value);
                                            if (tzInputError) setTzInputError(false);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                handleTimezoneAdd();
                                            } else if (e.key === 'Escape') {
                                                setTzInputVisible(false);
                                                setTzInputValue('');
                                                setTzInputError(false);
                                            }
                                        }}
                                        onBlur={handleTimezoneAdd}
                                        autoFocus
                                    />
                                )}
                            </div>

                            {/* Check Frequency */}
                            <div className={SETTING_CELL_CLASS}>
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.checkFrequency')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.checkFrequencyDesc')}</p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm">{t('app.checkFrequencyMin')}</span>
                                    <input
                                        type="number"
                                        className="input input-bordered input-sm w-20"
                                        min="1"
                                        max="60"
                                        value={uiValues.checkFrequencyMin}
                                        onChange={(e) =>
                                            handleUiChange('checkFrequencyMin', parseInt(e.target.value, 10) || 1)
                                        }
                                    />
                                    <span className="text-sm">{t('app.checkFrequencyMax')}</span>
                                    <input
                                        type="number"
                                        className="input input-bordered input-sm w-20"
                                        min="1"
                                        max="60"
                                        value={uiValues.checkFrequencyMax}
                                        onChange={(e) =>
                                            handleUiChange('checkFrequencyMax', parseInt(e.target.value, 10) || 1)
                                        }
                                        onBlur={(e) => {
                                            const v = parseInt(e.target.value, 10) || 1;
                                            if (v < uiValues.checkFrequencyMin) {
                                                handleUiChange('checkFrequencyMax', uiValues.checkFrequencyMin);
                                            }
                                        }}
                                    />
                                    <span className="text-sm">{t('app.minutes')}</span>
                                    <ResetButton
                                        onClick={() => {
                                            handleResetUi('checkFrequencyMin');
                                            handleResetUi('checkFrequencyMax');
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Reliability — API retry / backoff */}
                            <div className={SETTING_CELL_CLASS}>
                                <label className="label">
                                    <span className="label-text font-medium">{t('app.reliability')}</span>
                                    <span className="badge badge-ghost badge-xs ml-2">{t('app.uiSetting')}</span>
                                </label>
                                <p className="text-xs text-base-content/60 mb-2">{t('app.apiMaxRetriesDesc')}</p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm">{t('app.apiMaxRetries')}</span>
                                    <input
                                        type="number"
                                        className="input input-bordered input-sm w-20"
                                        min="0"
                                        max="10"
                                        aria-label={t('app.apiMaxRetries')}
                                        value={uiValues.apiMaxRetries}
                                        onChange={(e) =>
                                            handleUiChange('apiMaxRetries', parseInt(e.target.value, 10) || 0)
                                        }
                                    />
                                    <span className="text-sm">{t('app.apiRetryBaseDelayMs')}</span>
                                    <input
                                        type="number"
                                        className="input input-bordered input-sm w-24"
                                        min="100"
                                        max="10000"
                                        step="100"
                                        aria-label={t('app.apiRetryBaseDelayMs')}
                                        value={uiValues.apiRetryBaseDelayMs}
                                        onChange={(e) =>
                                            handleUiChange('apiRetryBaseDelayMs', parseInt(e.target.value, 10) || 1000)
                                        }
                                    />
                                    <ResetButton
                                        onClick={() => {
                                            handleResetUi('apiMaxRetries');
                                            handleResetUi('apiRetryBaseDelayMs');
                                        }}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Challenge Defaults Section — grouped into static sub-sections */}
                    <div>
                        <h4 className="font-semibold text-base mb-3 border-b border-base-300 pb-2">
                            {t('app.challengeDefaults')}
                        </h4>
                        {tierSchemaEntries(schema, groups, tiers).map((band) => (
                            <div key={band.id ?? '_'} className="mb-6">
                                <SettingsTierHeading id={band.id} label={band.label} level="h5" />
                                {band.groups.map(({ id, label, entries }) => (
                                    <div key={id} className="mb-4">
                                        <h6 className="font-medium text-sm opacity-70 mb-2 mt-3">{t(label)}</h6>
                                        <div className={SETTINGS_GRID_CLASS}>
                                            {entries.map(([key, config]) => (
                                                <div key={key} className={SETTING_CELL_CLASS}>
                                                    <label className="label">
                                                        <span className="label-text font-medium">
                                                            {t(config.label)}
                                                        </span>
                                                        <span className="badge badge-ghost badge-xs ml-2">
                                                            {t('app.globalDefault')}
                                                        </span>
                                                    </label>
                                                    <p className="text-xs text-base-content/60 mb-2">
                                                        {t(config.description)}
                                                    </p>
                                                    <SettingHelp helpKey={config.helpKey} />
                                                    <SettingInput
                                                        settingKey={key}
                                                        config={config}
                                                        value={formValues[key] ?? config.default}
                                                        onChange={handleFormChange}
                                                        onReset={handleResetGlobal}
                                                    />
                                                    {settingHints(key).map((hint) => (
                                                        <p key={hint.text} className={`text-xs mt-1 ${hint.tone}`}>
                                                            {hint.text}
                                                        </p>
                                                    ))}
                                                </div>
                                            ))}
                                        </div>
                                        {/* Category rules belong to this group: they override
                                            nothing but its join-timing keys. They cannot be part
                                            of the schema-driven grid above (a rule ARRAY is not a
                                            settings entry — it persists in challengeSettings over
                                            its own IPC channel), so the group renders them itself
                                            rather than exiling them to a section of their own.

                                            Coupling to know about: tierSchemaEntries drops a group
                                            with no visible entries, so if the autoJoin group were
                                            ever pruned to zero settings this editor would silently
                                            stop rendering while its rules still load and save. The
                                            autoJoin toggle itself keeps the group non-empty today.
                                            Move this if that stops being true. */}
                                        {id === 'autoJoin' && (
                                            // A labelled region, NOT a second <h6>: the group's own
                                            // title above is already an h6, and h6 is the deepest
                                            // level HTML has - so a nested one would appear as its
                                            // SIBLING in a screen reader's heading outline and hide
                                            // that these rules are scoped to auto-join. role=group +
                                            // aria-labelledby announces the label without adding a
                                            // false section boundary. Rendered once, so a static id
                                            // cannot collide.
                                            <div
                                                className="mt-4 rounded-box bg-base-200/40 p-3"
                                                role="group"
                                                aria-labelledby="category-rules-label"
                                            >
                                                <p
                                                    id="category-rules-label"
                                                    className="font-medium text-sm opacity-70 mb-1"
                                                >
                                                    {t('app.categoryRules')}
                                                </p>
                                                <p className="text-xs text-base-content/60 mb-3">
                                                    {t('app.categoryRulesDesc')}
                                                </p>
                                                {categoryRulesError && (
                                                    <div className="alert alert-error mb-3 py-2 text-sm" role="alert">
                                                        <span>{t('app.categoryRulesSaveError')}</span>
                                                    </div>
                                                )}
                                                <CategoryRulesEditor
                                                    value={categoryRules}
                                                    types={CATEGORY_RULE_TYPE_SUGGESTIONS}
                                                    onChange={(next) => {
                                                        if (categoryRulesError) setCategoryRulesError(false);
                                                        setCategoryRules(next);
                                                    }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>

                    {/* Per-Title Tag Rules Section */}
                    <div>
                        <h4 className="font-semibold text-base mb-1 border-b border-base-300 pb-2">
                            {t('app.titleTagRules')}
                        </h4>
                        <p className="text-xs text-base-content/60 mb-3">{t('app.titleTagRulesDesc')}</p>
                        {titleRulesError && (
                            <div className="alert alert-error mb-3 py-2 text-sm" role="alert">
                                <span>{t('app.titleTagRulesSaveError')}</span>
                            </div>
                        )}
                        <TitleTagRulesEditor
                            value={titleRules}
                            profiles={profiles}
                            onChange={(next) => {
                                if (titleRulesError) setTitleRulesError(false);
                                setTitleRules(next);
                            }}
                        />
                    </div>

                    {/* Bottom Action Buttons */}
                    <ModalActionRow
                        bordered
                        onSave={handleSave}
                        saving={saving}
                        onSecondary={handleResetAll}
                        secondaryLabel={t('app.resetAll')}
                        onCancel={handleCancel}
                    />
                </div>
            )}
        </Modal>
    );
}
