import { useState, useEffect, useCallback } from 'react';
import { useSessionLoad } from './useSessionLoad';
import * as ipc from '@/api/ipc';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Keep only the keys the schema allows as per-challenge overrides. */
const perChallengeOnly = (schema, values) => {
    const kept = {};
    for (const [key, value] of Object.entries(values || {})) {
        if (schema[key]?.perChallenge) kept[key] = value;
    }
    return kept;
};

// Single batch IPC call for the overrides (the facade's own-property-safe
// sparse map) instead of one round-trip per schema key, alongside the
// challenge's title-rule profile.
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
 */
function useOverridesLoad({ isOpen, challengeId, challengeTitle, schema, setOverrides, setTitleProfile }) {
    const [loadedKey, setLoadedKey] = useState(null);
    useEffect(() => {
        if (!isOpen) setLoadedKey(null);
    }, [isOpen]);

    const loadKey = `${challengeId}\0${challengeTitle}`;
    const load = useCallback(async () => {
        const [stored, profile] = await fetchChallengeSession(challengeId, challengeTitle);
        return { values: perChallengeOnly(schema, stored), profile, key: loadKey };
    }, [challengeId, challengeTitle, schema, loadKey]);
    const onLoad = useCallback(
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
            await ipc.logRendererError(`Error saving challenge settings: ${err.message || err}`);
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
 */
function useTitleProfile({ isOpen, schema, defaults, overrides, setOverrides }) {
    const [titleProfile, setTitleProfile] = useState(null);
    // Set when a profile Apply flips scheduledFillReplaces on for a challenge
    // that didn't have it — that one field can silently cost a challenge its
    // fills, so it gets a highlighted warning the generic apply-hint lacks.
    const [profileReplacesWarning, setProfileReplacesWarning] = useState(false);
    useEffect(() => {
        if (isOpen) setProfileReplacesWarning(false);
    }, [isOpen]);

    const profileValues = titleProfile?.suppressed ? {} : (titleProfile?.values ?? {});
    const inheritedOf = (key) =>
        hasOwn(profileValues, key) ? profileValues[key] : (defaults?.[key] ?? schema?.[key]?.default);
    const effectiveOf = (key) => (key in overrides ? overrides[key] : inheritedOf(key));

    /**
     * Load a saved profile's values into the form (schema-filtered,
     * belt-and-braces on top of the facade's whitelist) and suppress the
     * challenge's title-rule profile; Save persists it. ChallengeProfilesBar
     * only applies a selected (non-null) profile.
     */
    const applyProfile = (values) => {
        const next = perChallengeOnly(schema, values);
        const replacesWasOn = effectiveOf('scheduledFillReplaces') === true;
        setProfileReplacesWarning(next.scheduledFillReplaces === true && !replacesWasOn);
        setOverrides(next);
        setTitleProfile((profile) => ({ ...profile, suppressed: true }));
    };

    /** Keep the title-rule profile in step when that named profile is edited or deleted. */
    const onProfilesChanged = ({ name, values }) => {
        if (name.toLowerCase() !== titleProfile?.name?.toLowerCase()) return;
        setTitleProfile((profile) =>
            values ? { ...profile, name, values } : profile?.suppressed && { suppressed: true },
        );
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
    const [overrides, setOverrides] = useState({});

    const changeOverride = useCallback((key, value) => {
        setOverrides((prev) => ({ ...prev, [key]: value }));
    }, []);

    const clearOverride = useCallback((key) => {
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
 * override map, the challenge's title-rule profile (and whether this
 * challenge suppresses it), load-on-open, and save. The caller renders; it
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
}) {
    const { overrides, setOverrides, changeOverride, clearOverride } = useOverrideEdits();

    // Refresh global defaults each time the modal opens so the
    // "Global default: …" hint reflects current persisted state.
    useEffect(() => {
        if (isOpen) refetchSchema();
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
        suppressed: profile.titleProfile?.suppressed === true,
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
