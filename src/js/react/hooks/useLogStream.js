import { useState, useEffect, useCallback, useRef } from 'react';

const MAX_ENTRIES = 1000;

/**
 * Hook for managing real-time log stream via IPC.
 *
 * On mount we subscribe to live messages FIRST (into a small staging
 * buffer), then fetch the backlog. Once the backlog resolves we seed
 * `entries` newest-first, then merge in any live messages that landed
 * during the await — de-duped by monotonic `seq` so identical repeated
 * messages (turbo retries, mock loops) don't collide.
 *
 * @returns {{ entries: Array, connected: boolean, clear: function }}
 */
export function useLogStream() {
    const [entries, setEntries] = useState([]);
    const [connected, setConnected] = useState(false);
    const mountedRef = useRef(true);
    const unsubscribeRef = useRef(null);

    const clear = useCallback(() => {
        setEntries([]);
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        let seeded = false;
        let maxBacklogSeq = 0;
        const liveBuffer = [];

        const appendEntry = (logData) => {
            setEntries((prev) => {
                const next = [logData, ...prev];
                return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
            });
        };

        async function connect() {
            try {
                const result = await window.api?.startLogStream?.();
                if (!result?.success || !mountedRef.current) return;
                setConnected(true);

                const unsubscribe = window.api?.onLogMessage?.((logData) => {
                    if (!mountedRef.current) return;
                    if (!seeded) {
                        liveBuffer.push(logData);
                    } else {
                        appendEntry(logData);
                    }
                });
                if (typeof unsubscribe === 'function') {
                    unsubscribeRef.current = unsubscribe;
                }

                const backlog = (await window.api.getLogBacklog?.()) || [];
                if (!mountedRef.current) return;

                // Backlog is oldest→newest. Reverse so newest renders at top.
                const seededEntries = backlog.slice().reverse();
                maxBacklogSeq = backlog.reduce((max, e) => (e.seq > max ? e.seq : max), 0);

                // Drain anything that streamed in during the await.
                const carryover = liveBuffer.filter((e) => !e.seq || e.seq > maxBacklogSeq);
                const merged = [...carryover.reverse(), ...seededEntries].slice(0, MAX_ENTRIES);
                setEntries(merged);
                liveBuffer.length = 0;
                seeded = true;
            } catch {
                if (mountedRef.current) setConnected(false);
            }
        }

        void connect();

        return () => {
            mountedRef.current = false;
            if (typeof unsubscribeRef.current === 'function') {
                unsubscribeRef.current();
                unsubscribeRef.current = null;
            }
            if (window.api?.stopLogStream) {
                window.api.stopLogStream();
            }
        };
    }, []);

    return {
        entries,
        connected,
        clear,
        entryCount: entries.length,
    };
}
