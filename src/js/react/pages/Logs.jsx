import { createRoot } from 'react-dom/client';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { useLogStream } from '@/hooks/useLogStream';
import { LogsNavbar } from '@/components/logs/LogsNavbar';
import { LogEntry, LogsEmptyState } from '@/components/logs/LogEntry';
import { PageLoader } from '@/components/ui/LoadingSpinner';

/**
 * Logs page content component
 */
function LogsPageContent() {
    const { ready, t } = useTranslation();
    const { entries, connected } = useLogStream();

    // Show loading while translation manager initializes
    if (!ready) {
        return <PageLoader text={t('common.loading')} />;
    }

    return (
        <div className="min-h-screen bg-base-200">
            <LogsNavbar connected={connected} />

            <div className="container mx-auto p-6">
                <div className="card bg-base-100 shadow-md">
                    <div className="card-body p-4">
                        <div className="h-[600px] overflow-y-auto bg-gray-900 text-green-400 font-mono text-sm p-4 rounded-lg">
                            <div className="space-y-1">
                                {entries.length === 0 ? (
                                    <LogsEmptyState text={t('logs.waiting')} />
                                ) : (
                                    entries.map((entry, index) => (
                                        <LogEntry
                                            key={`${entry.timestamp}-${index}`}
                                            entry={entry}
                                        />
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * Logs page with providers
 */
function LogsPage() {
    return (
        <TranslationProvider>
            <LogsPageContent />
        </TranslationProvider>
    );
}

// Mount the React app
const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<LogsPage />);
}

export default LogsPage;
