import { useState, useEffect, useCallback } from 'react';
import { useSessionLoad } from './useSessionLoad';
import { useLatestRef } from './useLatestRef';
import * as ipc from '@/api/ipc';
import { useOnChosenPhotosCleared, withoutChosenPhotos } from '@/api/chosenPhotosCleared';

import type { Dispatch, SetStateAction } from 'react';
import type { ChallengeValues, RuleSource, TitleRuleInfo } from '../../types/settings';
import type { RendererSchema, SettingChangeHandler, SettingResetHandler } from '../../types/settingsEditor';
import { errorMessage } from '../../errorMessage';

/**
 * What the challenge's matching rules contribute, as the modal holds it: the matched profile
 * (`profile`, null when no rule names one), `suppressed` once this challenge opts out of it, and
 * the value layers (`ruleValues` with the profile, `inlineValues` without) with the rule each
 * inline key comes from. Null until loaded.
 */
type TitleRulesState = TitleRuleInfo | null;

export type SetOverrides = Dispatch<SetStateAction<ChallengeValues>>;
export type SetTitleRules = Dispatch<SetStateAction<TitleRulesState>>;

/** What matching rules contribute when none match (or none has loaded): nothing. */
const NO_RULES: TitleRuleInfo = {
    profile: null,
    suppressed: false,
    ruleValues: {},
    inlineValues: {},
    ruleSources: {},
    inlineSources: {},
};

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Keep only the keys the schema allows as per-challenge overrides; without a
 * schema (its fetch failed) no key is known to be allowed.
 */
const perChallengeOnly = (
    schema: RendererSchema | null | undefined,
    values: ChallengeValues | null | undefined,
): ChallengeValues => {
    const kept: ChallengeValues = {};
    for (const [key, value] of Object.entries(values || {})) {
        if (schema?.[key]?.perChallenge) kept[key] = value;
    }
    return kept;
};

// Single batch IPC call for the overrides (the facade's own-property-safe
// sparse map) instead of one round-trip per schema key, alongside the
// challenge's title-rule profile.
const fetchChallengeSession = (challengeId: string | number, challengeTitle: string) =>
    Promise.all([
        ipc.getChallengeOverrides(challengeId.toString()),
        ipc.getTitleProfile(challengeTitle, challengeId.toString()),
    ]);

/**
 * Load a challenge's stored overrides and title-rule profile once per
 * (open, challenge) session into the caller's state setters (stable useState
 * setters). Returns whether a load is in flight and whether the last load
 * failed — a failed load leaves the form on empty overrides, which must never
 * be saved over the stored ones.
 *
 * Two intertwined concerns:
 *   1. Don't clobber in-progress user edits when useSettingsSchema refetches
 *      and hands us a new schema reference mid-session: once a (challenge,
 *      title) has loaded, the load is disabled until the modal closes.
 *   2. Drop in-flight loads when the user closes the modal or the target
 *      changes before the IPC sequence resolves, so a stale setOverrides can
 *      never land (rapid open/close cycles would otherwise blank the page) —
 *      useSessionLoad supersedes them.
 */
function useOverridesLoad({
    isOpen,
    challengeId,
    challengeTitle,
    schema,
    setOverrides,
    setTitleRules,
}: {
    isOpen: boolean;
    challengeId: string | number | null | undefined;
    challengeTitle: string;
    schema: RendererSchema | null | undefined;
    setOverrides: SetOverrides;
    setTitleRules: SetTitleRules;
}) {
    const [loadedKey, setLoadedKey] = useState<string | null>(null);
    useEffect(() => {
        if (!isOpen) setLoadedKey(null);
    }, [isOpen]);

    const loadKey = `${challengeId}\0${challengeTitle}`;
    const load = useCallback(async () => {
        // Enabled only with a challenge id (see `enabled` below).
        const [stored, profile] = await fetchChallengeSession(challengeId as string | number, challengeTitle);
        return { values: perChallengeOnly(schema, stored), profile, key: loadKey };
    }, [challengeId, challengeTitle, schema, loadKey]);
    const onLoad = useCallback(
        ({ values, profile, key }: { values: ChallengeValues; profile: TitleRulesState; key: string }) => {
            setOverrides(values);
            setTitleRules(profile);
            setLoadedKey(key);
        },
        [setOverrides, setTitleRules],
    );

    return useSessionLoad(load, {
        enabled: isOpen && !!challengeId && !!schema && loadedKey !== loadKey,
        onLoad,
        failureLog: 'Error loading challenge overrides',
    });
}

/**
 * Save for the per-challenge settings modal. `saveError` is true when the
 * write was rejected by validation — shown as an alert and the modal stays
 * open so the edit isn't lost. Reset on every open.
 */
