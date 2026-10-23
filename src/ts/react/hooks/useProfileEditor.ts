import { useCallback, useEffect, useRef, useState } from 'react';
import { useIpcQuery } from '@/api/useIpcQuery';
import { useLatestRef } from './useLatestRef';
import * as ipc from '@/api/ipc';
import { valuesEqual } from '@/utils/valuesEqual';
import { ON_ONLY_KEYS } from '../../settings/ruleBehaviour';
import { errorMessage } from '../../errorMessage';

import type { IpcQueryTools } from '@/api/useIpcQuery';
import type { ChallengeValues, RuleSource } from '../../types/settings';
import type { RendererSchema, SettingChangeHandler, SettingResetHandler } from '../../types/settingsEditor';

/**
 * The stored named profiles, as get-challenge-profiles answers them.
 */
type StoredProfiles = Record<string, ChallengeValues>;

// Module-level so the query never re-keys mid-session; the bridge is looked
// up at call time, so tests swap it through window.api. A rejection is logged
// here (the query only settles failures into its error state); a null
// resolution — the handler's failure fallback — is logged in `apply`.
const fetchProfiles = async (): Promise<StoredProfiles | null> => {
    try {
        return await ipc.getChallengeProfiles();
    } catch (reason) {
        await ipc.logRendererError(`Error loading challenge profiles: ${errorMessage(reason) || reason}`);
        throw reason;
    }
};

// The no-rule stand-in the per-challenge cells read: the Profiles tab edits a
// stored profile, whose values are never attributed to a rule.
const ruleSourceOf = (_key: string): RuleSource | undefined => undefined;
// The profile layer a cell's "Using profile" badge reads: every value shown IS
// the profile being edited, so no extra layer sits under the override map.
const NO_PROFILE_VALUES: ChallengeValues = {};

/**
 * The Profiles tab's form state, over the stored named profiles: pick a
 * profile, edit its sparse values map, save it back through
 * saveChallengeProfile (which re-validates and updates the rules assigned to
 * it). Follows the Scenarios tab's contract: a load on every open (a read
 * still in flight at close is dropped), a fresh read reseeding while the form
 * is clean, and Discard reseeding from a fresh read.
 *
 * `inheritedOf` is the chain a cell's inherited value shows: the stored global
 * default, or the schema default for a challengeOnly key (which has no global
 * value) — the same rule as settings/defaults.ts globalChallengeValues.
 */
