import { Component } from 'react';
import { rendererTranslator } from '../../../translations/renderer';
import * as ipc from '@/api/ipc';

/**
 * Translate through the page translator rather than the useTranslation hook:
 * ErrorBoundary is a class (no hooks) and, more importantly, an error boundary
 * must not depend on React context that may itself be part of what broke.
 */
const tr = (key) => rendererTranslator.t(key);

/**
 * Catches render/lifecycle errors from descendants and shows a recovery UI
 * instead of letting the React root unmount (which leaves a blank page).
 *
 * Must be a class component — error boundaries have no hook equivalent.
 */
export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
        // Dedupe key for componentDidCatch. If the user clicks Dismiss on a
        // persistent crash the child re-throws on the next render with a
        // fresh Error instance (so reference equality fails). Stack and
        // componentStack also vary between re-catches because Preact embeds
        // render-cycle bookkeeping in them, so we dedupe on the bare
        // message — stable across re-throws from the same site. Trade-off:
        // two genuinely-different errors that happen to share a message
        // (e.g. two unrelated "Cannot read properties of undefined" throws)
        // collapse into one log entry. Acceptable vs. the original flood.
        this.loggedErrorKey = null;
        this.handleDismiss = this.handleDismiss.bind(this);
        this.handleReload = this.handleReload.bind(this);
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        const detail = error?.stack || error?.message || String(error);
        const componentStack = info?.componentStack || '';
        const dedupeKey = error?.message || String(error);
        if (this.loggedErrorKey === dedupeKey) return;
        this.loggedErrorKey = dedupeKey;
        // Fire-and-forget: the helper swallows a missing sink and a rejection,
        // so a logging failure during error handling can't surface as an
        // unhandled promise rejection on top of the original crash.
        void ipc.logRendererError(`React error boundary caught: ${detail}\nComponent stack:${componentStack}`);
    }

    handleDismiss() {
        // Intentionally do NOT reset loggedErrorKey. Dismiss often re-
        // triggers the same throw immediately (persistent crash); re-
        // logging on every dismiss click is exactly what this guards
        // against. The first log captured everything needed to
        // diagnose; later recurrences of the same signature are noise.
        this.setState({ error: null });
    }

    handleReload() {
        window.location.reload();
    }

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        const message = error.message || String(error);
        return (
            <div className="alert alert-error shadow-lg my-4">
                <div className="flex-1">
                    <h3 className="font-bold">{tr('errors.boundaryTitle')}</h3>
                    <p className="text-sm break-words">{message}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                    <button type="button" className="btn btn-outline btn-sm" onClick={this.handleDismiss}>
                        {tr('errors.dismiss')}
                    </button>
                    <button type="button" className="btn btn-sm btn-primary" onClick={this.handleReload}>
                        {tr('errors.reload')}
                    </button>
                </div>
            </div>
        );
    }
}
