/**
 * Color mapping for log levels
 */
const LEVEL_COLORS = {
    'INFO': 'text-blue-400',
    'SUCCESS': 'text-green-400',
    'WARNING': 'text-yellow-400',
    'ERROR': 'text-red-400',
    'DEBUG': 'text-gray-400',
    'API': 'text-cyan-400',
    'PROGRESS': 'text-purple-400',
};

/**
 * Escape HTML to prevent XSS
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Single log entry component
 * Displays formatted log message with color-coded level
 */
export function LogEntry({ entry }) {
    const { level, message, context, timestamp, category } = entry;
    const levelColor = LEVEL_COLORS[level] || 'text-green-400';

    return (
        <div className="log-entry whitespace-pre-wrap break-words">
            <span className="text-cyan-400">[{context || 'APP'}]</span>
            {' '}
            <span className="text-gray-400">[{timestamp}]</span>
            {' '}
            <span className={levelColor}>[{level}]</span>
            {' '}
            {category && (
                <>
                    <span className="text-yellow-400">[{category}]</span>
                    {' '}
                </>
            )}
            <span className="text-white">{escapeHtml(message)}</span>
        </div>
    );
}

/**
 * Empty state when no logs are present
 */
export function LogsEmptyState({ text = 'Waiting for log messages...' }) {
    return (
        <div className="text-gray-500 text-center py-8">
            {text}
        </div>
    );
}
