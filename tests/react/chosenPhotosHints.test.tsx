/**
 * The Submit Only Chosen Photos warning where the setting reaches every matching
 * challenge: the global defaults form and the profile bar (the rule row is
 * covered with the rules editor). The per-challenge editor is not one of them.
 */

import { render, screen } from './helpers/test-utils';
import { ChallengeProfilesBar } from '@/components/app/ChallengeProfilesBar';
import { SettingHintList, challengeSettingHints, globalSettingHints } from '@/components/app/SettingHints';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const t = (key: string) => key;

const globalHints = (formValues: Record<string, unknown>) =>
    globalSettingHints({ formValues, schema: {}, timezone: 'UTC', t })('chosenPhotosOnly');

describe('global defaults', () => {
    test('Submit Only on warns that it applies to every matching challenge', () => {
        render(<SettingHintList hints={globalHints({ chosenPhotosOnly: true })} />);
        expect(screen.getByText('app.chosenPhotosOnlyReachHint')).toBeTruthy();
    });

    test('Submit Only off, or unset, has no warning', () => {
        expect(globalHints({ chosenPhotosOnly: false })).toEqual([]);
        expect(globalHints({})).toEqual([]);
    });

    test("the per-challenge editor does not add it (the value is that challenge's own)", () => {
        const hints = challengeSettingHints({
            effectiveOf: (key) => (key === 'chosenPhotosOnly' ? true : undefined),
            appSettings: {},
            challenge: invalid<Challenge>({ close_time: 0 }),
            profileReplacesWarning: false,
            t,
        })('chosenPhotosOnly');
        expect(hints).toEqual([]);
    });
});

describe('profile bar', () => {
    const renderBar = (overrides: Record<string, unknown>) =>
        render(<ChallengeProfilesBar overrides={overrides} onApply={jest.fn()} />);

    test('saving a profile that turns Submit Only on warns that the profile applies wherever it is used', () => {
        window.api.getChallengeProfiles = jest.fn().mockResolvedValue({});
        renderBar({ chosenPhotosOnly: true });
        expect(screen.getByText('app.chosenPhotosOnlyReachHint')).toBeTruthy();
    });

    test('no warning without it', () => {
        window.api.getChallengeProfiles = jest.fn().mockResolvedValue({});
        renderBar({ chosenPhotosOnly: false, exposure: 3 });
        expect(screen.queryByText('app.chosenPhotosOnlyReachHint')).toBeNull();
    });
});
