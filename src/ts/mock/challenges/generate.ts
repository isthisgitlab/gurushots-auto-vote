import { buildChallenge } from './build';
import { SPECS_PART_1 } from './specsPart1';
import { SPECS_PART_2 } from './specsPart2';
import { SPECS_PART_3 } from './specsPart3';

const CHALLENGE_SPECS = [...SPECS_PART_1, ...SPECS_PART_2, ...SPECS_PART_3];

/**
 * Generate dynamic mock challenges with realistic exposure factors
 * IDs are generated once per app session to ensure session stability
 */
const generateMockChallenges = () => {
    const now = Math.floor(Date.now() / 1000);

    // Generate unique challenge IDs for this session
    // These will be different on each app restart but stable within the session
    const baseId = 100000 + Math.floor(Math.random() * 50000); // Random base between 100000-150000

    return { challenges: CHALLENGE_SPECS.map((spec, index) => buildChallenge(spec, baseId + index, now)) };
};

export { generateMockChallenges };
