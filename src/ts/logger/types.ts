export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * One ring-buffer entry (getRecentLogs). `data` is the sanitized copy.
 */
export type LogEntry = {
    seq: number;
    level: LogLevel;
    context: string;
    category: string;
    timestamp: string;
    message: string;
    data: unknown;
    /**
     * The catalog entry the message was rendered from: `key` is the log
     * catalogs' `m…` key, `params` the `{n}` slot values in order. Only the
     * T-methods set it; entries without one localize through the reverse
     * matcher.
     */
    template?: { key: string; params: unknown[] };
};

/**
 * The GUI fan-out payload; `timestamp` is the HH:MM:SS display time.
 */
export type GuiLogEntry = Omit<LogEntry, 'data'>;

export type GuiLogSink = (entry: GuiLogEntry) => void;