export function useProfileEditor({
    isOpen,
    schema,
    defaults,
}: {
    isOpen: boolean;
    schema: RendererSchema | null | undefined;
    defaults: Record<string, unknown> | null | undefined;
}) {
    const [selected, setSelected] = useState<string | null>(null);
    const [overrides, setOverrides] = useState<ChallengeValues>({});
    // What the selected profile held at the last seed: the baseline isDirty()
    // reads. Null until a profile is picked — nothing can differ from nothing.
    const baselineRef = useRef<ChallengeValues | null>(null);
    // Set by discard before its fresh read goes out: the one reseed that may
    // land over a dirty draft, since throwing that draft away is its point.
    const forceReseedRef = useRef(false);
    // Each save call's id: the newest one owns the `saving` flag, so a stale
    // call settling late cannot clear a newer save's flag.
    const saveIdRef = useRef(0);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(false);
    const [savedNote, setSavedNote] = useState(false);
    // Whether at least one read has settled this session: the section keeps
    // the editor mounted during later refetches, so only the first load shows
    // the spinner.
    const [loadedOnce, setLoadedOnce] = useState(false);

    // Read at a settled load's and a save's call time, not render time: the
    // callbacks below stay referentially stable across edits and loads.
    const selectedRef = useLatestRef(selected);
    const overridesRef = useLatestRef(overrides);
    const isOpenRef = useLatestRef(isOpen);

    useEffect(() => {
        if (!isOpen) {
            // The tab reopens on nothing selected; the in-flight read, if any,
            // is dropped by the query (latestOnly) and reseeded nothing.
            setSelected(null);
            setOverrides({});
            baselineRef.current = null;
            setSaving(false);
            setSaveError(false);
            setSavedNote(false);
            setLoadedOnce(false);
        }
    }, [isOpen]);

    const reseed = useCallback((values: ChallengeValues | undefined) => {
        const seeded = values && typeof values === 'object' ? { ...values } : {};
        setOverrides(seeded);
        baselineRef.current = seeded;
    }, []);

    const isDirty = useCallback(
        () => baselineRef.current !== null && !valuesEqual(overridesRef.current, baselineRef.current),
        [overridesRef],
    );

    const apply = useCallback(
        async (result: StoredProfiles | null, { setData, setError }: IpcQueryTools<StoredProfiles, Error>) => {
            setLoadedOnce(true);
            // A null resolution is the handler's failure fallback, not an empty
            // store — a failed load leaves the tab on its alert, not on an
            // editable (and savable) empty list.
            if (!result || typeof result !== 'object') {
                await ipc.logRendererError('Error loading challenge profiles: the read answered nothing');
                setError(new Error('challenge profiles read failed'));
                return;
            }
            setData(result);
            // A settled read reseeds only while the form is clean (the
            // open-load, or a read landing before any edit); Discard's fresh
            // read forces the reseed over a dirty draft — throwing that draft
            // away is its point.
            const forced = forceReseedRef.current;
            forceReseedRef.current = false;
            if (forced || !isDirty()) reseed(result[selectedRef.current ?? '']);
        },
        [isDirty, reseed, selectedRef],
    );

    const {
        data: profiles,
        setData: setProfiles,
        loading,
        error,
        refetch,
    } = useIpcQuery(fetchProfiles, { initialData: {} as StoredProfiles, enabled: isOpen, latestOnly: true, apply });
    const loadFailed = error !== null;

    const selectProfile = useCallback(
        (name: string) => {
            setSelected(name);
            // Whatever the last profile's save left on screen is not this one's
            // status.
            setSaveError(false);
            setSavedNote(false);
            reseed(profiles[name]);
        },
        [profiles, reseed],
    );

    // The on-only keys' `false` is stored nowhere but a challenge's own
    // override (the profile sanitizer drops it), so setting one "off" here
    // clears the key instead of writing a `false` that would vanish on save.
    const changeOverride = useCallback<SettingChangeHandler>((key, value) => {
        // An edit after a landed save retires its note.
        setSavedNote(false);
        setOverrides((prev) => {
            if (value === false && ON_ONLY_KEYS.includes(key)) {
                const next = { ...prev };
                delete next[key];
                return next;
            }
            return { ...prev, [key]: value };
        });
    }, []);

    const clearOverride = useCallback<SettingResetHandler>((key) => {
        setSavedNote(false);
        setOverrides((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }, []);

    const inheritedOf = useCallback(
        (key: string) => {
            if (schema?.[key]?.challengeOnly) return schema[key]?.default;
            return defaults?.[key] ?? schema?.[key]?.default;
        },
        [schema, defaults],
    );
    const effectiveOf = useCallback(
        (key: string) => (key in overrides ? overrides[key] : inheritedOf(key)),
        [overrides, inheritedOf],
    );

    const discard = useCallback(async () => {
        setSaveError(false);
        setSavedNote(false);
        // A fresh read, not the copy already in state — and the one read that
        // may reseed over a dirty draft (apply's guard reads the flag).
        forceReseedRef.current = true;
        await refetch();
    }, [refetch]);

    const save = useCallback(async (): Promise<boolean> => {
        const name = selectedRef.current;
        if (!name) return false;
        // One copy of what this save sends: an edit made while the write is
        // out belongs to the next save, not to this one's baseline.
        const values = { ...overridesRef.current };
        const id = ++saveIdRef.current;
        setSaving(true);
        setSaveError(false);
        setSavedNote(false);
        try {
            const saved = await ipc.saveChallengeProfile(name, values);
            // The answer applies only while this open session still edits the
            // same profile: a save that resolves after a switch or a close
            // names a draft nobody holds, and an edit made while the write was
            // out stays dirty above the sent baseline.
            if (selectedRef.current === name && isOpenRef.current) {
                if (saved !== true) {
                    setSaveError(true);
                    return false;
                }
                baselineRef.current = values;
                // The copy this tab edits from (the counts, a later switch)
                // shows what was just sent, not a later edit.
                setProfiles((prev) => ({ ...prev, [name]: values }));
                setSavedNote(true);
                return true;
            }
            return false;
        } catch (err) {
            // Always logged; the flag applies only while this open session
            // still edits the same profile, like the refusal above.
            await ipc.logRendererError(`Error saving challenge profile: ${errorMessage(err) || err}`);
            if (selectedRef.current === name && isOpenRef.current) setSaveError(true);
            return false;
        } finally {
            if (saveIdRef.current === id) setSaving(false);
        }
    }, [isOpenRef, saveIdRef, selectedRef, overridesRef, setProfiles]);

    return {
        profiles,
        selected,
        selectProfile,
        overrides,
        changeOverride,
        clearOverride,
        effectiveOf,
        inheritedOf,
        ruleSourceOf,
        profileValues: NO_PROFILE_VALUES,
        isDirty,
        loading,
        loadFailed,
        loadedOnce,
        saving,
        saveError,
        savedNote,
        save,
        discard,
    };
}
