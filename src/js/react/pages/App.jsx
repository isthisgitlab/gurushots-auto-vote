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

    // Handle challenge settings click
    const handleChallengeSettingsClick = useCallback((challengeId, challengeTitle) => {
        setSelectedChallenge({ id: challengeId, title: challengeTitle });
        setChallengeSettingsOpen(true);
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
                <SettingsModal isOpen={settingsModalOpen} onClose={() => setSettingsModalOpen(false)} />

                {/* Challenge Settings Modal */}
                <ChallengeSettingsModal
                    isOpen={challengeSettingsOpen}
                    onClose={() => {
                        setChallengeSettingsOpen(false);
                        setSelectedChallenge({ id: null, title: '' });
                    }}
                    challengeId={selectedChallenge.id}
                    challengeTitle={selectedChallenge.title}
                />

                {/* Update Dialog */}
                <UpdateDialog />
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
    const [autovoteRunning, setAutovoteRunning] = useState(false);

    // Sync with window.autovoteRunning
    useEffect(() => {
        const checkAutovoteStatus = () => {
            setAutovoteRunning(window.autovoteRunning || false);
        };

        // Check periodically
        const interval = setInterval(checkAutovoteStatus, 1000);
        return () => clearInterval(interval);
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

// Mount the React app
const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}

export default App;
