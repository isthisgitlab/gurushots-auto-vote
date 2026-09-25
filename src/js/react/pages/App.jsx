import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { TranslationProvider, useTranslation } from '@/contexts/TranslationContext';
import { ChallengesProvider, useChallenges } from '@/contexts/ChallengesContext';
import { AutovoteProvider, useAutovote } from '@/contexts/AutovoteContext';
import { UpdateProvider } from '@/contexts/UpdateContext';
import { useSettings } from '@/api/useSettings';
import { useBankroll } from '@/api/useBankroll';
import { useAutoJoinActive } from '@/api/useAutoJoinActive';
import { useAutoClaimStatus } from '@/api/useAutoClaimStatus';
import { Navbar } from '@/components/layout/Navbar';
import { AutoVoteControls } from '@/components/app/AutoVoteControls';
import { StatusHeader } from '@/components/app/StatusHeader';
import { DiscoverSection } from '@/components/app/DiscoverSection';
import { ChallengesSection } from '@/components/app/ChallengesSection';
import { SettingsModal } from '@/components/app/SettingsModal';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { LogsModal } from '@/components/app/LogsModal';
import { UpdateDialog } from '@/components/app/UpdateDialog';
import { WelcomeModal } from '@/components/app/WelcomeModal';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ScrollToTopButton } from '@/components/ui/ScrollToTopButton';
import { useDisclosure } from '@/hooks/useDisclosure';
import { useDocumentTheme } from '@/hooks/useDocumentTheme';
import { DEFAULT_TIMEZONE } from '../../settings/uiDefaults';
import * as ipc from '@/api/ipc';

const NO_CHALLENGE = { id: null, title: '' };

/**
 * Show the first-run welcome once per launch until dismissed. A ref (not
 * settings state) gates it: a failed persist triggers a settings refetch that
 * re-runs the effect with the flag still false, and without the ref that would
 * reopen the modal mid-session. Persisted via the settings facade so it stays
 * dismissed across launches/platforms.
 */
function useWelcomeGate(settings, settingsLoading, updateSetting) {
    const [welcomeOpen, setWelcomeOpen] = useState(false);
    const welcomeHandledRef = useRef(false);
    const settingsReady = !settingsLoading && Boolean(settings);
    const onboardingCompleted = settings?.onboardingCompleted;
    useEffect(() => {
        if (welcomeHandledRef.current) return;
        if (settingsReady && !onboardingCompleted) {
            welcomeHandledRef.current = true;
            setWelcomeOpen(true);
        }
    }, [settingsReady, onboardingCompleted]);

    const handleWelcomeClose = useCallback(async () => {
        setWelcomeOpen(false);
        try {
            await updateSetting('onboardingCompleted', true);
        } catch (err) {
            // Won't reappear this session (ref-gated); log so a persistent
            // write failure (e.g. Android storage I/O) stays diagnosable.
            await ipc.logRendererError(`Failed to persist onboardingCompleted: ${err?.message || err}`);
        }
    }, [updateSetting]);

    return { welcomeOpen, handleWelcomeClose };
}

/**
 * Which challenge the per-challenge settings modal is open for.
 */
function useChallengeSettingsTarget(challenges) {
    const [isOpen, setIsOpen] = useState(false);
    const [selected, setSelected] = useState(NO_CHALLENGE);

    // Live challenge object backing the modal. Resolved from the context (not
    // snapshotted) so its applicability hints re-render as the challenge
    // auto-refreshes — a freed entry slot re-enables Auto Fill without
    // reopening.
    const selectedChallenge = useMemo(
        () => challenges.find((c) => String(c.id) === String(selected.id)) ?? null,
        [challenges, selected.id],
    );

    // Skip when the modal is already open for the same challenge so rapid taps
    // don't churn parent state and re-thrash the modal's effects (rapid clicks
    // could produce a blank page when the in-flight load raced the
    // re-render). No refetch on open: challenge state is tick-driven (60s
    // auto-refresh) and selectedChallenge is derived live from that context,
    // so the modal's applicability hints stay current without an imperative
    // fetch.
    const open = useCallback(
        (challengeId, challengeTitle) => {
            if (isOpen && selected.id === challengeId) return;
            setSelected({ id: challengeId, title: challengeTitle });
            setIsOpen(true);
        },
        [isOpen, selected.id],
    );

    const close = useCallback(() => {
        setIsOpen(false);
        setSelected(NO_CHALLENGE);
    }, []);

    return { isOpen, selected, selectedChallenge, open, close };
}

/**
 * The app's modals and dialogs, each isolated in its own ErrorBoundary.
 */
function AppModals({ settingsModal, challengeSettings, logsModal, welcomeOpen, onWelcomeClose }) {
    return (
        <>
            {/* Settings Modal */}
            <ErrorBoundary>
                <SettingsModal isOpen={settingsModal.isOpen} onClose={settingsModal.close} />
            </ErrorBoundary>

            {/* Challenge Settings Modal — keyed by challenge id so a
                challenge change forces a fresh modal instance with no
                carry-over state from a previous open. */}
            <ErrorBoundary>
                <ChallengeSettingsModal
                    key={challengeSettings.selected.id ?? 'closed'}
                    isOpen={challengeSettings.isOpen}
                    onClose={challengeSettings.close}
                    challengeId={challengeSettings.selected.id}
                    challengeTitle={challengeSettings.selected.title}
                    challenge={challengeSettings.selectedChallenge}
                />
            </ErrorBoundary>

            {/* In-app Logs viewer (Android; Electron uses the menu window) */}
            <ErrorBoundary>
                <LogsModal isOpen={logsModal.isOpen} onClose={logsModal.close} />
            </ErrorBoundary>

            {/* Update Dialog */}
            <UpdateDialog />

            {/* First-run onboarding */}
            <ErrorBoundary>
                <WelcomeModal isOpen={welcomeOpen} onClose={onWelcomeClose} />
            </ErrorBoundary>
        </>
    );
}

