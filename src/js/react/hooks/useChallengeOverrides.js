import { useState, useEffect, useCallback, useRef } from 'react';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Keep only the keys the schema allows as per-challenge overrides. */
const perChallengeOnly = (schema, values) => {
    const kept = {};
    for (const [key, value] of Object.entries(values || {})) {
        if (schema[key]?.perChallenge) kept[key] = value;
    }
    return kept;
};

/**
 * Load a challenge's stored overrides and title-rule profile once per
 * (open, challenge) session into the caller's state setters (stable useState
 * setters, so they never re-trigger the load). Returns whether a load is in
 * flight.
 */
function useLoadOnOpen({ isOpen, challengeId, challengeTitle, schema, setOverrides, setTitleProfile }) {
    const [loading, setLoading] = useState(true);
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
    //      so a stale setOverrides can never land (rapid open/close cycles
    //      would otherwise blank the page). Tracked by the per-run
    //      `cancelled` flag set from the effect cleanup.
    const loadedForChallengeRef = useRef(null);
    useEffect(() => {
        if (!isOpen) {
            loadedForChallengeRef.current = null;
            return undefined;
        }
        if (!challengeId || !schema) return undefined;
        const loadKey = `${challengeId}\0${challengeTitle}`;
        if (loadedForChallengeRef.current === loadKey) return undefined;

        let cancelled = false;
        const load = async () => {
            setLoading(true);
            try {
                // Single batch IPC call (the facade's own-property-safe sparse
                // map) instead of one round-trip per schema key.
                const [stored, profile] = await Promise.all([
                    window.api.getChallengeOverrides(challengeId.toString()),
                    window.api.getTitleProfile(challengeTitle, challengeId.toString()),
                ]);
                if (cancelled) return;
                setOverrides(perChallengeOnly(schema, stored));
                setTitleProfile(profile);
                loadedForChallengeRef.current = loadKey;
            } catch (err) {
                if (cancelled) return;
                await window.api.logError(`Error loading challenge overrides: ${err.message || err}`);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        void load();
        return () => {
            cancelled = true;
        };
    }, [isOpen, challengeId, challengeTitle, schema, setOverrides, setTitleProfile]);
    return loading;
}

/**
 * Owns the form state behind the per-challenge settings modal: the sparse
 * override map, the challenge's title-rule profile (and whether this
 * challenge suppresses it), load-on-open, and save. The caller renders; it
 * drives Save / Clear all through `save()` / `clearAll()`.
 *
 * Value resolution for a key: override → profile value (unless suppressed) →
 * global default → schema default. `effectiveOf` / `inheritedOf` expose that
 * chain with and without the override layer.
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
    const [overrides, setOverrides] = useState({});
    const [saving, setSaving] = useState(false);
    // True when a setChallengeOverride write was rejected by validation —
    // shown as an alert and the modal stays open so the edit isn't lost.
    const [saveError, setSaveError] = useState(false);
    const [titleProfile, setTitleProfile] = useState(null);
    // Set when a profile Apply flips scheduledFillReplaces on for a challenge
    // that didn't have it — that one field can silently cost a challenge its
    // fills, so it gets a highlighted warning the generic apply-hint lacks.
    const [profileReplacesWarning, setProfileReplacesWarning] = useState(false);

    // Refresh global defaults each time the modal opens so the
    // "Global default: …" hint reflects current persisted state.
    useEffect(() => {
        if (isOpen) {
            refetchSchema();
            setSaveError(false);
            setProfileReplacesWarning(false);
        }
    }, [isOpen, refetchSchema]);

    const loading = useLoadOnOpen({ isOpen, challengeId, challengeTitle, schema, setOverrides, setTitleProfile });

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

    const clearAll = useCallback(() => {
        setOverrides({});
        setTitleProfile((profile) => (profile ? { ...profile, suppressed: false } : null));
    }, []);

    const save = useCallback(async () => {
        // Schema can be null if its fetch failed but schemaLoading flipped
        // to false — the Save button is then reachable but Object.keys(null)
        // would throw. Bail out instead of crashing the boundary.
        if (!challengeId || !schema) return;

        setSaving(true);
        try {
            const saved = await window.api.replaceChallengeOverrides(
                challengeId.toString(),
                overrides,
                titleProfile?.suppressed === true,
            );
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
            await window.api.logError(`Error saving challenge settings: ${err.message || err}`);
        } finally {
            setSaving(false);
        }
    }, [challengeId, overrides, schema, titleProfile, rearmSchedule, onClose]);

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
        overrides,
        titleProfile,
        profileValues,
        inheritedOf,
        effectiveOf,
        loading,
        saving,
        saveError,
        profileReplacesWarning,
        changeOverride,
        clearOverride,
        clearAll,
        save,
        applyProfile,
        onProfilesChanged,
    };
}
