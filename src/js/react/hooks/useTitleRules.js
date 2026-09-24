import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Editor state for the challenge (title-tag) rules section of the global
 * settings modal: the rules list and the named profiles a rule may reference,
 * both loaded on every open.
 *
 * `persist()` writes the rules and resolves `true` when the write landed (or
 * was skipped), `false` when validation rejected it — `error` is then set so
 * the modal can stay open with the edit intact. The write is skipped when the
 * initial load failed, else a failed load could overwrite saved rules with the
 * empty default; `loadFailed` is then set so the editor is replaced by an alert
 * rather than accepting edits that would be dropped. `change(next)` clears a
 * stale error as the user edits.
 */
export function useTitleRules(isOpen) {
    const [rules, setRules] = useState([]);
    const [profiles, setProfiles] = useState({});
    const [error, setError] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const loadedRef = useRef(false);

    useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        loadedRef.current = false;
        setError(false);
        setLoadFailed(false);
        Promise.all([window.api.getTitleRules(), window.api.getChallengeProfiles()])
            .then(([saved, savedProfiles]) => {
                if (cancelled) return;
                setRules(Array.isArray(saved) ? saved : []);
                setProfiles(savedProfiles && typeof savedProfiles === 'object' ? savedProfiles : {});
                loadedRef.current = true;
            })
            .catch(async (err) => {
                if (cancelled) return;
                setLoadFailed(true);
                await window.api.logError(`Error loading title rules: ${err?.message || err}`);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    const change = (next) => {
        if (error) setError(false);
        setRules(next);
    };

    const persist = useCallback(async () => {
        if (loadedRef.current) {
            const saved = await window.api.setTitleRules(rules);
            if (saved === false) {
                setError(true);
                return false;
            }
        }
        setError(false);
        return true;
    }, [rules]);

    return { rules, profiles, error, loadFailed, change, persist };
}
