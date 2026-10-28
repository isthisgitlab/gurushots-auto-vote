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
 * The draft's profile names reconciled the way disk did: a name matching a
 * fresh profile case-insensitively takes that profile's exact spelling, a
 * name with no profile left drops the field, and `''` — the select's "None",
 * a field the sanitizer drops anyway — is never rewritten. A draft rule
 * without a profile is untouched, and a reconcile that touched nothing
 * returns the draft array itself.
 */
const reconcileDraftProfiles = (draft: TitleRule[], freshProfiles: Record<string, ChallengeValues>): TitleRule[] => {
    const reconciled = draft.map((rule) => {
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
    return reconciled.every((rule, index) => rule === draft[index]) ? draft : reconciled;
};

/**
 * The settings-changed machinery behind `useTitleRules`: while `active`, every
 * broadcast runs one background refresh of rules + profiles, applied through
 * `apply` — a clean editor takes the fresh rules wholesale; a dirty draft
 * keeps its edits and only reconciles its rules' profile names the way disk
 * did. The hook does not use useSessionLoad / useIpcQuery's `subscribe` for
 * this: a background failure there would set `loadFailed` (replacing the
 * editor with an alert) and its `onLoad` would overwrite a dirty draft.
 *
 * A refresh applies only while it is the latest generation: another refresh,
 * `beginSave()` (a persist starting), or a close supersede it, so one started
 * before a save (or before the modal closed) cannot put pre-save or pre-close
 * rules back.
 *
 * `markLoadApplied` is called the moment the load applies — not when the
 * loading state renders — so a broadcast landing in between refreshes instead
 * of being remembered for a load that already applied. A broadcast before
 * that arms the missed flag: the load's result predates it, so one refresh
 * runs once `markLoadApplied` consumes it (several broadcasts still mean
 * one). After a failed load the flag never sets — the broadcast only arms it,
 * nothing reads it, and the cleanup clears it. The refs describe the current
 * load only: useSessionLoad re-keys on the module-level fetch and `active`,
 * so no new load can start inside one open — a reopen's cleanup resets them.
 */
function useSettingsChangedRefresh(
    active: boolean,
    apply: (freshRules: TitleRule[], freshProfiles: Record<string, ChallengeValues>) => void,
) {
    const refreshIdRef = useRef(0);
    const missedWhileLoadingRef = useRef(false);
    const loadAppliedRef = useRef(false);

    const runRefresh = useCallback(async () => {
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
        // The main side answers null on a read error instead of rejecting — that is a failed
        // refresh, never coerced to []/{} the way the initial load's onLoad does, which would
        // strip every profile from a draft or wipe a clean editor's rules onto the next Save.
        if (!Array.isArray(freshRules) || !isPlainObject(freshProfiles)) {
            await ipc.logRendererError('Error refreshing title rules: unexpected payload');
            return;
        }
        apply(freshRules, freshProfiles);
    }, [apply]);

    // The moment the load applies: a broadcast from here on refreshes
    // directly; one that already arrived while the load ran is consumed as
    // exactly one refresh.
    const markLoadApplied = useCallback(() => {
        loadAppliedRef.current = true;
        if (missedWhileLoadingRef.current) {
            missedWhileLoadingRef.current = false;
            void runRefresh();
        }
    }, [runRefresh]);

    // A persist starting: the generation advance that keeps an in-flight
    // refresh from putting pre-save rules back over this save's result.
    const beginSave = useCallback(() => {
        refreshIdRef.current += 1;
    }, []);

    useEffect(() => {
        if (!active) return undefined;
        const off = ipc.onSettingsChanged(() => {
            // Before the load has applied, its result will predate the
            // broadcast: one refresh once it lands (see markLoadApplied).
            if (!loadAppliedRef.current) {
                missedWhileLoadingRef.current = true;
                return;
            }
            void runRefresh();
        });
        return () => {
            if (typeof off === 'function') off();
            // A refresh from one open never lands in a later open, and a
            // broadcast it missed is never consumed there.
            refreshIdRef.current += 1;
            missedWhileLoadingRef.current = false;
            loadAppliedRef.current = false;
        };
    }, [active, runRefresh]);

    return { runRefresh, markLoadApplied, beginSave };
}

/**
 * Editor state for the challenge (title-tag) rules section of the global
 * settings modal: the rules list and the named profiles a rule may reference,
 * both loaded on every open (a load still in flight when the modal closes is
 * dropped), and — while open — one background refresh of rules + profiles per
 * settings-changed broadcast (see `useSettingsChangedRefresh`).
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
 * rules as loaded, moved forward by every `persist()` that landed and every applied refresh. It is
 * false while the load runs or after it failed (there is no baseline to differ from).
 */
export function useTitleRules(isOpen: boolean) {
    const [rules, setRules] = useState<TitleRule[]>([]);
    const [profiles, setProfiles] = useState<Record<string, ChallengeValues>>({});
    const [error, setError] = useState(false);

    const savedRulesRef = useRef<TitleRule[] | null>(null);
    // Read at refresh time, not render time: keeps the refresh referentially stable.
    const rulesRef = useLatestRef(rules);

    // Apply a refresh's read; the baseline always says "what is on disk".
    const applyFresh = useCallback(
        (freshRules: TitleRule[], freshProfiles: Record<string, ChallengeValues>) => {
            const before = rulesRef.current;
            setProfiles(freshProfiles);
            // A clean editor takes the fresh rules wholesale; a dirty draft keeps its edits and only
            // reconciles its profile names (see reconcileDraftProfiles).
            setRules(
                valuesEqual(before, savedRulesRef.current) ? freshRules : reconcileDraftProfiles(before, freshProfiles),
            );
            savedRulesRef.current = freshRules;
        },
        [rulesRef],
    );

    const { runRefresh, markLoadApplied, beginSave } = useSettingsChangedRefresh(isOpen, applyFresh);

    const onLoad = useCallback(
        ([saved, savedProfiles]: [TitleRule[] | null, Record<string, ChallengeValues> | null]) => {
            const loadedRules = Array.isArray(saved) ? saved : [];
            setRules(loadedRules);
            savedRulesRef.current = loadedRules;
            setProfiles(savedProfiles && typeof savedProfiles === 'object' ? savedProfiles : {});
            markLoadApplied();
        },
        [markLoadApplied],
    );
    const { loading, loadFailed } = useSessionLoad(fetchTitleRules, {
        enabled: isOpen,
        onLoad,
        failureLog: 'Error loading title rules',
    });
    const loaded = !loading && !loadFailed;

    useEffect(() => {
        if (isOpen) setError(false);
    }, [isOpen]);

    const change = (next: TitleRule[]) => {
        if (error) setError(false);
        setRules(next);
    };

    const persist = useCallback(async () => {
        beginSave();
        if (loaded) {
            const saved = await ipc.setTitleRules(rules);
            if (saved === false) {
                setError(true);
                // Fire-and-forget (runRefresh never rejects): Save must not wait one extra read
                // before it shows the refused tab. The trailing refresh reconciles the draft
                // against the disk rules once the write has settled; a refresh never changes
                // `error`, so the refusal's error stays on screen and the next Save sends the
                // reconciled draft.
                void runRefresh();
                return false;
            }
            savedRulesRef.current = rules;
            // Fire-and-forget (see the rejected branch). Load-bearing after a landed write too:
            // the write's own broadcast is sent inside the handler — on Capacitor it reaches this
            // window before the call returns, so this trailing refresh is what restores the
            // sanitized disk rules as the baseline. A later broadcast only adds one more refresh
            // with the same result; on close the cleanup drops it.
            void runRefresh();
            setError(false);
            return true;
        }
        setError(false);
        return true;
    }, [beginSave, loaded, rules, runRefresh]);

    const isDirty = () => loaded && savedRulesRef.current !== null && !valuesEqual(rules, savedRulesRef.current);

    return { rules, profiles, error, loading, loadFailed, change, persist, isDirty };
}
