import { useTranslation } from '@/contexts/TranslationContext';
import { LogEntry, LogsEmptyState } from '@/components/logs/LogEntry';

/**
 * Scrollable terminal-style log list shared by the Logs window page and
 * the in-app LogsModal. The two hosts only differ in the container
 * height (fixed 600px page vs 60vh modal), passed via `heightClass`.
 */
export function LogViewerBody({ entries, heightClass }) {
    const { t } = useTranslation();

    return (
        <div className={`${heightClass} overflow-y-auto bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-lg`}>
            <div className="space-y-1">
                {entries.length === 0 ? (
                    <LogsEmptyState text={t('logs.empty')} />
                ) : (
                    entries.map((entry, index) => <LogEntry key={`${entry.timestamp}-${index}`} entry={entry} />)
                )}
            </div>
        </div>
    );
}
