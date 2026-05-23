import { useTranslation } from '@/contexts/TranslationContext';
import { Modal } from '@/components/ui/Modal';
import { useLogStream } from '@/hooks/useLogStream';
import { LogEntry, LogsEmptyState } from '@/components/logs/LogEntry';
import { ConnectionBadge } from '@/components/ui/StatusBadge';

/**
 * Live log viewer body. Split out so useLogStream only subscribes while the
 * modal is open: Modal renders null when closed, so this never mounts (and
 * never holds a stream subscription / backlog) until the user opens the viewer.
 */
function LogsViewer() {
    const { t } = useTranslation();
    const { entries, connected } = useLogStream();

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-end gap-2">
                <span className="text-sm">{t('logs.status')}</span>
                <ConnectionBadge connected={connected} />
            </div>
            <div className="h-[60vh] overflow-y-auto bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-lg">
                <div className="space-y-1">
                    {entries.length === 0 ? (
                        <LogsEmptyState text={t('logs.empty')} />
                    ) : (
                        entries.map((entry, index) => <LogEntry key={`${entry.timestamp}-${index}`} entry={entry} />)
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * In-app log viewer. The dedicated Logs window only exists on Electron (opened
 * from the application menu). The Capacitor (Android) build has a single
 * WebView and no menu, so this modal gives it the same live log view. Reached
 * from the Navbar's Logs button, which is itself Capacitor-gated.
 */
export function LogsModal({ isOpen, onClose }) {
    const { t } = useTranslation();

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t('logs.title')} size="xl">
            <LogsViewer />
        </Modal>
    );
}
