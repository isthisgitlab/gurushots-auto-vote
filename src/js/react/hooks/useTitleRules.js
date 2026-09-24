import { useState, useEffect, useCallback } from 'react';
import { useSessionLoad } from './useSessionLoad';

const fetchTitleRules = () => Promise.all([window.api.getTitleRules(), window.api.getChallengeProfiles()]);

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
 */
export function useTitleRules(isOpen) {
    const [rules, setRules] = useState([]);
    const [profiles, setProfiles] = useState({});
    const [error, setError] = useState(false);

    const onLoad = useCallback(([saved, savedProfiles]) => {
        setRules(Array.isArray(saved) ? saved : []);
        setProfiles(savedProfiles && typeof savedProfiles === 'object' ? savedProfiles : {});
    }, []);
    const { loading, loadFailed } = useSessionLoad(fetchTitleRules, {
        enabled: isOpen,
        onLoad,
        failureLog: 'Error loading title rules',
    });
    const loaded = !loading && !loadFailed;

    useEffect(() => {
        if (isOpen) setError(false);
    }, [isOpen]);

    const change = (next) => {
        if (error) setError(false);
        setRules(next);
    };

    const persist = useCallback(async () => {
        if (loaded) {
            const saved = await window.api.setTitleRules(rules);
            if (saved === false) {
                setError(true);
                return false;
            }
        }
        setError(false);
        return true;
    }, [loaded, rules]);

    return { rules, profiles, error, loadFailed, change, persist };
}
