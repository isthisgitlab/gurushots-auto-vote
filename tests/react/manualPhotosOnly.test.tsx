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
    const view = (flags: { autoFillEnabled: boolean; manualPhotosOnly: boolean }, entries: unknown[] = []) =>
        deriveChallengeCardView(
            buildChallenge({
                start_time: NOW - 1000,
                max_photo_submits: 4,
                member: { ranking: { entries } },
            }),
            { now: NOW, bankroll: null, autovoteRunning: false, ...flags },
        );

    test('off: the auto-submit badge shows while a slot is free, and the manual-photos one never does', () => {
        expect(view({ autoFillEnabled: true, manualPhotosOnly: false })).toMatchObject({
            showAutoFillBadge: true,
            showManualPhotosBadge: false,
        });
        expect(view({ autoFillEnabled: false, manualPhotosOnly: false }).showAutoFillBadge).toBe(false);
    });

    test('on: the manual-photos badge shows and the auto-submit one is suppressed', () => {
        expect(view({ autoFillEnabled: true, manualPhotosOnly: true })).toMatchObject({
            showAutoFillBadge: false,
            showManualPhotosBadge: true,
        });
    });

    test('on, with every slot full, the manual-photos badge still shows (Auto-Swap is what it holds back)', () => {
        const full = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
        expect(view({ autoFillEnabled: false, manualPhotosOnly: true }, full).showManualPhotosBadge).toBe(true);
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
        ['autoFill', 'app.manualPhotosOnlyHint'],
        ['emergencyFill', 'app.manualPhotosOnlyHint'],
        ['autoSwap', 'app.manualPhotosOnlyHint'],
        ['boostFillNew', 'app.manualPhotosOnlyBoostHint'],
        ['boostFillNewOnConflict', 'app.manualPhotosOnlyBoostHint'],
        ['turboFillNew', 'app.manualPhotosOnlyBoostHint'],
        ['turboFillNewOnConflict', 'app.manualPhotosOnlyBoostHint'],
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
