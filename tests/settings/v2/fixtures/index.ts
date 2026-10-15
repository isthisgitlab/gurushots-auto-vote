/**
 * The hand-written equivalence fixtures: each a 1.x `settings.json` read against the shared challenges.
 */

import { LEGACY } from './legacy';
import { MATCHERS } from './matchers';
import { PRECEDENCE } from './precedence';
import { REFERENCES } from './references';

import type { Fixture } from './types';

const FIXTURES: Fixture[] = [...PRECEDENCE, ...REFERENCES, ...MATCHERS, ...LEGACY];

export { FIXTURES };
