/**
 * Severity → text color. Strict 4-value set matches logger.js.
 */
const LEVEL_COLORS = {
    DEBUG: 'text-gray-400',
    INFO: 'text-blue-400',
    WARN: 'text-yellow-400',
    ERROR: 'text-red-400',
};

/**
 * Single log entry. Three small badges then the message:
 *   [severity] [context] [category] message
 */
export function LogEntry({ entry }) {
    const { level, message, context, timestamp, category } = entry;
    const levelColor = LEVEL_COLORS[level] || 'text-green-400';

    return (
        <div className="log-entry whitespace-pre-wrap break-words">
            <span className="text-gray-400">[{timestamp}]</span>
            {' '}
            <span className={levelColor}>[{level}]</span>
            {' '}
            <span className="text-cyan-400">[{context || 'APP'}]</span>
            {' '}
            <span className="text-yellow-400">[{category || 'general'}]</span>
            {' '}
            {/* JSX text is escaped by the renderer; pre-escaping showed "&lt;" literally. */}
            <span className="text-white">{message}</span>
        </div>
    );
}

/**
 * Empty state when no logs are present
 */
export function LogsEmptyState({ text }) {
    return (
        <div className="text-gray-500 text-center py-8">
            {text}
        </div>
    );
}
