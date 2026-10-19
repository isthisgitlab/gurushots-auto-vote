/**
 * Tells a CLI user, once, that this is an unofficial tool: not affiliated with GuruShots, against its terms, and
 * contacting GitHub for updates. Shown on stderr (so a command's output on stdout stays clean to pipe) while the
 * stored `noticeAcknowledgedVersion` is below CURRENT_NOTICE_VERSION, then that version is stored.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import { CURRENT_NOTICE_VERSION } from '../../noticeVersion';
import { isInteger } from '../../numbers';

const UNOFFICIAL_NOTICE = [
    'This is an unofficial tool. It is not affiliated with or endorsed by GuruShots; GuruShots is a trademark of its owner.',
    "Automating votes may violate GuruShots' terms and can lead to account suspension: you use it at your own risk.",
    'The app contacts GitHub to check for updates.',
].join('\n');

/**
 * Prints the notice when the stored version is below the current one and records the current one; nothing otherwise.
 */
const showUnofficialNotice = (): void => {
    const acknowledged = settings.getSetting('noticeAcknowledgedVersion');
    if (isInteger(acknowledged) && acknowledged >= CURRENT_NOTICE_VERSION) return;
    logger.printStderr(UNOFFICIAL_NOTICE);
    settings.setSetting('noticeAcknowledgedVersion', CURRENT_NOTICE_VERSION);
};

export { UNOFFICIAL_NOTICE, showUnofficialNotice };