/**
 * Main app content (inside all providers)
 */
function AppContent() {
    const { ready, t } = useTranslation();
    const { settings, loading: settingsLoading, updateSetting } = useSettings();
    const { challenges, refetch: refetchChallenges } = useChallenges();
    const { bankroll, refetch: refetchBankroll } = useBankroll();
    const { active: autoJoinActive } = useAutoJoinActive();
    const autovote = useAutovote();
    const autoClaimStatus = useAutoClaimStatus(autovote.nextRunAt, autovote.running);
    const settingsModal = useDisclosure();
    // In-app log viewer; the Navbar button is Capacitor-gated.
    const logsModal = useDisclosure();
    const challengeSettings = useChallengeSettingsTarget(challenges);
    const { welcomeOpen, handleWelcomeClose } = useWelcomeGate(settings, settingsLoading, updateSetting);

    useDocumentTheme(settings?.theme);

    // After a join changes state, refresh balances + the active-challenge list.
    const handleJoined = useCallback(() => {
        refetchBankroll();
        refetchChallenges();
    }, [refetchBankroll, refetchChallenges]);

    // An autovote cycle can spend or earn currency (auto-join, turbos, key
    // unlocks, fills, reward claims), but only the challenge list is refreshed
    // by the provider — re-read the balances after every completed cycle too,
    // or the header bankroll stays frozen at its mount-time value.
    useEffect(() => {
        if (autovote.cycles > 0) refetchBankroll();
    }, [autovote.cycles, refetchBankroll]);

    const handleLogout = useCallback(async () => {
        try {
            // Stop autovote if running
            if (autovote.running) {
                await autovote.stop();
            }
            await ipc.logout();
        } catch (err) {
            await ipc.logRendererError(`Error during logout: ${err.message || err}`);
        }
    }, [autovote]);

    const handleAutovoteToggle = useCallback(async () => {
        await autovote.toggle();
    }, [autovote]);

    // Show loading while initializing
    if (!ready || settingsLoading) {
        return <PageLoader text={t('common.loading')} />;
    }

    const timezone = settings?.timezone || DEFAULT_TIMEZONE;
    const isMock = settings?.mock || false;
    const isLoggedIn = !!settings?.token;

    return (
        <div className="min-h-screen bg-base-200">
            <div className="container mx-auto px-4 py-4 max-w-4xl">
                <ErrorBoundary>
                    {/* Navbar */}
                    <Navbar
                        isMock={isMock}
                        onLogsClick={logsModal.open}
                        onSettingsClick={settingsModal.open}
                        onLogout={handleLogout}
                    />

                    {/* Autovote Controls */}
                    <AutoVoteControls
                        running={autovote.running}
                        status={autovote.status}
                        statusClass={autovote.statusClass}
                        lastRun={autovote.lastRun}
                        cycles={autovote.cycles}
                        onToggle={handleAutovoteToggle}
                        autoJoinActive={autoJoinActive}
                    />

                    {/* At-a-glance status summary — counts + next-action countdown + bankroll */}
                    <StatusHeader
                        challenges={challenges}
                        nextRunAt={autovote.nextRunAt}
                        running={autovote.running}
                        bankroll={bankroll}
                        autoClaimStatus={autoClaimStatus}
                    />

                    {/* Challenges Section — the primary view (joined/active) */}
                    <ChallengesSection
                        timezone={timezone}
                        autovoteRunning={autovote.running}
                        autovoteCycles={autovote.cycles}
                        isLoggedIn={isLoggedIn}
                        onChallengeSettingsClick={challengeSettings.open}
                        bankroll={bankroll}
                        onBankrollChanged={refetchBankroll}
                    />

                    {/* Discover — un-joined challenges, collapsed below the main list */}
                    <ErrorBoundary>
                        <DiscoverSection isLoggedIn={isLoggedIn} bankroll={bankroll} onJoined={handleJoined} />
                    </ErrorBoundary>

                    <AppModals
                        settingsModal={settingsModal}
                        challengeSettings={challengeSettings}
                        logsModal={logsModal}
                        welcomeOpen={welcomeOpen}
                        onWelcomeClose={handleWelcomeClose}
                    />
                </ErrorBoundary>
            </div>

            {/* Back-to-top for the long challenges list */}
            <ScrollToTopButton />
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

    // AutovoteProvider dispatches 'autovote:running-changed' whenever its
    // state.running toggles, so we don't need to poll. The only event that
    // can fire before this listener attaches is AutovoteProvider's initial
    // running=false sync (child effects run before parent effects in the
    // same commit), which matches the initial state here; the auto-resume
    // path awaits IPC first, so its running=true event always lands after
    // the listener is attached.
    useEffect(() => {
        const handler = (e) => setAutovoteRunning(!!e.detail);
        window.addEventListener('autovote:running-changed', handler);
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
