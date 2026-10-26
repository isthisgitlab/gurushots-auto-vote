import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionLoad } from './useSessionLoad';
import { useLatestRef } from './useLatestRef';
import * as ipc from '@/api/ipc';
import { valuesEqual } from '@/utils/valuesEqual';
import { normalizeProfileName } from '@/utils/profileName';
import { isPlainObject } from '../../plainObject';
import { errorMessage } from '../../errorMessage';

import type { ChallengeValues, TitleRule } from '../../types/settings';

const fetchTitleRules = () => Promise.all([ipc.getTitleRules(), ipc.getChallengeProfiles()]);

/**
 * Editor state for the challenge (title-tag) rules section of the global
 * settings modal: the rules list and the named profiles a rule may reference,
 * both loaded on every open (a load still in flight when the modal closes is
 * dropped).
 *
 * While open the hook also follows settings-changed broadcasts (a profile
 * saved or deleted in the neighbouring tab, or a write from another window,
 * tab or the CLI, all reach this window too): a broadcast runs one background
 * refresh of rules + profiles. A clean editor takes the fresh rules
 * wholesale; a dirty draft keeps its edits and only reconciles its rules'
 * profile names the way disk did — a name matching a fresh profile
 * case-insensitively takes that profile's exact spelling, a name with no
 * profile left drops the field. The hook does not use useSessionLoad /
 * useIpcQuery's `subscribe` for this: a background failure there would set
 * `loadFailed` (replacing the editor with an alert) and its `onLoad` would
 * overwrite a dirty draft.
 *
 * `persist()` writes the rules and resolves `true` when the write landed (or
 * was skipped), `false` when validation rejected it — `error` is then set so
 * the modal can stay open with the edit intact. The write is skipped unless
 * this open's load succeeded, else a failed load could overwrite saved rules
 * with the empty default; `loadFailed` is then set so the editor is replaced
 * by an alert rather than accepting edits that would be dropped. `change(next)`
 * clears a stale error as the user edits.
 *
 * `isDirty()` says whether the rules differ from what is on disk as far as this session knows: the
 * rules as loaded, moved forward by every `persist()` that landed. It is false while the load runs or
 * after it failed (there is no baseline to differ from).
 */
