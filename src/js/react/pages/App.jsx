import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { ChallengesProvider, useChallenges } from '@/contexts/ChallengesContext';
import { AutovoteProvider, useAutovote } from '@/contexts/AutovoteContext';
import { UpdateProvider } from '@/contexts/UpdateContext';
import { useSettings } from '@/api/useSettings';
import { Navbar } from '@/components/layout/Navbar';
import { AutoVoteControls } from '@/components/app/AutoVoteControls';
import { ChallengesSection } from '@/components/app/ChallengesSection';
import { SettingsModal } from '@/components/app/SettingsModal';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { UpdateDialog } from '@/components/app/UpdateDialog';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';

/**
 * Main app content (inside all providers)
 */
function AppContent() {
    const { ready, t } = useTranslation();
    const { settings, loading: settingsLoading } = useSettings();
    const autovote = useAutovote();

    // Local state
    const [settingsModalOpen, setSettingsModalOpen] = useState(false);
    const [challengeSettingsOpen, setChallengeSettingsOpen] = useState(false);
    const [selectedChallenge, setSelectedChallenge] = useState({ id: null, title: '' });

    // Apply theme
    useEffect(() => {
        if (settings?.theme) {
            document.documentElement.setAttribute('data-theme', settings.theme);
        }
    }, [settings?.theme]);

    // Handle logout
    const handleLogout = useCallback(async () => {
        try {
            // Stop autovote if running
            if (autovote.running) {
                await autovote.stop();
            }
            await window.api.logout();
        } catch (err) {
            await window.api.logError(`Error during logout: ${err.message || err}`);
        }
    }, [autovote]);

    // Handle settings click
    const handleSettingsClick = useCallback(() => {
        setSettingsModalOpen(true);
    }, []);

    // Handle challenge settings click. Skip when the modal is already
    // open for the same challenge so rapid taps don't churn parent state
    // and re-thrash the modal's effects (rapid clicks were producing a
    // blank page when the in-flight load raced the re-render).
    const handleChallengeSettingsClick = useCallback(
        (challengeId, challengeTitle) => {
            if (challengeSettingsOpen && selectedChallenge.id === challengeId) return;
            setSelectedChallenge({ id: challengeId, title: challengeTitle });
            setChallengeSettingsOpen(true);
        },
        [challengeSettingsOpen, selectedChallenge.id],
    );

    const handleChallengeSettingsClose = useCallback(() => {
        setChallengeSettingsOpen(false);
        setSelectedChallenge({ id: null, title: '' });
    }, []);

    const handleSettingsClose = useCallback(() => {
        setSettingsModalOpen(false);
    }, []);

    // Handle autovote toggle
    const handleAutovoteToggle = useCallback(async () => {
        await autovote.toggle();
    }, [autovote]);

    // Show loading while initializing
    if (!ready || settingsLoading) {
        return <PageLoader text={t('common.loading')} />;
    }

    const timezone = settings?.timezone || 'Europe/Riga';
    const isMock = settings?.mock || false;
    const isLoggedIn = !!settings?.token;

    return (
        <div className="min-h-screen bg-base-200">
            <div className="container mx-auto px-4 py-4 max-w-4xl">
                <ErrorBoundary>
                    {/* Navbar */}
                    <Navbar isMock={isMock} onSettingsClick={handleSettingsClick} onLogout={handleLogout} />

                    {/* Autovote Controls */}
                    <AutoVoteControls
                        running={autovote.running}
                        status={autovote.status}
                        statusClass={autovote.statusClass}
                        lastRun={autovote.lastRun}
                        cycles={autovote.cycles}
                        onToggle={handleAutovoteToggle}
                    />

                    {/* Challenges Section */}
                    <ChallengesSection
                        timezone={timezone}
                        autovoteRunning={autovote.running}
                        isLoggedIn={isLoggedIn}
                        onChallengeSettingsClick={handleChallengeSettingsClick}
                    />

                    {/* Settings Modal */}
                    <ErrorBoundary>
                        <SettingsModal isOpen={settingsModalOpen} onClose={handleSettingsClose} />
                    </ErrorBoundary>

                    {/* Challenge Settings Modal — keyed by challenge id so a
                        challenge change forces a fresh modal instance with no
                        carry-over state from a previous open. */}
                    <ErrorBoundary>
                        <ChallengeSettingsModal
                            key={selectedChallenge.id ?? 'closed'}
                            isOpen={challengeSettingsOpen}
                            onClose={handleChallengeSettingsClose}
                            challengeId={selectedChallenge.id}
                            challengeTitle={selectedChallenge.title}
                        />
                    </ErrorBoundary>

                    {/* Update Dialog */}
                    <UpdateDialog />
                </ErrorBoundary>
            </div>
        </div>
    );
}

/**
 * App with Autovote provider (needs challenges refetch callback)
 */
function AppWithAutovote() {
    const { refetch } = useChallenges();

    return (
        <AutovoteProvider onChallengesRefresh={refetch}>
            <AppContent />
        </AutovoteProvider>
    );
}

/**
 * App with Challenges provider
 */
function AppWithChallenges() {
    const [autovoteRunning, setAutovoteRunning] = useState(() => !!globalThis.window?.autovoteRunning);

    // AutovoteProvider dispatches 'autovote:running-changed' whenever its
    // state.running toggles, so we don't need to poll. After attaching
    // the listener, re-read window.autovoteRunning once to absorb any
    // event that may have fired between this component's render and
    // commit (the auto-resume path on launch is the realistic case).
    useEffect(() => {
        const handler = (e) => setAutovoteRunning(!!e.detail);
        window.addEventListener('autovote:running-changed', handler);
        setAutovoteRunning(!!window.autovoteRunning);
        return () => window.removeEventListener('autovote:running-changed', handler);
    }, []);

    return (
        <ChallengesProvider autovoteRunning={autovoteRunning}>
            <AppWithAutovote />
        </ChallengesProvider>
    );
}

/**
 * Main App component with all providers
 */
function App() {
    return (
        <TranslationProvider>
            <UpdateProvider>
                <AppWithChallenges />
            </UpdateProvider>
        </TranslationProvider>
    );
}

// Mount the React app at module load. The Capacitor entry sets
// __capacitorBootstrap before importing this module so it can defer
// mounting until after the bridge is installed and settings are
// hydrated; everywhere else (Electron) auto-mounts.
export const mountApp = () => {
    const container = document.getElementById('root');
    if (container) {
        const root = createRoot(container);
        root.render(<App />);
    }
};

// Deferred via queueMicrotask: ESM hoists Capacitor.jsx's static
// imports above its `globalThis.__capacitorBootstrap = true;` assignment,
// so a synchronous check at module load would see the flag undefined
// and double-mount on top of Login.jsx, breaking React's reconciler.
queueMicrotask(() => {
    if (!globalThis.__capacitorBootstrap) {
        mountApp();
    }
});

export default App;