function useOverridesSave({
    isOpen,
    challengeId,
    schema,
    overrides,
    suppressed,
    loadFailed,
    rearmSchedule,
    onClose,
}: {
    isOpen: boolean;
    challengeId: string | number | null | undefined;
    schema: RendererSchema | null | undefined;
    overrides: ChallengeValues;
    suppressed: boolean;
    loadFailed: boolean;
    rearmSchedule: () => Promise<unknown>;
    onClose: () => void;
}) {
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(false);
    useEffect(() => {
        if (isOpen) setSaveError(false);
    }, [isOpen]);

    const save = useCallback(async () => {
        // Schema can be null if its fetch failed but schemaLoading flipped
        // to false — the Save button is then reachable but Object.keys(null)
        // would throw. Bail out instead of crashing the boundary.
        if (!challengeId || !schema) return;
        // The form holds empty overrides after a failed load; saving them
        // would wipe the challenge's stored settings.
        if (loadFailed) return;

        setSaving(true);
        try {
            const saved = await ipc.replaceChallengeOverrides(challengeId.toString(), overrides, suppressed);
            if (saved === false) {
                setSaveError(true);
                return;
            }
            setSaveError(false);

            // Close before the re-arm's settings read + challenge fetch, so
            // the saved modal doesn't linger open for that round-trip.
            onClose();

            // Re-arm the cadence timer so a changed per-challenge threshold /
            // scheduled fill takes effect now, not after the current wait.
            await rearmSchedule();
        } catch (err) {
            await ipc.logRendererError(`Error saving challenge settings: ${errorMessage(err) || err}`);
        } finally {
            setSaving(false);
        }
    }, [challengeId, overrides, schema, loadFailed, suppressed, rearmSchedule, onClose]);

    return { saving, saveError, save };
}

/** The rules' contribution without any chosen photos list: in the profile and in both value layers. */
const rulesWithoutChosenPhotos = (rules: TitleRuleInfo): TitleRuleInfo => ({
    ...rules,
    profile: rules.profile && { ...rules.profile, values: withoutChosenPhotos(rules.profile.values) },
    ruleValues: withoutChosenPhotos(rules.ruleValues),
    inlineValues: withoutChosenPhotos(rules.inlineValues),
});

/**
 * The rule behind a value the rules' active layer takes from a rule's own inline values, for the
 * "From rule" badge. The layer that runs names its own sources, so a key a profile supplies is never
 * credited to a later rule that merely sets it inline.
 */
const ruleSourceFor = (rules: TitleRuleInfo, ruleLayer: ChallengeValues, key: string): RuleSource | undefined => {
    const source = (rules.suppressed ? rules.inlineSources : rules.ruleSources)[key];
    return hasOwn(ruleLayer, key) && source && !source.viaProfile ? source : undefined;
};

/**
 * Read the rules' contribution again from the settings (a failed read changes nothing). The
 * suppression this dialog holds, saved or not, stays as it is. A reply that comes after the dialog
 * has closed, or moved to another challenge (`isCurrent` says no), is dropped: it describes a
 * challenge that is no longer on screen.
 */
const rereadTitleRules = async (
    challengeTitle: string,
    challengeId: string | number,
    setTitleRules: SetTitleRules,
    isCurrent: () => boolean,
    isSuppressed: () => boolean,
): Promise<void> => {
    const fresh = await ipc.callOrNull(() => ipc.getTitleProfile(challengeTitle, challengeId.toString()));
    if (fresh && isCurrent()) setTitleRules({ ...fresh, suppressed: isSuppressed() });
};

/**
 * The handler for a profile that was edited or deleted: when it is the one the rules matched, the
 * rules are read again for the challenge on screen (see rereadTitleRules). A reply is dropped once
 * the dialog closed or showed another challenge, and carries the suppression the dialog holds when
 * the reply lands.
 */
function useProfileReread({
    isOpen,
    challengeId,
    challengeTitle,
    rules,
    setTitleRules,
}: {
    isOpen: boolean;
    challengeId: string | number | null | undefined;
    challengeTitle: string;
    rules: TitleRuleInfo;
    setTitleRules: SetTitleRules;
}) {
    const onScreen = useLatestRef(isOpen ? `${challengeId}\0${challengeTitle}` : null);
    const suppressedNow = useLatestRef(rules.suppressed);
    return ({ name }: { name: string; values?: ChallengeValues; deleted?: boolean }) => {
        if (!challengeId || name.toLowerCase() !== rules.profile?.name.toLowerCase()) return;
        const asked = onScreen.current;
        void rereadTitleRules(
            challengeTitle,
            challengeId,
            setTitleRules,
            () => onScreen.current === asked,
            () => suppressedNow.current,
        );
    };
}

/**
 * What the challenge's rules contribute and the value resolution built on it:
 * override → rule values (inline values and the matched profile's, or the inline
 * values alone once the profile is suppressed) → global default → schema default.
 * `effectiveOf` / `inheritedOf` expose that chain with and without the override layer.
 */
