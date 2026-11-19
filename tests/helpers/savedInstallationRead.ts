/**
 * For tests that mock the settings facade: answers the installation's own read (`captureInstallationSettings`, which a
 * boundary uses for the time zone) with what the test gives `getSetting` for the same keys, as the real facade does while no
 * installation scenario overlays them.
 */

import { invalid } from './invalid';
import type * as SettingsModule from '../../src/ts/core/settings';

type MockedSettings = ReturnType<typeof jest.mocked<typeof SettingsModule>>;
type SettingKey = Parameters<MockedSettings['getSetting']>[0];

const answerInstallationReadFromSaved = (settings: MockedSettings): void => {
    settings.captureInstallationSettings = invalid(
        jest.fn((keys: readonly string[]) => ({
            ok: true,
            values: Object.fromEntries(keys.map((key) => [key, settings.getSetting(invalid<SettingKey>(key))])),
        })),
    );
};

export { answerInstallationReadFromSaved };
