import { useState, useEffect, useCallback } from 'react';
import { useSessionLoad } from './useSessionLoad';
import * as ipc from '@/api/ipc';

/** @import { Dispatch, SetStateAction } from 'react' */
/** @import { ChallengeValues } from '../../types/settings' */
/** @import { RendererSchema, SettingChangeHandler, SettingResetHandler } from '../../types/settingsEditor' */

/**
 * The challenge's title-rule profile as the modal holds it: the matched
 * profile, `suppressed` once this challenge opts out of it. Falsy = none.
 *
 * @typedef {{ name?: string, values?: ChallengeValues, suppressed?: boolean }} TitleProfile
 * @typedef {TitleProfile | false | null | undefined} TitleProfileState
 */

/** @typedef {Dispatch<SetStateAction<ChallengeValues>>} SetOverrides */
/** @typedef {Dispatch<SetStateAction<TitleProfileState>>} SetTitleProfile */

/**
 * @param {object} obj
 * @param {string} key
 */
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Keep only the keys the schema allows as per-challenge overrides; without a
 * schema (its fetch failed) no key is known to be allowed.
 *
 * @param {RendererSchema | null | undefined} schema
 * @param {ChallengeValues | null | undefined} values
 * @returns {ChallengeValues}
 */
const perChallengeOnly = (schema, values) => {
    /** @type {ChallengeValues} */
    const kept = {};
    for (const [key, value] of Object.entries(values || {})) {
        if (schema?.[key]?.perChallenge) kept[key] = value;
    }
    return kept;
};

// Single batch IPC call for the overrides (the facade's own-property-safe
// sparse map) instead of one round-trip per schema key, alongside the
// challenge's title-rule profile.
/**
 * @param {string | number} challengeId
 * @param {string} challengeTitle
 */
const fetchChallengeSession = (challengeId, challengeTitle) =>
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
 *
 * @param {{
 *   isOpen: boolean,
 *   challengeId: string | number | null | undefined,
 *   challengeTitle: string,
 *   schema: RendererSchema | null | undefined,
 *   setOverrides: SetOverrides,
 *   setTitleProfile: SetTitleProfile,
 * }} options
 */
function useOverridesLoad({ isOpen, challengeId, challengeTitle, schema, setOverrides, setTitleProfile }) {
    const [loadedKey, setLoadedKey] = useState(/** @type {string | null} */ (null));
    useEffect(() => {
        if (!isOpen) setLoadedKey(null);
    }, [isOpen]);

    const loadKey = `${challengeId}\0${challengeTitle}`;
    const load = useCallback(async () => {
        // Enabled only with a challenge id (see `enabled` below).
        const [stored, profile] = await fetchChallengeSession(
            /** @type {string | number} */ (challengeId),
            challengeTitle,
        );
        return { values: perChallengeOnly(schema, stored), profile, key: loadKey };
    }, [challengeId, challengeTitle, schema, loadKey]);
    const onLoad = useCallback(
        /** @param {{ values: ChallengeValues, profile: TitleProfile | null, key: string }} loaded */
        ({ values, profile, key }) => {
            setOverrides(values);
            setTitleProfile(profile);
            setLoadedKey(key);
        },
        [setOverrides, setTitleProfile],
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
 *
 * @param {{
 *   isOpen: boolean,
 *   challengeId: string | number | null | undefined,
 *   schema: RendererSchema | null | undefined,
 *   overrides: ChallengeValues,
 *   suppressed: boolean,
 *   loadFailed: boolean,
 *   rearmSchedule: () => Promise<unknown>,
 *   onClose: () => void,
 * }} options
 */
function useOverridesSave({ isOpen, challengeId, schema, overrides, suppressed, loadFailed, rearmSchedule, onClose }) {
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
            await ipc.logRendererError(
                `Error saving challenge settings: ${/** @type {{ message?: string } | null | undefined} */ (err)?.message || err}`,
            );
        } finally {
            setSaving(false);
        }
    }, [challengeId, overrides, schema, loadFailed, suppressed, rearmSchedule, onClose]);

    return { saving, saveError, save };
}

/**
 * The challenge's title-rule profile and the value resolution built on it:
 * override → profile value (unless suppressed) → global default → schema
 * default. `effectiveOf` / `inheritedOf` expose that chain with and without
 * the override layer.
 *
 * @param {{
 *   isOpen: boolean,
 *   schema: RendererSchema | null | undefined,
 *   defaults: Record<string, unknown> | null | undefined,
 *   overrides: ChallengeValues,
 *   setOverrides: SetOverrides,
 * }} options
 */
