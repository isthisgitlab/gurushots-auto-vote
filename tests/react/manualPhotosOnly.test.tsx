/**
 * Manual Photos Only in the renderer: the card view's two badge flags, and the hints the challenge settings
 * modal shows under every setting the switch overrides.
 */

import { render, screen } from './helpers/test-utils';
import { SettingHintList, challengeSettingHints } from '@/components/app/SettingHints';
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

    test('on, with every slot full, the manual-photos badge still shows (Auto-Swap is what it holds back)', () => {
        const full = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
        expect(view({ autoSubmitEnabled: false, manualPhotosOnly: true }, full).showManualPhotosBadge).toBe(true);
    });
});

describe('hints under the settings the switch overrides', () => {
    const hintsFor = (values: Record<string, unknown>) =>
        challengeSettingHints({
            effectiveOf: (key) => values[key],
            appSettings: {},
            challenge: invalid<Challenge>({ close_time: 0 }),
            profileReplacesWarning: false,
            t,
        });

    test.each([
        ['autoSubmit', 'app.manualPhotosOnlyHint'],
        ['emergencySubmit', 'app.manualPhotosOnlyHint'],
        ['autoSwap', 'app.manualPhotosOnlyHint'],
        ['boostNewSubmit', 'app.manualPhotosOnlyBoostHint'],
        ['boostNewSubmitOnConflict', 'app.manualPhotosOnlyBoostHint'],
        ['turboNewSubmit', 'app.manualPhotosOnlyBoostHint'],
        ['turboNewSubmitOnConflict', 'app.manualPhotosOnlyBoostHint'],
    ])('%s carries its hint while the switch is on, and none while it is off', (key, text) => {
        render(<SettingHintList hints={hintsFor({ manualPhotosOnly: true })(key)} />);
        expect(screen.getByText(text)).toBeTruthy();
        expect(hintsFor({ manualPhotosOnly: false })(key)).toEqual([]);
        expect(hintsFor({})(key)).toEqual([]);
    });

    test('settings the switch leaves alone get no hint', () => {
        expect(hintsFor({ manualPhotosOnly: true })('autoBoost')).toEqual([]);
        expect(hintsFor({ manualPhotosOnly: true })('manualPhotosOnly')).toEqual([]);
    });
});
