import { createRoot } from 'react-dom/client';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { useLogStream } from '@/hooks/useLogStream';
import { LogsNavbar } from '@/components/logs/LogsNavbar';
import { LogViewerBody } from '@/components/logs/LogViewerBody';
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
                        <LogViewerBody entries={entries} heightClass="h-[600px]" />
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