function useTitleProfile({ isOpen, schema, defaults, overrides, setOverrides }) {
    const [titleProfile, setTitleProfile] = useState(/** @type {TitleProfileState} */ (null));
    // Set when a profile Apply flips scheduledFillReplaces on for a challenge
    // that didn't have it — that one field can silently cost a challenge its
    // fills, so it gets a highlighted warning the generic apply-hint lacks.
    const [profileReplacesWarning, setProfileReplacesWarning] = useState(false);
    useEffect(() => {
        if (isOpen) setProfileReplacesWarning(false);
    }, [isOpen]);

    // `|| undefined` folds a `false` state into "no profile" for the optional chain.
    const matched = titleProfile || undefined;
    /** @type {ChallengeValues} */
    const profileValues = matched?.suppressed ? {} : (matched?.values ?? {});
    /** @param {string} key */
    const inheritedOf = (key) =>
        hasOwn(profileValues, key) ? profileValues[key] : (defaults?.[key] ?? schema?.[key]?.default);
    /** @param {string} key */
    const effectiveOf = (key) => (key in overrides ? overrides[key] : inheritedOf(key));

    /**
     * Load a saved profile's values into the form (schema-filtered,
     * belt-and-braces on top of the facade's whitelist) and suppress the
     * challenge's title-rule profile; Save persists it. ChallengeProfilesBar
     * only applies a selected (non-null) profile.
     *
     * @param {ChallengeValues} values
     */
    const applyProfile = (values) => {
        const next = perChallengeOnly(schema, values);
        const replacesWasOn = effectiveOf('scheduledFillReplaces') === true;
        setProfileReplacesWarning(next.scheduledFillReplaces === true && !replacesWasOn);
        setOverrides(next);
        setTitleProfile((profile) => ({ ...(profile || undefined), suppressed: true }));
    };

    /**
     * Keep the title-rule profile in step when that named profile is edited or deleted.
     *
     * @param {{ name: string, values?: ChallengeValues, deleted?: boolean }} change
     */
    const onProfilesChanged = ({ name, values }) => {
        if (name.toLowerCase() !== (titleProfile || undefined)?.name?.toLowerCase()) return;
        setTitleProfile((state) => {
            // Reached only once the name matched, so the state is that profile.
            const profile = /** @type {TitleProfile} */ (state);
            return values ? { ...profile, name, values } : profile?.suppressed && { suppressed: true };
        });
    };

    return {
        titleProfile,
        setTitleProfile,
        profileValues,
        inheritedOf,
        effectiveOf,
        profileReplacesWarning,
        applyProfile,
        onProfilesChanged,
    };
}

/** The sparse override map and its per-key edits. */
function useOverrideEdits() {
    const [overrides, setOverrides] = useState(/** @type {ChallengeValues} */ ({}));

    const changeOverride = useCallback(
        /** @type {SettingChangeHandler} */ (key, value) => {
            setOverrides((prev) => ({ ...prev, [key]: value }));
        },
        [],
    );

    const clearOverride = useCallback(
        /** @type {SettingResetHandler} */ (key) => {
            setOverrides((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
        },
        [],
    );

    return { overrides, setOverrides, changeOverride, clearOverride };
}

/**
 * Owns the form state behind the per-challenge settings modal: the sparse
 * override map, the challenge's title-rule profile (and whether this
 * challenge suppresses it), load-on-open, and save. The caller renders; it
 * drives Save / Clear all through `save()` / `clearAll()`.
 *
 * @param {{
 *   isOpen: boolean,
 *   challengeId: string | number | null | undefined,
 *   challengeTitle: string,
 *   schema: RendererSchema | null | undefined,
 *   defaults: Record<string, unknown> | null | undefined,
 *   refetchSchema: () => Promise<void>,
 *   rearmSchedule: () => Promise<unknown>,
 *   onClose: () => void,
 * }} options
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
}) {
    const { overrides, setOverrides, changeOverride, clearOverride } = useOverrideEdits();

    // Refresh global defaults each time the modal opens so the
    // "Global default: …" hint reflects current persisted state.
    useEffect(() => {
        // The refetch settles its own failure into the schema query's error state.
        if (isOpen) void refetchSchema();
    }, [isOpen, refetchSchema]);

    const { setTitleProfile, ...profile } = useTitleProfile({ isOpen, schema, defaults, overrides, setOverrides });
    const { loading, loadFailed } = useOverridesLoad({
        isOpen,
        challengeId,
        challengeTitle,
        schema,
        setOverrides,
        setTitleProfile,
    });
    const { saving, saveError, save } = useOverridesSave({
        isOpen,
        challengeId,
        schema,
        overrides,
        suppressed: (profile.titleProfile || undefined)?.suppressed === true,
        loadFailed,
        rearmSchedule,
        onClose,
    });

    const clearAll = useCallback(() => {
        setOverrides({});
        setTitleProfile((current) => (current ? { ...current, suppressed: false } : null));
    }, [setOverrides, setTitleProfile]);

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
