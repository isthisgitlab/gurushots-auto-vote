import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { openBoostWindows } from '../../../voting/boostWindow';
import { useTick } from '@/hooks/useTick';
import { lowExposureChallenges } from '@/utils/challengeAlerts';

// A turbo is "available" for this challenge when it's ready to apply (WON) or
// ready to earn (FREE / in progress / cooldown elapsed).
const isTurboAvailable = (turbo, now) => {
    const state = turbo?.state;
    if (state === 'WON' || state === 'FREE' || state === 'IN_PROGRESS') return true;
    return state === 'TIMER' && typeof turbo?.time_to_open === 'number' && turbo.time_to_open <= now;
};

function HeaderStat({ icon, value, label }) {
    return (
        <div className="flex items-baseline gap-1 whitespace-nowrap">
            <span aria-hidden="true">{icon}</span>
            <span className="font-semibold">{value}</span>
            <span className="text-base-content/60">{label}</span>
        </div>
    );
}

// Render a balance, or an em-dash when it could not be read — NEVER 0, which
// would falsely imply an empty balance and mislead a paid-join decision.
const fmtBalance = (v) => (Number.isFinite(v) ? v : '—');

/**
 * Bankroll pills (keys/swaps/fills/coins). Wrapped in its own polite live region
 * — unlike the ambient countdown, a balance change after a join/spend IS worth
 * announcing, and this node has no per-second tick to make that noisy.
 */
function BankrollStats({ bankroll }) {
    const { t } = useTranslation();
    const b = bankroll || null;
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1" role="status" aria-live="polite">
            <HeaderStat icon="🔑" value={fmtBalance(b?.keys)} label={t('app.bankrollKeys')} />
            <HeaderStat icon="🔄" value={fmtBalance(b?.swaps)} label={t('app.bankrollSwaps')} />
            <HeaderStat icon="🧩" value={fmtBalance(b?.fills)} label={t('app.bankrollFills')} />
            <HeaderStat icon="🪙" value={fmtBalance(b?.coins)} label={t('app.bankrollCoins')} />
        </div>
    );
}

/**
 * Isolated 1Hz countdown for the next armed autovote cycle. Kept in its own
 * component so the per-second tick re-renders ONLY this node — never the parent
 * StatusHeader / AppContent / challenge list (which are deliberately optimized
 * against a 1Hz cascade). The time is advisory: computeNextCycleDelayMs
 * recomputes each cycle, so it is `~`-prefixed like the deadline timeline.
 */
function NextActionCountdown({ nextRunAt, running }) {
    const { t } = useTranslation();
    const enabled = running && typeof nextRunAt === 'number';
    const now = useTick(1000, enabled);
    if (!running) return <span className="opacity-70">{t('app.statusHeaderNotRunning')}</span>;
    if (typeof nextRunAt !== 'number') return <span className="opacity-70">—</span>;
    const remaining = Math.round(nextRunAt / 1000) - now;
    return (
        <span title={t('app.statusHeaderNextApprox')}>
            {remaining > 0 ? `~${formatDuration(remaining, { includeSeconds: true })}` : t('app.deadlineDue')}
        </span>
    );
}

/**
 * At-a-glance summary bar above the challenge list: active-challenge count,
 * boosts/turbos available right now, low-exposure challenges (only when there
 * are any), and the next armed autovote action.
 *
 * The three counts derive from the already-fetched, reference-stable
 * `challenges` array and recompute only when it changes — NO tick here, so the
 * header body never re-renders on the countdown's clock. Responsive: the row
 * wraps on narrow viewports rather than using wide DaisyUI `stat` blocks.
 */
export function StatusHeader({ challenges, nextRunAt, running, bankroll, autoJoinActive }) {
    const { t } = useTranslation();
    const list = Array.isArray(challenges) ? challenges : [];
    const nowSec = Math.floor(Date.now() / 1000);
    const activeCount = list.length;
    const boostsAvailable = openBoostWindows(list, nowSec).length;
    const turbosAvailable = list.filter((c) => isTurboAvailable(c.member?.turbo, nowSec)).length;
    const lowExposureCount = lowExposureChallenges(list, nowSec).length;

    // Show the bar whenever there's a balance to display, even with no active
    // challenges and autovote idle — that's exactly when a user browses Discover
    // and needs to see their coins before a paid join. Only fully idle + no
    // bankroll hides it.
    const hasBankroll = bankroll !== undefined && bankroll !== null;
    // The auto-join badge only shows while autovote is running (see below), and
    // when running the bar always renders — so no extra term is needed here.
    if (activeCount === 0 && !running && !hasBankroll) return null;

    return (
        // The card is NOT role="status"/aria-live: the next-action countdown
        // inside re-renders every second, and a live region would make a screen
        // reader re-announce the whole bar each tick. It's an ambient summary,
        // not an alert.
        <div
            className="text-sm rounded-lg border border-base-300 bg-base-100 px-3 py-2 mb-3"
            data-testid="status-header"
        >
            {/* Row 1: counts + next-action countdown + auto-join badge. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <HeaderStat icon="🏆" value={activeCount} label={t('app.statusHeaderActive')} />
                <HeaderStat icon="🚀" value={boostsAvailable} label={t('app.statusHeaderBoosts')} />
                <HeaderStat icon="⚡" value={turbosAvailable} label={t('app.statusHeaderTurbos')} />
                {lowExposureCount > 0 && <HeaderStat icon="👁" value={lowExposureCount} label={t('app.lowExposure')} />}
                <div className="flex items-baseline gap-1 whitespace-nowrap">
                    <span aria-hidden="true">⏳</span>
                    <span className="text-base-content/60">{t('app.statusHeaderNext')}:</span>
                    <NextActionCountdown nextRunAt={nextRunAt} running={running} />
                </div>
                {/* Only shown while autovote is RUNNING — that's when the join
                    pre-step actually executes. Showing it while autovote is off (a
                    pure settings check) would wrongly imply challenges are being
                    joined in the background. Own polite live region so arming/disarming
                    it mid-session is announced without making the 1Hz countdown noisy. */}
                {autoJoinActive && running && (
                    <span
                        className="badge badge-success badge-sm gap-1"
                        role="status"
                        aria-live="polite"
                        title={t('app.statusHeaderAutoJoinTitle')}
                    >
                        <span aria-hidden="true">🤝</span>
                        {t('app.statusHeaderAutoJoin')}
                    </span>
                )}
            </div>
            {/* Row 2: bankroll, always its own row so it doesn't shuffle up/down
                with the row-1 width. */}
            {hasBankroll && (
                <div className="mt-1.5 border-t border-base-200 pt-1.5">
                    <BankrollStats bankroll={bankroll} />
                </div>
            )}
        </div>
    );
}
