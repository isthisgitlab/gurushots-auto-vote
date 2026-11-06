/**
 * The version as shown to people. A build made outside GitHub Actions reads `x.y.z-dirty`; display only: the update
 * checker and the beta-channel test keep the clean package.json version. Kept apart from buildInfo so the logger,
 * which reads buildInfo, does not pull package.json into every bundle.
 */

import { version } from '../../../package.json';
import { isDirtyBuild } from './buildInfo';

const displayVersion = (v: string = version): string => (isDirtyBuild() ? `${v}-dirty` : v);

export { displayVersion };
