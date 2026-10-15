import { isPlainObject } from '../../src/ts/plainObject';
import type { PhotoStatsFile } from '../../src/ts/services/photoStats';
import type { ConfigV2 } from '../../src/ts/types/config';
import { isNumber, isRecordOf, isShape, isString } from './parseJson';
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

/**
 * A persisted configuration: the containers every config carries are checked; the values inside them are left as
 * saved.
 */
const isConfig = (value: unknown): value is ConfigV2 =>
    isPlainObject(value) &&
    value.version === 2 &&
    isPlainObject(value.app) &&
    isPlainObject(value.auth) &&
    isString(value.auth.token) &&
    isPlainObject(value.defaults) &&
    isPlainObject(value.profiles) &&
    Array.isArray(value.seededProfiles) &&
    isPlainObject(value.scenarios) &&
    Array.isArray(value.rules) &&
    isPlainObject(value.challenges);

export { isConfig, isPhotoStatsFile };
