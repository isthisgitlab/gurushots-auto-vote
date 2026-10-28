import type { JoinReason } from '../../types/join';

type OutcomeVariant = 'success' | 'warning' | 'error' | 'neutral';

type OutcomeMeta = { key: string | null; variant: OutcomeVariant };

// Map a join outcome status to a translated, colored inline message. Distinct
// wording for the money-critical "charged but not joined" case, which also
// surfaces a resume-submit action.
const OUTCOME: Record<string, OutcomeMeta> = {
    joined: { key: 'app.discoverJoined', variant: 'success' },
    'skipped-unaffordable': { key: 'app.discoverUnaffordable', variant: 'warning' },
    'balance-unknown': { key: 'app.discoverBalanceUnknown', variant: 'warning' },
    'charged-pending-submit': { key: 'app.discoverChargedPending', variant: 'error' },
    'failed-no-charge': { key: 'app.discoverFailedNoCharge', variant: 'error' },
    'skipped-no-photo': { key: 'app.discoverNoPhoto', variant: 'warning' },
    unavailable: { key: 'app.discoverUnavailable', variant: 'neutral' },
    'not-started': { key: 'app.discoverNotStarted', variant: 'neutral' },
    // The price rose after the cost was shown: nothing was spent, and the list shows the new cost.
    'needs-confirm': { key: 'app.discoverPriceChanged', variant: 'warning' },
    // A join answered while another row's price dialog was open: it is not shown, and asks to be pressed again.
    'confirm-dialog-open': { key: 'app.discoverConfirmDialogFirst', variant: 'neutral' },
    busy: { key: 'app.discoverBusy', variant: 'neutral' },
};

// What a status says where a reason makes it more exact.
const REASON_OUTCOME: Record<string, Partial<Record<JoinReason, OutcomeMeta>>> = {
    // Coins spent earlier, nothing eligible left to finish with: a photo is what is missing.
    'charged-pending-submit': {
        'no-photo': { key: 'app.discoverPendingNoPhoto', variant: 'error' },
        unconfirmed: { key: 'app.discoverUnconfirmed', variant: 'error' },
    },
    'failed-no-charge': {
        'already-joined': { key: 'app.discoverAlreadyJoined', variant: 'neutral' },
    },
};

/**
 * What a join left behind for its row: the line to show (`key` null: the result carries its own error text),
 * and whether the row's button resumes the submit ("Retry submit", which spends nothing) — any charged join,
 * one that is waiting for a photo included — and "I wasn't charged", which only an unconfirmed payment offers.
 */
const outcomeMeta = (outcome: {
    status?: string;
    reason?: JoinReason;
}): OutcomeMeta & { retry: boolean; forget: boolean } => {
    const { status, reason } = outcome;
    const byReason = status !== undefined && reason !== undefined ? REASON_OUTCOME[status]?.[reason] : undefined;
    const meta = byReason ?? (status === undefined ? undefined : OUTCOME[status]) ?? { key: null, variant: 'error' };
    const pending = status === 'charged-pending-submit';
    return {
        ...meta,
        retry: pending,
        forget: pending && reason === 'unconfirmed',
    };
};

export type { OutcomeVariant };
export { outcomeMeta };
