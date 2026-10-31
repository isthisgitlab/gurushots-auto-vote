import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAutovoteController } from '../../autovote/controller';
import { noopBackgroundHost } from './noopBackgroundHost';
import { createDeadlineNotifier, deliverElectronNotification } from '../notifications/deadlineNotifier';
import { createRendererScenarioNotifier } from '../notifications/scenarioNotifier';
import { useLatestRef } from '../hooks/useLatestRef';
import { rendererTranslator } from '../../translations/renderer';
import * as ipc from '../api/ipc';
import { isNativePlatform } from '../api/usePlatformCapabilities';
import { dateLocale } from '../utils/formatters';

import type { ComponentChildren } from 'preact';
import type { AutovoteController, AutovoteHost, BackgroundHost, CycleNotifier } from '../../autovote/controller';
import type { AutovoteState } from '../../autovote/state';

/**
 * What useAutovote returns: the state machine's state plus its controls.
 */
export type AutovoteContextValue = AutovoteState & {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    toggle: () => Promise<void>;
    rearmSchedule: () => Promise<void>;
};

const AutovoteContext = createContext<AutovoteContextValue | null>(null);

/**
 * Build the per-cycle OS notifier for this platform — deadline warnings plus
 * scenario notices — on Electron; `null` on native Android, where the native
 * foreground service is authoritative — so the notifier is NOT wired there at
 * all (that both avoids a dual-loop double-fire and the per-cycle IPC that
 * would only be discarded). See deadlineNotifier.ts header.
 */
function createRendererDeadlineNotifier(): CycleNotifier | null {
    // Native Android gets `null` — the native foreground service is authoritative there.
    const deliver = isNativePlatform() ? null : deliverElectronNotification;
    if (!deliver) return null;
    const shared = {
        getSetting: (key: string) => ipc.getGlobalDefault(key),
        // The core uses closures, no `this`, so the method passes unbound.
        translate: rendererTranslator.t,
        deliver,
        log: (msg: string) => ipc.logRendererDebug(msg),
    };
    const deadlines = createDeadlineNotifier({
        ...shared,
        getDeadlineActions: (challenge) => ipc.getDeadlineActions(challenge),
    });
    const scenarios = createRendererScenarioNotifier({
        ...shared,
        getScenarioStatus: (challengeId) => ipc.getScenarioStatus(challengeId),
    });
    // Both are self-contained and never throw.
    return (challenges, now) => Promise.all([deadlines(challenges, now), scenarios(challenges)]);
}

/**
 * Provider for the autovote state machine. A thin adapter over the autovote
 * controller (src/ts/autovote/controller.ts, which owns the renderer's
 * cadence chain): it builds the controller's host once per mount — the bridge
 * IPC, the page translator and locale formatting, the platform-picked
 * deadline notifier, and the injected background host — subscribes React to
 * the controller's state, and renders.
 */
