import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { openBoostWindows } from '../../../voting/boostWindow';
import { useTick } from '@/hooks/useTick';
import { lowExposureChallenges, missedBoostChallenges } from '@/utils/challengeAlerts';
import { scrollToChallenge } from '@/utils/scrollToChallenge';
import { useId } from 'react';

import type { ComponentChildren, TargetedKeyboardEvent } from 'preact';
import type { Bankroll, Challenge, MemberTurbo } from '../../../types/gurushots';

// A turbo is "available" for this challenge when it's ready to apply (WON) or
// ready to earn (FREE / in progress / cooldown elapsed).
/**
 * @param now - Unix seconds
 */
const isTurboAvailable = (turbo: MemberTurbo | undefined, now: number) => {
    const state = turbo?.state;
    if (state === 'WON' || state === 'FREE' || state === 'IN_PROGRESS') return true;
    return state === 'TIMER' && typeof turbo?.time_to_open === 'number' && turbo.time_to_open <= now;
};

/**
 * One stat of the bar: an icon and either a value + label or custom children.
 */
function HeaderStat({
    icon,
    value,
    label,
    children,
}: {
    icon: string;
    value?: string | number;
    label?: string;
    children?: ComponentChildren;
}) {
    return (
        <div className="flex items-baseline gap-1 whitespace-nowrap">
            <span aria-hidden="true">{icon}</span>
            {children ?? (
                <>
                    <span className="font-semibold">{value}</span>
                    <span className="text-base-content/60">{label}</span>
                </>
            )}
        </div>
    );
}

// Render a balance, or an em-dash when it could not be read — NEVER 0, which
// would falsely imply an empty balance and mislead a paid-join decision.
const fmtBalance = (v: number) => (Number.isFinite(v) ? v : '—');

/**
 * Bankroll pills (keys/swaps/fills/coins). Wrapped in its own polite live region
 * — unlike the ambient countdown, a balance change after a join/spend IS worth
 * announcing, and this node has no per-second tick to make that noisy.
 */
function BankrollStats({ bankroll }: { bankroll: Bankroll }) {
    const { t } = useTranslation();
    // Only rendered when a bankroll object is present (see StatusHeader).
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1" role="status" aria-live="polite">
            <HeaderStat icon="🔑" value={fmtBalance(bankroll.keys)} label={t('app.bankrollKeys')} />
            <HeaderStat icon="🔄" value={fmtBalance(bankroll.swaps)} label={t('app.bankrollSwaps')} />
            <HeaderStat icon="🧩" value={fmtBalance(bankroll.fills)} label={t('app.bankrollFills')} />
            <HeaderStat icon="🪙" value={fmtBalance(bankroll.coins)} label={t('app.bankrollCoins')} />
        </div>
    );
}

// DaisyUI's focus dropdown closes on blur, so Escape just drops focus. Attached
// to the trigger and each entry button — the only focusable elements.
const blurOnEscape = (e: TargetedKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') e.currentTarget.blur();
};

/**
 * "Boosts missed" stat that opens a jump list of the challenges whose boost can
 * still be recovered with a key; each entry scrolls to its card (which takes
 * focus, closing the menu). Navigation only — the spend happens on the card,
 * where Unlock sits (under Details on a compact card). The hint line mirrors
 * what the card can show: a key to spend, none left, or a balance that could
 * not be read.
 * No time-left text: the header has no tick, so it would freeze between
 * refetches. Membership, like the other counts, refreshes on each challenge
 * refetch, so a challenge that closes in between stays listed until then.
 * Opening is CSS-driven (focus), so the trigger carries no aria-expanded.
 */
