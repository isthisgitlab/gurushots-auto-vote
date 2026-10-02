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
};

/**
 * The GUI fan-out payload; `timestamp` is the HH:MM:SS display time.
 */
export type GuiLogEntry = Omit<LogEntry, 'data'>;

export type GuiLogSink = (entry: GuiLogEntry) => void;
