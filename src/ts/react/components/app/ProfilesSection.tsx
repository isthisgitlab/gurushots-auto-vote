import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { SETTINGS_SECTION_TITLES } from '@/contexts/SettingsNavContext';
import { useSettings } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { tierSchemaEntries } from '@/utils/groupSettings';
import { CONFIRM_TIMEOUT_MS, checkProfileName, profileNameCheckMessage } from '@/utils/profileName';
import { interp } from '@/utils/interp';
import { getIntentByName, intentValuesMatch } from '../../../settings/intentProfiles';
import { InlineLoader, LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ToneNote } from '@/components/ui/ToneNote';
import { ChallengeSettingsGroup } from './ChallengeSettingsGroup';
import { challengeSettingHints } from './SettingHints';
import { SettingsSectionPanel } from './SettingsSectionPanel';

import type { SettingsBand } from '@/utils/groupSettings';

/**
 * The Profiles tab of the global settings modal: edit a saved profile without
 * opening a challenge. Follows the Scenarios tab's pattern — the tab has its
 * own Save (Save profile writes the profile itself, not the modal's Save), a
 * switch away from an unsaved draft asks, and the tab reloads every time the
 * modal opens. Save as new profile writes the picked draft under another name
 * — an existing name turns into an Overwrite?/Rename? confirm — while delete
 * stays in the challenge modal's bar.
 *
 * @param props.onDirtyChange - told whether a picked profile's draft is unsaved (false once it is not)
 */
