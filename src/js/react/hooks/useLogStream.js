import { useState, useEffect, useCallback, useRef } from 'react';

const MAX_ENTRIES = 1000;

/**
 * Hook for managing real-time log stream via IPC
 * @returns {{ entries: Array, connected: boolean, clear: function }}
 */
export function useLogStream() {
    const [entries, setEntries] = useState([]);
    const [connected, setConnected] = useState(false);
    const mountedRef = useRef(true);

    // Clear all log entries
    const clear = useCallback(() => {
        setEntries([]);
    }, []);

    useEffect(() => {
        mountedRef.current = true;

        async function connect() {
            try {
                const result = await window.api.startLogStream();

                if (result?.success && mountedRef.current) {
                    setConnected(true);

                    // Listen for log messages
                    window.api.onLogMessage((logData) => {
                        if (mountedRef.current) {
                            setEntries((prev) => {
                                // Add new entry at the beginning (newest first)
                                const next = [logData, ...prev];
                                // Limit to MAX_ENTRIES to prevent memory issues
                                return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
                            });
                        }
                    });
                }
            } catch {
                if (mountedRef.current) {
                    setConnected(false);
                }
            }
        }

        connect();

        // Cleanup on unmount
        return () => {
            mountedRef.current = false;
            if (window.api.stopLogStream) {
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