function MissedBoostsJump({
    missed,
    bankroll,
}: {
    missed: ReturnType<typeof missedBoostChallenges>;
    bankroll?: Bankroll | null;
}) {
    const { t } = useTranslation();
    const hintId = useId();
    // An unreadable balance (shown as '—') is not zero keys.
    const keys = bankroll?.keys;
    const hint = !Number.isFinite(keys)
        ? t('app.missedBoostsKeysUnknown')
        : Number(keys) > 0
          ? t('app.missedBoostsHint')
          : t('app.missedBoostsNoKeys');
    return (
        <div className="dropdown">
            <div
                className="btn btn-sm btn-soft btn-warning"
                role="button"
                tabIndex={0}
                aria-describedby={hintId}
                onKeyDown={blurOnEscape}
            >
                <span aria-hidden="true">💤</span>
                <span className="font-semibold">{missed.length}</span>
                <span>{t('app.statusHeaderMissedBoosts')}</span>
                <span aria-hidden="true">▾</span>
            </div>
            <ul
                tabIndex={-1}
                className="dropdown-content menu z-[1] mt-1 p-2 shadow bg-base-100 rounded-box w-64 max-w-[calc(100vw-2rem)]"
            >
                <li id={hintId} className="menu-title">
                    {hint}
                </li>
                {missed.map((c) => (
                    <li key={c.id}>
                        <button
                            type="button"
                            className="break-words"
                            onClick={() => scrollToChallenge(c.id)}
                            onKeyDown={blurOnEscape}
                        >
                            {c.title}
                        </button>
                    </li>
                ))}
            </ul>
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
type CountdownProps = { nextRunAt: number | null | undefined; running: boolean; titleKey?: string };
function NextActionCountdown({ nextRunAt, running, titleKey = 'app.statusHeaderNextApprox' }: CountdownProps) {
    const { t } = useTranslation();
    const enabled = running && typeof nextRunAt === 'number';
    const now = useTick(1000, enabled);
    if (!running) return <span className="opacity-70">{t('app.statusHeaderNotRunning')}</span>;
    if (typeof nextRunAt !== 'number') return <span className="opacity-70">—</span>;
    const remaining = Math.round(nextRunAt / 1000) - now;
    return (
        <span title={t(titleKey)}>
            {remaining > 0 ? `~${formatDuration(remaining, { includeSeconds: true })}` : t('app.deadlineDue')}
        </span>
    );
}

function HeaderCountdown({ icon, labelKey, ...countdown }: { icon: string; labelKey: string } & CountdownProps) {
    const { t } = useTranslation();
    return (
        <HeaderStat icon={icon}>
            <span className="text-base-content/60">{t(labelKey)}:</span>
            <span className="inline-block min-w-[11ch] tabular-nums">
                <NextActionCountdown {...countdown} />
            </span>
        </HeaderStat>
    );
}

/**
 * At-a-glance summary bar above the challenge list: active-challenge count,
 * boosts/turbos available right now, missed boosts a key can recover and
 * low-exposure challenges (each only when there are any), and the next armed
 * autovote action.
 *
 * The counts derive from the already-fetched, reference-stable
 * `challenges` array and recompute only when it changes — NO tick here, so the
 * header body never re-renders on the countdown's clock. Responsive: the row
 * wraps on narrow viewports rather than using wide DaisyUI `stat` blocks.
 */
export function StatusHeader({
    challenges,
    nextRunAt,
    running,
    bankroll,
    autoClaimStatus,
}: {
    challenges: Challenge[];
    nextRunAt?: number | null;
    running: boolean;
    bankroll?: Bankroll | null;
    autoClaimStatus?: { enabled: boolean; nextClaimAt: number } | null;
}) {
    const { t } = useTranslation();
    // ChallengesContext always hands down an array ([] while empty/loading).
    const list = challenges;
    const nowSec = Math.floor(Date.now() / 1000);
    const activeCount = list.length;
    const boostsAvailable = openBoostWindows(list, nowSec).length;
    const turbosAvailable = list.filter((c) => isTurboAvailable(c.member?.turbo, nowSec)).length;
    const missedBoosts = missedBoostChallenges(list, nowSec);
    const lowExposureCount = lowExposureChallenges(list, nowSec).length;

    // Show the bar whenever there's a balance to display, even with no active
    // challenges and autovote idle — that's exactly when a user browses Discover
    // and needs to see their coins before a paid join. Only fully idle + no
    // bankroll hides it.
    const hasBankroll = bankroll !== undefined && bankroll !== null;
    // When running the bar always renders, so no extra term is needed here.
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
            {/* Row 1: counts + next-action countdowns. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <HeaderStat icon="🏆" value={activeCount} label={t('app.statusHeaderActive')} />
                <HeaderStat icon="🚀" value={boostsAvailable} label={t('app.statusHeaderBoosts')} />
                <HeaderStat icon="⚡" value={turbosAvailable} label={t('app.statusHeaderTurbos')} />
                {missedBoosts.length > 0 && <MissedBoostsJump missed={missedBoosts} bankroll={bankroll} />}
                {lowExposureCount > 0 && <HeaderStat icon="👁" value={lowExposureCount} label={t('app.lowExposure')} />}
                <HeaderCountdown icon="⏳" labelKey="app.statusHeaderNext" nextRunAt={nextRunAt} running={running} />
                {autoClaimStatus?.enabled && (
                    <HeaderCountdown
                        icon="🎁"
                        labelKey="app.statusHeaderNextClaim"
                        nextRunAt={autoClaimStatus.nextClaimAt}
                        running={running}
                        titleKey="app.statusHeaderNextClaimHint"
                    />
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
