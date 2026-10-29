/**
 * Manual Only in the renderer: the card view's badge, Run and pin-note flags, and the per-setting hints the challenge
 * settings modal no longer shows (its alert speaks for every setting at once).
 */

import { render, screen } from './helpers/test-utils';
import { SettingHintList, challengeSettingHints, manualPhotosOnlyHint } from '@/components/app/SettingHints';
import { deriveChallengeCardView } from '@/utils/challengeCardView';
import { buildChallenge } from '../helpers/challengeFixtures';
import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/ts/types/gurushots';

const t = (key: string) => key;

describe('deriveChallengeCardView', () => {
    const NOW = 500_000;
    const view = (flags: { autoSubmitEnabled: boolean; manualPhotosOnly: boolean }, entries: unknown[] = []) =>
        deriveChallengeCardView(
            buildChallenge({
                start_time: NOW - 1000,
                max_photo_submits: 4,
                member: { ranking: { entries } },
            }),
            { now: NOW, bankroll: null, autovoteRunning: false, ...flags },
        );

    test('off: the auto-submit badge shows while a slot is free, and the manual-photos one never does', () => {
        expect(view({ autoSubmitEnabled: true, manualPhotosOnly: false })).toMatchObject({
            showAutoSubmitBadge: true,
            showManualPhotosBadge: false,
        });
        expect(view({ autoSubmitEnabled: false, manualPhotosOnly: false }).showAutoSubmitBadge).toBe(false);
    });

    test('on: the manual-photos badge shows and the auto-submit one is suppressed', () => {
        expect(view({ autoSubmitEnabled: true, manualPhotosOnly: true })).toMatchObject({
            showAutoSubmitBadge: false,
            showManualPhotosBadge: true,
        });
    });

    test('the Run button is hidden while the switch is on, and shown when it is off', () => {
        expect(view({ autoSubmitEnabled: false, manualPhotosOnly: true }).showRunButton).toBe(false);
        expect(view({ autoSubmitEnabled: false, manualPhotosOnly: false }).showRunButton).toBe(true);
    });

    test('the card hides its pin notes through manualOnly', () => {
        expect(view({ autoSubmitEnabled: false, manualPhotosOnly: true }).manualOnly).toBe(true);
        expect(view({ autoSubmitEnabled: false, manualPhotosOnly: false }).manualOnly).toBe(false);
    });

    test('on, with every slot full, the manual-photos badge still shows (Auto-Swap is what it holds back)', () => {
        const full = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
        expect(view({ autoSubmitEnabled: false, manualPhotosOnly: true }, full).showManualPhotosBadge).toBe(true);
    });
});

describe('no hint under the settings the switch overrides', () => {
    const hintsFor = (values: Record<string, unknown>) =>
        challengeSettingHints({
            effectiveOf: (key) => values[key],
            appSettings: {},
            challenge: invalid<Challenge>({ close_time: 0 }),
            profileReplacesWarning: false,
            t,
        });

    test.each([
        'autoSubmit',
        'emergencySubmit',
        'autoSwap',
        'boostNewSubmit',
        'boostNewSubmitOnConflict',
        'boostPinnedSubmit',
        'turboNewSubmit',
        'turboNewSubmitOnConflict',
        'autoBoost',
        'manualPhotosOnly',
    ])('%s carries none, with the switch on, off or unset: the modal alert speaks for them all', (key) => {
        expect(hintsFor({ manualPhotosOnly: true })(key)).toEqual([]);
        expect(hintsFor({ manualPhotosOnly: false })(key)).toEqual([]);
        expect(hintsFor({})(key)).toEqual([]);
    });

    test('the rule editor keeps its own hint', () => {
        render(<SettingHintList hints={[manualPhotosOnlyHint(t, 'app.manualPhotosOnlyRuleHint')]} />);
        expect(screen.getByText('app.manualPhotosOnlyRuleHint')).toBeTruthy();
    });
});