function useTitleRules({
    isOpen,
    challengeId,
    challengeTitle,
    schema,
    defaults,
    overrides,
    setOverrides,
}: {
    isOpen: boolean;
    challengeId: string | number | null | undefined;
    challengeTitle: string;
    schema: RendererSchema | null | undefined;
    defaults: Record<string, unknown> | null | undefined;
    overrides: ChallengeValues;
    setOverrides: SetOverrides;
}) {
    const [titleRules, setTitleRules] = useState<TitleRulesState>(null);
    // Set when a profile Apply flips scheduledFillReplaces on for a challenge
    // that didn't have it — that one field can silently cost a challenge its
    // fills, so it gets a highlighted warning the generic apply-hint lacks.
    const [profileReplacesWarning, setProfileReplacesWarning] = useState(false);
    useEffect(() => {
        if (isOpen) setProfileReplacesWarning(false);
    }, [isOpen]);

    const rules = titleRules ?? NO_RULES;
    const onProfilesChanged = useProfileReread({ isOpen, challengeId, challengeTitle, rules, setTitleRules });
    // A suppressed profile drops out, the rules' own inline values do not: a rule that sets a
    // scenario or an auto-join directly keeps setting it.
    const ruleLayer: ChallengeValues = rules.suppressed ? rules.inlineValues : rules.ruleValues;
    const inheritedOf = (key: string) =>
        hasOwn(ruleLayer, key) ? ruleLayer[key] : (defaults?.[key] ?? schema?.[key]?.default);
    const effectiveOf = (key: string) => (key in overrides ? overrides[key] : inheritedOf(key));
    const ruleSourceOf = (key: string) => ruleSourceFor(rules, ruleLayer, key);

    /**
     * Load a saved profile's values into the form (schema-filtered,
     * belt-and-braces on top of the facade's whitelist) and suppress the
     * challenge's title-rule profile; Save persists it. ChallengeProfilesBar
     * only applies a selected (non-null) profile.
     */
    const applyProfile = (values: ChallengeValues) => {
        const next = perChallengeOnly(schema, values);
        const replacesWasOn = effectiveOf('scheduledFillReplaces') === true;
        setProfileReplacesWarning(next.scheduledFillReplaces === true && !replacesWasOn);
        setOverrides(next);
        setTitleRules((current) => ({ ...(current ?? NO_RULES), suppressed: true }));
    };

    // The matched profile's own values, while it applies (the "Using profile" badge).
    const profileValues: ChallengeValues = rules.suppressed ? {} : (rules.profile?.values ?? {});

    return {
        titleRules,
        setTitleRules,
        profileValues,
        inheritedOf,
        effectiveOf,
        ruleSourceOf,
        profileReplacesWarning,
        applyProfile,
        onProfilesChanged,
    };
}

/** The sparse override map and its per-key edits. */
function useOverrideEdits() {
    const [overrides, setOverrides] = useState<ChallengeValues>({});

    const changeOverride = useCallback<SettingChangeHandler>((key, value) => {
        setOverrides((prev) => ({ ...prev, [key]: value }));
    }, []);

    const clearOverride = useCallback<SettingResetHandler>((key) => {
        setOverrides((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }, []);

    return { overrides, setOverrides, changeOverride, clearOverride };
}

/**
 * Owns the form state behind the per-challenge settings modal: the sparse
 * override map, what the challenge's rules contribute (and whether this
 * challenge suppresses their profile), load-on-open, and save. The caller renders; it
 * drives Save / Clear all through `save()` / `clearAll()`.
 */
export function useChallengeOverrides({
    isOpen,
    challengeId,
    challengeTitle,
    schema,
    defaults,
    refetchSchema,
    rearmSchedule,
    onClose,
}: {
    isOpen: boolean;
    challengeId: string | number | null | undefined;
    challengeTitle: string;
    schema: RendererSchema | null | undefined;
    defaults: Record<string, unknown> | null | undefined;
    refetchSchema: () => Promise<void>;
    rearmSchedule: () => Promise<unknown>;
    onClose: () => void;
}) {
    const { overrides, setOverrides, changeOverride, clearOverride } = useOverrideEdits();

    // Refresh global defaults each time the modal opens so the
    // "Global default: …" hint reflects current persisted state.
    useEffect(() => {
        // The refetch settles its own failure into the schema query's error state.
        if (isOpen) void refetchSchema();
    }, [isOpen, refetchSchema]);

    const { setTitleRules, ...profile } = useTitleRules({
        isOpen,
        challengeId,
        challengeTitle,
        schema,
        defaults,
        overrides,
        setOverrides,
    });
    // Saving writes the whole override map: lists removed meanwhile must not come back with it.
    useOnChosenPhotosCleared(() => {
        setOverrides(withoutChosenPhotos);
        // From both rule layers and the matched profile, so none of them shows (or saves) a removed list.
        setTitleRules((current) => current && rulesWithoutChosenPhotos(current));
    });
    const { loading, loadFailed } = useOverridesLoad({
        isOpen,
        challengeId,
        challengeTitle,
        schema,
        setOverrides,
        setTitleRules,
    });
    const { saving, saveError, save } = useOverridesSave({
        isOpen,
        challengeId,
        schema,
        overrides,
        suppressed: profile.titleRules?.suppressed === true,
        loadFailed,
        rearmSchedule,
        onClose,
    });

    const clearAll = useCallback(() => {
        setOverrides({});
        setTitleRules((current) => (current ? { ...current, suppressed: false } : null));
    }, [setOverrides, setTitleRules]);

    return {
        overrides,
        ...profile,
        loading,
        loadFailed,
        saving,
        saveError,
        changeOverride,
        clearOverride,
        clearAll,
        save,
    };
}
