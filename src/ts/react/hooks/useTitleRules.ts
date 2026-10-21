import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionLoad } from './useSessionLoad';
import * as ipc from '@/api/ipc';
import { valuesEqual } from '@/utils/valuesEqual';

import type { ChallengeValues, TitleRule } from '../../types/settings';

const fetchTitleRules = () => Promise.all([ipc.getTitleRules(), ipc.getChallengeProfiles()]);

/**
 * Editor state for the challenge (title-tag) rules section of the global
 * settings modal: the rules list and the named profiles a rule may reference,
 * both loaded on every open (a load still in flight when the modal closes is
 * dropped).
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

    const onLoad = useCallback(
        ([saved, savedProfiles]: [TitleRule[] | null, Record<string, ChallengeValues> | null]) => {
            const loadedRules = Array.isArray(saved) ? saved : [];
            setRules(loadedRules);
            savedRulesRef.current = loadedRules;
            setProfiles(savedProfiles && typeof savedProfiles === 'object' ? savedProfiles : {});
        },
        [],
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
        if (loaded) {
            const saved = await ipc.setTitleRules(rules);
            if (saved === false) {
                setError(true);
                return false;
            }
            savedRulesRef.current = rules;
        }
        setError(false);
        return true;
    }, [loaded, rules]);

    const isDirty = () => loaded && savedRulesRef.current !== null && !valuesEqual(rules, savedRulesRef.current);

    return { rules, profiles, error, loading, loadFailed, change, persist, isDirty };
}