export function ProfilesSection({
    isOpen,
    onDirtyChange,
}: {
    isOpen: boolean;
    onDirtyChange: (dirty: boolean) => void;
}) {
    const { t } = useTranslation();
    const { schema, defaults, groups, tiers, profileLimits } = useSettingsSchema();
    const { settings } = useSettings();
    const editor = useProfileEditor({ isOpen, schema, defaults });

    const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
    const selectRef = useRef<HTMLSelectElement | null>(null);
    const saveButtonRef = useRef<HTMLButtonElement | null>(null);
    const saveAsInputRef = useRef<HTMLInputElement | null>(null);
    // The Save-as row's state: the typed name, which two-step confirm is
    // armed (and the stored name an armed Overwrite? names), and the row's
    // own error text — the only place a Save-as message shows.
    const [saveAsName, setSaveAsName] = useState('');
    const [saveAsConfirming, setSaveAsConfirming] = useState<null | 'rename' | 'overwrite'>(null);
    const [saveAsTarget, setSaveAsTarget] = useState('');
    const [saveAsErrorText, setSaveAsErrorText] = useState('');
    // Where focus returns when a flow disabled and re-enabled its controls:
    // the select after a discard read or a landed save, the Save button after
    // a refused save (which re-enables it over the still-dirty form), the
    // Save-as name input after the row showed an error or a refusal.
    const refocusRef = useRef<'select' | 'save' | 'name' | null>(null);
    // The 'save' target is known only after the save's own await; the tick
    // guarantees that effect a commit to run in.
    const [focusTick, setFocusTick] = useState(0);

    const names = Object.keys(editor.profiles).sort((a, b) => a.localeCompare(b));
    const selectedName = editor.selected ?? '';
    const selectedProfile = selectedName && editor.profiles[selectedName] ? editor.profiles[selectedName] : null;
    // Distinguish built-in intent presets from user profiles and edited copies.
    const selectedIntent = getIntentByName(selectedName);
    const selectedIntentModified = selectedIntent ? !intentValuesMatch(selectedIntent, selectedProfile) : false;
    const displayNameOf = (name: string) => {
        const intent = getIntentByName(name);
        return intent ? t(intent.nameKey) : name;
    };

    // Reactive because every edit, seed and save re-renders the section.
    const dirty = editor.isDirty();
    useEffect(() => {
        onDirtyChange(dirty);
    }, [dirty, onDirtyChange]);

    const requestSwitch = (name: string) => {
        if (dirty) setPendingSwitch(name);
        else editor.selectProfile(name);
    };

    // The Save-as row's two-step confirms fall back to their idle state on the
    // same timeout the challenge modal's bar uses.
    const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearConfirmTimer = useCallback(() => {
        if (confirmTimerRef.current) {
            clearTimeout(confirmTimerRef.current);
            confirmTimerRef.current = null;
        }
    }, []);
    const disarmRow = useCallback(() => {
        clearConfirmTimer();
        setSaveAsConfirming(null);
    }, [clearConfirmTimer]);
    const armRow = useCallback(
        (action: 'rename' | 'overwrite') => {
            clearConfirmTimer();
            setSaveAsConfirming(action);
            confirmTimerRef.current = setTimeout(() => {
                confirmTimerRef.current = null;
                setSaveAsConfirming(null);
            }, CONFIRM_TIMEOUT_MS);
        },
        [clearConfirmTimer],
    );
    useEffect(() => clearConfirmTimer, [clearConfirmTimer]);

    // Another picked profile must never inherit an armed confirm (Rename?
    // would rename whatever is picked when it fires) or the last one's message.
    useEffect(() => {
        disarmRow();
        setSaveAsErrorText('');
    }, [selectedName, disarmRow]);

    const keepEditing = () => {
        setPendingSwitch(null);
        // The select's value prop never changed, so the DOM still holds the
        // pick the user is retracting: put the current profile back. The ref
        // is set — the confirm only opens from that select's own change.
        /* istanbul ignore else */
        if (selectRef.current) selectRef.current.value = selectedName;
        refocusRef.current = 'select';
        setFocusTick((n) => n + 1);
    };
    // The select flow's targets (a discard read, Keep editing) disable it
    // first, and focus() is a no-op on a disabled element: this fires on the
    // loading/saving change (or the Keep-editing tick) that finds it enabled.
    useLayoutEffect(() => {
        if (refocusRef.current !== 'select' || editor.loading || editor.saving) return;
        refocusRef.current = null;
        selectRef.current?.focus();
    }, [editor.loading, editor.saving, focusTick]);
    // The refused save re-enables the Save button over the still-dirty form;
    // the await and the tick put this after the commit that re-enabled it.
    useLayoutEffect(() => {
        if (refocusRef.current !== 'save') return;
        refocusRef.current = null;
        saveButtonRef.current?.focus();
    }, [focusTick]);
    // The Save-as row's name input is never disabled, so its refocus needs no
    // wait — only the commit the tick guarantees.
    useLayoutEffect(() => {
        if (refocusRef.current !== 'name') return;
        refocusRef.current = null;
        saveAsInputRef.current?.focus();
    }, [focusTick]);

    const runSave = async (): Promise<boolean> => {
        // A landed save clears the draft and its buttons; a refused one
        // re-enables them over the still-dirty form — focus follows the state
        // the answer leaves behind.
        const landed = await editor.save();
        refocusRef.current = landed ? 'select' : 'save';
        setFocusTick((n) => n + 1);
        return landed;
    };

    const focusNameInput = () => {
        refocusRef.current = 'name';
        setFocusTick((n) => n + 1);
    };

    // The send half of the Save-as row: the name has passed checkProfileName
    // (or an armed confirm fired). `ofExisting` says whether the save targets
    // a profile that already exists, which picks the refusal message.
    // `sendName` is the name the save goes under: the typed one, except an
    // overwrite sends the stored name so another profile is never re-cased by it.
    const fireSaveAs = async (sendName: string, ofExisting: boolean) => {
        const landed = await editor.saveAs(sendName);
        if (landed) {
            setSaveAsErrorText('');
            setSaveAsName('');
            refocusRef.current = 'select';
        } else {
            setSaveAsErrorText(t(ofExisting ? 'app.profileEditSaveError' : 'app.profileSaveAsError'));
            refocusRef.current = 'name';
        }
        setFocusTick((n) => n + 1);
    };

    const runSaveAs = async () => {
        if (editor.saving || editor.loading) return;
        const trimmed = saveAsName.trim();
        const check = checkProfileName(trimmed, names, profileLimits);
        const message = profileNameCheckMessage(check, t);
        if (message !== null) {
            setSaveAsErrorText(message);
            focusNameInput();
            return;
        }
        if (typeof check === 'object' && 'existing' in check) {
            if (check.existing === selectedName) {
                if (trimmed === selectedName) {
                    if (!dirty) {
                        setSaveAsErrorText(t('app.saveAsNoChanges'));
                        focusNameInput();
                        return;
                    }
                    // Plain Save: the Save-profile flow owns focus and its
                    // refusal alert.
                    if (await runSave()) {
                        setSaveAsErrorText('');
                        setSaveAsName('');
                    }
                    return;
                }
                // A case-only variant of the picked profile is a rename.
                if (saveAsConfirming !== 'rename') {
                    setSaveAsErrorText('');
                    armRow('rename');
                    return;
                }
                disarmRow();
                await fireSaveAs(trimmed, true);
                return;
            }
            // Another profile's name (any casing) is an overwrite.
            if (saveAsConfirming !== 'overwrite') {
                setSaveAsErrorText('');
                setSaveAsTarget(check.existing);
                armRow('overwrite');
                return;
            }
            disarmRow();
            await fireSaveAs(check.existing, true);
            return;
        }
        await fireSaveAs(trimmed, false);
    };

    const runDiscard = () => {
        // The read below disables the select; the select effect above returns
        // focus when the read settles and re-enables it.
        refocusRef.current = 'select';
        void editor.discard();
    };

    const bands = tierSchemaEntries(schema, groups, tiers, { perChallengeOnly: true });
    const hintsFor = challengeSettingHints({
        effectiveOf: editor.effectiveOf,
        appSettings: settings?.app,
        challenge: null,
        profileReplacesWarning: false,
        t,
    });
    const renderBand = (band: SettingsBand) => (
        <div key={band.id ?? '_'}>
            {band.label && (
                <h5 className="mb-2 font-semibold text-sm uppercase tracking-wide text-base-content">
                    {t(band.label)}
                </h5>
            )}
            {band.groups.map((group) => (
                <ChallengeSettingsGroup
                    key={group.id}
                    id={group.id}
                    label={group.label}
                    entries={group.entries}
                    challenge={null}
                    defaults={defaults}
                    form={editor}
                    hintsFor={hintsFor}
                    overriddenLabelKey="app.setInProfile"
                />
            ))}
        </div>
    );

    const saveAsLabel =
        saveAsConfirming === 'rename'
            ? t('app.confirmRename')
            : saveAsConfirming === 'overwrite'
              ? t('app.confirmOverwrite')
              : t('app.saveAsNewProfile');
    // The row's own live message: its error, or an armed confirm's sentence.
    const saveAsLive =
        saveAsErrorText ||
        (saveAsConfirming === 'rename' &&
            interp(dirty ? t('app.saveAsRenameDirtyText') : t('app.saveAsRenameText'), {
                from: selectedName,
                to: saveAsName.trim(),
            })) ||
        (saveAsConfirming === 'overwrite' && interp(t('app.saveAsOverwriteText'), { name: saveAsTarget })) ||
        '';

    return (
        <SettingsSectionPanel id="profiles" title={t(SETTINGS_SECTION_TITLES.profiles)}>
            <p className="text-xs text-base-content/70 mb-3">{t('app.profilesTabDesc')}</p>
            {editor.loading && !editor.loadedOnce ? (
                <InlineLoader text={t('common.loading')} />
            ) : editor.loadFailed ? (
                <div className="alert alert-error py-2 text-sm" role="alert">
                    <span>{t('app.profilesLoadError')}</span>
                </div>
            ) : (
                <>
                    {names.length === 0 && <p className="text-sm text-base-content/70">{t('app.profilesEmptyHint')}</p>}
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                        <select
                            ref={selectRef}
                            className="select select-sm flex-1 min-w-40"
                            aria-label={t('app.challengeProfiles')}
                            value={selectedName}
                            onChange={(e) => requestSwitch(e.currentTarget.value)}
                            disabled={editor.saving || editor.loading}
                        >
                            <option value="">{names.length === 0 ? t('app.noProfiles') : '—'}</option>
                            {names.map((name) => (
                                <option key={name} value={name}>
                                    {`${getIntentByName(name) ? '★ ' : ''}${displayNameOf(name)} (${Object.keys(editor.profiles[name]).length})`}
                                </option>
                            ))}
                        </select>
                    </div>
                    {selectedIntent && selectedProfile && (
                        <p className="text-xs">
                            <span
                                className={`badge badge-sm mr-1 ${selectedIntentModified ? 'badge-warning' : 'badge-ghost'}`}
                            >
                                {selectedIntentModified ? t('app.intentModified') : t('app.intentBuiltIn')}
                            </span>
                            {t(selectedIntent.descKey)}
                        </p>
                    )}
                    {/* Single polite live region: a landed "Profile saved." is
                    announced without stealing focus. */}
                    <p aria-live="polite" className="text-xs">
                        {editor.savedNote && (
                            <ToneNote tone="info" as="span">
                                {t('app.profileSaved')}
                            </ToneNote>
                        )}
                    </p>
                    {selectedProfile && (
                        <>
                            {bands.map(renderBand)}
                            {editor.saveError && (
                                <div className="alert alert-error py-2 text-sm" role="alert">
                                    <span>{t('app.profileEditSaveError')}</span>
                                </div>
                            )}
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                                <button
                                    ref={saveButtonRef}
                                    type="button"
                                    className="btn btn-sm btn-neutral"
                                    onClick={() => void runSave()}
                                    disabled={!dirty || editor.saving || editor.loading}
                                    aria-busy={editor.saving}
                                >
                                    {editor.saving && <LoadingSpinner size="xs" decorative />}
                                    {t('app.saveProfile')}
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    onClick={runDiscard}
                                    disabled={!dirty || editor.saving || editor.loading}
                                >
                                    {t('app.discardProfileChanges')}
                                </button>
                            </div>
                            {/* A form, so Enter in the name input runs Save as. */}
                            <form
                                className="flex flex-wrap items-center gap-2 mt-2"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void runSaveAs();
                                }}
                            >
                                <label className="text-sm text-base-content" htmlFor="profile-save-as-name">
                                    {t('app.saveAsNewLabel')}
                                </label>
                                <input
                                    id="profile-save-as-name"
                                    ref={saveAsInputRef}
                                    type="text"
                                    className="input input-sm flex-1 min-w-40"
                                    value={saveAsName}
                                    onChange={(e) => {
                                        setSaveAsName(e.currentTarget.value);
                                        setSaveAsErrorText('');
                                        disarmRow();
                                    }}
                                />
                                {/* aria-disabled + guard, as the picker's buttons do: it stays
                                reachable while either save runs but presses nothing. */}
                                <button
                                    type="submit"
                                    className="btn btn-sm btn-neutral"
                                    aria-disabled={editor.saving || editor.loading}
                                    aria-busy={editor.saving}
                                >
                                    {editor.saving && <LoadingSpinner size="xs" decorative />}
                                    {saveAsLabel}
                                </button>
                            </form>
                            {/* Single polite live region: the Save-as row's errors, confirm
                            prompts and refusals are announced without stealing focus. */}
                            <p aria-live="polite" className="text-xs">
                                {saveAsLive && (
                                    <ToneNote tone={saveAsErrorText ? 'error' : 'info'} as="span">
                                        {saveAsLive}
                                    </ToneNote>
                                )}
                            </p>
                            <p className="text-xs text-base-content/70">{t('app.saveAsHint')}</p>
                        </>
                    )}
                </>
            )}
            <ConfirmModal
                isOpen={pendingSwitch !== null}
                title={t('app.profileSwitchTitle')}
                working={false}
                problem={null}
                onClose={keepEditing}
                onConfirm={() => {
                    // Set — the confirm only fires while a switch is pending.
                    editor.selectProfile(pendingSwitch!);
                    setPendingSwitch(null);
                }}
                confirmLabel="app.discardProfileChanges"
                cancelLabel="app.settingsKeepEditing"
                workingLabel="app.discardProfileChanges"
            >
                <p>{t('app.profileSwitchText')}</p>
            </ConfirmModal>
        </SettingsSectionPanel>
    );
}
