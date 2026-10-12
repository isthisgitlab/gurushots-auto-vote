import { isPlainObject } from '../../src/ts/plainObject';
import type { PhotoStatsFile } from '../../src/ts/services/photoStats';
import type { AppSettings } from '../../src/ts/types/settings';
import { isBoolean, isNumber, isRecordOf, isShape, isString } from './parseJson';
import type { Guard } from './parseJson';

/** A persisted photo-stats cache file. */
const isPhotoStatsFile: Guard<PhotoStatsFile> = isShape<PhotoStatsFile>({
    version: isNumber,
    photos: isRecordOf(
        isShape<PhotoStatsFile['photos'][string]>({
            votes: isNumber,
            views: isNumber,
            achievementCount: isNumber,
            fetchedAt: isNumber,
        }),
    ),
});

const hasOwnFields = isShape<Pick<AppSettings, 'lastUsername' | 'mock' | 'token' | 'onboardingCompleted'>>({
    lastUsername: isString,
    mock: isBoolean,
    token: isString,
    onboardingCompleted: isBoolean,
});

/**
 * A persisted settings blob: the keys `AppSettings` declares itself are checked;
 * the UI defaults it extends and the free-form top-level keys are left as saved.
 */
const isAppSettings = (value: unknown): value is AppSettings => {
    if (!isPlainObject(value)) return false;
    const ownFieldsValid: boolean = hasOwnFields(value);
    return (
        ownFieldsValid &&
        isPlainObject(value.challengeSettings) &&
        isPlainObject(value.windowBounds) &&
        isPlainObject(value.apiHeaders)
    );
};

export { isAppSettings, isPhotoStatsFile };
