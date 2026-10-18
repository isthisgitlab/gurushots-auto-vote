import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as ipc from '@/api/ipc';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { useDocumentTheme } from '@/hooks/useDocumentTheme';
import { useLogStream } from '@/hooks/useLogStream';
import { LogsNavbar } from '@/components/logs/LogsNavbar';
import { LogViewerBody } from '@/components/logs/LogViewerBody';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { isPlainObject } from '../../plainObject';

/**
 * Logs page content component
 */
function LogsPageContent() {
    const { ready, t } = useTranslation();
    const { entries, connected } = useLogStream();

    // The window reads only `language` and `theme` (logsWindowSettingKeys): the theme on load, then live from the
    // settings-changed payload, whose `app` block carries just those two for this window.
    const [theme, setTheme] = useState<string | null>(null);
    useEffect(() => {
        let current = true;
        void ipc
            .callOrNull(() => ipc.getSetting('theme'))
            .then((saved) => {
                if (current && typeof saved === 'string') setTheme(saved);
            });
        const off = ipc.onSettingsChanged((changed: unknown) => {
            if (isPlainObject(changed) && isPlainObject(changed.app) && typeof changed.app.theme === 'string') {
                setTheme(changed.app.theme);
            }
        });
        return () => {
            current = false;
            off?.();
        };
    }, []);
    useDocumentTheme(theme);

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