export function AutovoteProvider({
    children,
    onChallengesRefresh,
    // Read once per mount, when the host is built: a prop identity change
    // later in the mount's life does not reach the controller.
    backgroundHost = noopBackgroundHost,
}: {
    children?: ComponentChildren;
    onChallengesRefresh?: () => unknown;
    backgroundHost?: BackgroundHost;
}) {
    // The controller reads the latest refresh identity on each use, so a new
    // identity never re-arms the chain.
    const refreshRef = useLatestRef(onChallengesRefresh);

    // Built once per mount. The deadline notifier is created once (a fresh
    // instance each render would never dedupe): it holds the fired-key Set +
    // re-entrancy guard across cycles.
    const hostRef = useRef<AutovoteHost | null>(null);
    if (hostRef.current === null) {
        hostRef.current = {
            runVotingCycle: ipc.runVotingCycle,
            getSettings: ipc.getSettings,
            getSetting: ipc.getSetting,
            getEffectiveSetting: ipc.getEffectiveSetting,
            getGlobalDefault: ipc.getGlobalDefault,
            getActiveChallenges: ipc.getActiveChallenges,
            getScenarioStatus: ipc.getScenarioStatus,
            setCancelVoting: ipc.setCancelVoting,
            setSetting: ipc.setSetting,
            getEnvironmentInfo: ipc.getEnvironmentInfo,
            callOrNull: ipc.callOrNull,
            logRendererDebug: ipc.logRendererDebug,
            logRendererWarning: ipc.logRendererWarning,
            logRendererError: ipc.logRendererError,
            setTimeout: (callback, ms) => setTimeout(callback, ms),
            clearTimeout: (handle) => clearTimeout(handle),
            background: backgroundHost,
            formatTime: (ms) => new Date(ms).toLocaleTimeString(dateLocale()),
            translate: rendererTranslator.t,
            notifier: createRendererDeadlineNotifier(),
            getOnChallengesRefresh: () => refreshRef.current,
        };
    }

    // One controller per mount, created during the first render so
    // useAutovote()'s first-render state is the live one; the mount effect
    // below revives it if an earlier cleanup disposed it, and disposes it on
    // the way out.
    const controllerRef = useRef<AutovoteController | null>(null);
    if (controllerRef.current === null) {
        controllerRef.current = createAutovoteController(hostRef.current);
    }
    const controller = controllerRef.current;

    // React sees the controller's state through a subscription. The
    // subscription effect is declared before the resume effect, so it is
    // attached before the mount-time auto-resume can change any state.
    const [state, setState] = useState<AutovoteState>(controller.getState);
    useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);

    // Publishing through a window CustomEvent lets the ancestor tree
    // (AppWithChallenges, which feeds ChallengesProvider's autovoteRunning
    // prop) react without a 1-Hz polling timer or a window.* global.
    // dispatchEvent + CustomEvent exist in every target (Electron Chromium,
    // Capacitor WebView, happy-dom test env). The effect also fires the
    // initial running=false dispatch on mount — AppWithChallenges' listener
    // attaches after it (child effects run before parent effects in the same
    // commit) and matches on the initial state.
    useEffect(() => {
        window.dispatchEvent(new CustomEvent('autovote:running-changed', { detail: state.running }));
    }, [state.running]);

    // The mount-time auto-resume, once per mount; dispose() cancels the
    // timers and any pending resume, and never touches persisted state.
    useEffect(() => {
        void controller.maybeResume();
        return () => controller.dispose();
    }, [controller]);

    // Stable per mount: the controller reads the latest onChallengesRefresh
    // identity at call time (through the host), so the controls never need to
    // track it.
    const start = useCallback(() => controller.start(), [controller]);
    const stop = useCallback(() => controller.stop(), [controller]);
    const rearmSchedule = useCallback(() => controller.rearmSchedule(), [controller]);

    /**
     * Toggle autovote. Reading the reducer's `running` is correct here:
     * start/stop dispatch START/STOP — and set the live flag — synchronously
     * before their first await, so `getState()` never lags behind a session
     * that is mid-setup.
     */
    const toggle = useCallback(async () => {
        if (controller.getState().running) {
            await controller.stop();
        } else {
            await controller.start();
        }
    }, [controller]);

    // Memoized so consumers re-render only when the state or a control
    // actually changes, not on every provider render (e.g. when the parent
    // re-renders with the same onChallengesRefresh).
    const value = useMemo(
        () => ({
            ...state,
            start,
            stop,
            toggle,
            rearmSchedule,
        }),
        [state, start, stop, toggle, rearmSchedule],
    );

    return <AutovoteContext.Provider value={value}>{children}</AutovoteContext.Provider>;
}

/**
 * Hook to access autovote state and controls
 */
export function useAutovote(): AutovoteContextValue {
    const context = useContext(AutovoteContext);
    if (!context) {
        throw new Error('useAutovote must be used within an AutovoteProvider');
    }
    return context;
}
