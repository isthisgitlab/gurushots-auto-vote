/**
 * Tests for the team-match badges in ChallengeBadgeRow (shared by the detailed
 * card and the compact tile): the marker with the opponent, both vote totals,
 * and our lead or deficit, all as visible text. `t` answers with the real
 * English strings so the substituted opponent and totals can be asserted.
 */

import { render } from './helpers/test-utils';
import { mockTranslator } from './helpers/setup';
import { ChallengeBadgeRow } from '@/components/app/ChallengeBadgeRow';
import { app } from '../../src/ts/translations/english';
import { buildChallenge } from '../helpers/challengeFixtures';
import type { TeamMatch, TeamStanding } from '../../src/ts/types/gurushots';

const english = (key: string) =>
    key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;

beforeEach(() => mockTranslator.t.mockImplementation(english));
afterEach(() => mockTranslator.t.mockImplementation((key) => key));

const teamMatch = (us: number, them: number, themName = 'Poland Gurus'): TeamMatch => ({
    us: { name: 'Home Team', votes: us },
    them: { name: themName, votes: them },
});

// A challenge with no other logical badge, so the team match is the row's only one.
const renderRow = (match?: TeamMatch) =>
    render(
        <ChallengeBadgeRow
            challenge={buildChallenge({ id: 7, type: null, badge: null, max_photo_submits: 4, teamMatch: match })}
            boostOpen={false}
            boostTimeLeft=""
            lowExposure={false}
            exposureFactor={50}
            showAutoSubmitBadge={false}
            showManualPhotosBadge={false}
            hasCustomSettings={false}
            showPhotoCount={false}
        />,
    );

const badges = (container: Element) => [...container.querySelectorAll('span.badge')] as HTMLElement[];

describe('ChallengeBadgeRow — team match', () => {
    test('renders when the team match is the only logical badge: marker, both totals, diff', () => {
        const { container } = renderRow(teamMatch(7514, 8258));

        const [marker, votes, diff] = badges(container);
        expect(badges(container)).toHaveLength(3);
        expect(marker.textContent).toBe('👥 Team match vs Poland Gurus');
        expect(votes.textContent).toBe(`Us ${(7514).toLocaleString()} · Them ${(8258).toLocaleString()}`);
        expect(marker.className).toMatch(/badge-ghost/);
        expect(votes.className).toMatch(/badge-ghost/);
        expect(diff.className).toMatch(/badge-error/);
        expect(diff.textContent).toBe(`−${(744).toLocaleString()} behind`);
    });

    test.each([
        ['ahead', 8258, 7514, 'badge-success', `+${(744).toLocaleString()}`, 'ahead'],
        ['behind', 7514, 8258, 'badge-error', `−${(744).toLocaleString()}`, 'behind'],
        ['tied', 100, 100, 'badge-neutral', '±0', 'tied'],
    ])('%s: variant, exact sign and the sr-only word', (_name, us, them, variantClass, sign, word) => {
        const { container } = renderRow(teamMatch(us, them));

        const diff = badges(container)[2];
        expect(diff.className).toContain(variantClass);
        expect(diff.firstChild?.textContent).toBe(sign);
        const hidden = diff.querySelector('.sr-only');
        expect(hidden?.textContent).toBe(` ${word}`);
    });

    test('the marker wraps instead of truncating: fixed-height badge is released and long words break', () => {
        const { container } = renderRow(teamMatch(1, 2, 'Fictional Supercalifragilisticexpialidocious'));

        const marker = badges(container)[0];
        expect(marker.className).toContain('h-auto');
        expect(marker.className).toContain('wrap-anywhere');
        expect(marker.textContent).toContain('Fictional Supercalifragilisticexpialidocious');
    });

    test('the opponent is rendered as text, never as markup', () => {
        const { container } = renderRow(teamMatch(1, 2, '<img src=x onerror=alert(1)>'));

        expect(container.querySelector('img')).toBeNull();
        expect(badges(container)[0].textContent).toBe('👥 Team match vs <img src=x onerror=alert(1)>');
    });

    test('replacement patterns in the opponent name render literally', () => {
        const name = "Team $& $' $$ $`";
        const { container } = renderRow(teamMatch(1, 2, name));

        expect(badges(container)[0].textContent).toBe(`👥 Team match vs ${name}`);
    });

    test('no team badges, and no row at all, without a team match', () => {
        const { container } = renderRow();

        expect(badges(container)).toHaveLength(0);
        expect(container.firstChild).toBeNull();
    });
});

describe('ChallengeBadgeRow — team standing', () => {
    const active = (over: Partial<Omit<Extract<TeamStanding, { kind: 'active' }>, 'kind'>> = {}): TeamStanding => ({
        kind: 'active',
        position: 3,
        votes: 1200,
        activeSlots: 5,
        cushion: null,
        ...over,
    });
    const renderStanding = (me: TeamStanding | null, running?: boolean) =>
        renderRow({ ...teamMatch(7514, 8258), ...(running === undefined ? {} : { running }), me });

    test('our place among the active players, and the lead over the best standby when there is one', () => {
        const { container } = renderStanding(active({ cushion: 93 }));

        const [, , , standing] = badges(container);
        expect(badges(container)).toHaveLength(4);
        expect(standing.textContent).toBe(`You #3 · active · +${(93).toLocaleString()} over standby`);
    });

    test.each([
        ['no cushion recorded', active({ cushion: null }), 'You #3 · active'],
        [
            'a cushion of 0 stays visible',
            active({ cushion: 0 }),
            `You #3 · active · +${(0).toLocaleString()} over standby`,
        ],
        [
            'a standby waiting for votes to move up',
            { kind: 'standby', position: 9, votes: 640, activeSlots: 5, votesToActive: 107 },
            `Standby · ${(107).toLocaleString()} to active`,
        ],
    ] as Array<[string, TeamStanding, string]>)('%s', (_name, me, expected) => {
        const { container } = renderStanding(me);

        expect(badges(container)).toHaveLength(4);
        expect(badges(container)[3].textContent).toBe(expected);
    });

    test('no standing badge when the standing is missing or unreadable', () => {
        const withNull = renderStanding(null);
        expect(badges(withNull.container)).toHaveLength(3);
        withNull.unmount();

        // `me` absent altogether (an older shape) reads the same.
        const absent = renderRow(teamMatch(7514, 8258));
        expect(badges(absent.container)).toHaveLength(3);
    });

    test('a match that is no longer running says so in place of the standing', () => {
        const { container } = renderStanding(active({ cushion: 93 }), false);

        const all = badges(container);
        expect(all).toHaveLength(4);
        expect(all[3].textContent).toBe('Match not running');
    });
});