export function useTitleRules(isOpen: boolean) {
    const [rules, setRules] = useState<TitleRule[]>([]);
    const [profiles, setProfiles] = useState<Record<string, ChallengeValues>>({});
    const [error, setError] = useState(false);

    const savedRulesRef = useRef<TitleRule[] | null>(null);
    // Each refresh call's generation: a refresh applies only while it is the
    // latest, so one started before a `persist()` (or before the modal closed)
    // cannot put pre-save or pre-close rules back.
    const refreshIdRef = useRef(0);
    // A broadcast that arrived while this open's load was still running: the
    // result the load will apply predates it, so one refresh runs once the
    // load lands.
    const missedWhileLoadingRef = useRef(false);
    // Whether this open's load has applied its result — set the moment onLoad
    // runs, not when the loading state renders, so a broadcast landing in
    // between refreshes instead of being remembered for a load that already
    // applied. It describes the current load only: useSessionLoad re-keys on
    // the module-level `fetchTitleRules` and `isOpen`, so no new load can
    // start inside one open — a reopen's cleanup below resets it.
    const loadAppliedRef = useRef(false);

    // Read at refresh time, not render time: the refresh is referentially
    // stable across edits.
    const rulesRef = useLatestRef(rules);

    /**
     * One background refresh: re-read rules + profiles and apply them unless a
     * newer generation (another refresh, a `persist()`, or a close) superseded
     * this call. `clearsError` is false for the refresh `persist()` runs after
     * its own write — that one never clears the error a rejected write just
     * set, or Save would look like it did nothing.
     */
    const runRefresh = useCallback(
        async (clearsError: boolean) => {
            const callId = ++refreshIdRef.current;
            let fresh: Awaited<ReturnType<typeof fetchTitleRules>>;
            try {
                fresh = await fetchTitleRules();
            } catch (reason) {
                if (callId !== refreshIdRef.current) return;
                await ipc.logRendererError(`Error refreshing title rules: ${errorMessage(reason) || reason}`);
                return;
            }
            if (callId !== refreshIdRef.current) return;
            const [freshRules, freshProfiles] = fresh;
            // The main side answers null on a read error instead of rejecting —
            // that is a failed refresh, never coerced to []/{} the way the initial
            // load's onLoad does, which would strip every profile from a draft or
            // wipe a clean editor's rules onto the next Save.
            if (!Array.isArray(freshRules) || !isPlainObject(freshProfiles)) {
                await ipc.logRendererError('Error refreshing title rules: unexpected payload');
                return;
            }
            const before = rulesRef.current;
            // Dirty is judged against the baseline: a clean editor takes the fresh
            // rules wholesale, a dirty draft keeps its edits and only reconciles
            // its profile names against the fresh profiles, the way disk did.
            let after: TitleRule[];
            if (valuesEqual(before, savedRulesRef.current)) {
                after = freshRules;
            } else {
                const reconciled = before.map((rule) => {
                    // '' is the select's "None": no profile to reconcile, and a
                    // field the sanitizer drops anyway — never rewrite the draft.
                    if (typeof rule.profile !== 'string' || rule.profile === '') return rule;
                    const match = Object.keys(freshProfiles).find(
                        (name) => normalizeProfileName(name) === normalizeProfileName(rule.profile),
                    );
                    if (match === rule.profile) return rule;
                    if (match !== undefined) return { ...rule, profile: match };
                    // No profile left under any spelling: the field goes (the
                    // rule keeps its tags/overrides; setTitleRules drops a rule
                    // left with no effect).
                    const rest: TitleRule = { ...rule };
                    delete rest.profile;
                    return rest;
                });
                // A reconcile that touched nothing keeps the draft array itself.
                after = reconciled.every((rule, index) => rule === before[index]) ? before : reconciled;
            }
            setProfiles(freshProfiles);
            setRules(after);
            // The baseline always says "what is on disk".
            savedRulesRef.current = freshRules;
            // A refresh that leaves a rejected draft unchanged keeps its error.
            if (clearsError && !valuesEqual(before, after)) setError(false);
        },
        [rulesRef],
    );

    const onLoad = useCallback(
        ([saved, savedProfiles]: [TitleRule[] | null, Record<string, ChallengeValues> | null]) => {
            const loadedRules = Array.isArray(saved) ? saved : [];
            setRules(loadedRules);
            savedRulesRef.current = loadedRules;
            setProfiles(savedProfiles && typeof savedProfiles === 'object' ? savedProfiles : {});
            // From here a broadcast refreshes directly; before it, one is
            // remembered. One that already arrived while the load ran means
            // the seed above predates it: one refresh (several broadcasts
            // still mean one).
            loadAppliedRef.current = true;
            if (missedWhileLoadingRef.current) {
                missedWhileLoadingRef.current = false;
                void runRefresh(true);
            }
        },
        [runRefresh],
    );
    const { loading, loadFailed } = useSessionLoad(fetchTitleRules, {
        enabled: isOpen,
        onLoad,
        failureLog: 'Error loading title rules',
    });
    const loaded = !loading && !loadFailed;
    // Read at broadcast time, not subscribe time: the callback below decides
    // on the load's outcome.
    const loadFailedRef = useLatestRef(loadFailed);

    useEffect(() => {
        if (isOpen) setError(false);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return undefined;
        const off = ipc.onSettingsChanged(() => {
            // After a failed load the editor is replaced by the alert; nothing
            // here refreshes it.
            if (loadFailedRef.current) return;
            // Before this open's load has applied its result, that result
            // will predate the broadcast: one refresh once it lands.
            if (!loadAppliedRef.current) {
                missedWhileLoadingRef.current = true;
                return;
            }
            void runRefresh(true);
        });
        return () => {
            if (typeof off === 'function') off();
            // A refresh from one open never lands in a later open, and a
            // broadcast it missed is never consumed there.
            refreshIdRef.current += 1;
            missedWhileLoadingRef.current = false;
            loadAppliedRef.current = false;
        };
    }, [isOpen, runRefresh, loadFailedRef]);

    const change = (next: TitleRule[]) => {
        if (error) setError(false);
        setRules(next);
    };

    const persist = useCallback(async () => {
        // A refresh already in flight must not put pre-save rules back over
        // this save's result.
        refreshIdRef.current += 1;
        if (loaded) {
            const saved = await ipc.setTitleRules(rules);
            if (saved === false) {
                setError(true);
                // Load-bearing trailing refresh: this write's own broadcast is
                // sent inside the handler, so on Capacitor it reaches this
                // window before the call returns and its refresh applies
                // during this await. The trailing one runs after the write has
                // settled — landed or rejected — restoring the sanitized disk
                // rules as the baseline and reconciling the draft after a
                // rejection, without ever clearing the error that rejection
                // just set (the next Save sends the reconciled draft). A later
                // broadcast only adds one more refresh with the same result.
                await runRefresh(false);
                return false;
            }
            savedRulesRef.current = rules;
            await runRefresh(false);
            setError(false);
            return true;
        }
        setError(false);
        return true;
    }, [loaded, rules, runRefresh]);

    const isDirty = () => loaded && savedRulesRef.current !== null && !valuesEqual(rules, savedRulesRef.current);

    return { rules, profiles, error, loading, loadFailed, change, persist, isDirty };
}
