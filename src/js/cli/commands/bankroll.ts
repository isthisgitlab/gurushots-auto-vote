/**
 * CLI bankroll command: prints the account currency balances
 * (keys/swaps/fills/coins). Reuses the shared IPC handler so the
 * {success,error} envelope + logging live in one place.
 */

import * as logger from '../../logger';
import { ensureAuthenticated } from '../guards';

// Lazily built, invoked with a null event (same reuse pattern as
// commands/actions.ts / commands/voting.ts).
import type { NullEventHandlers } from '../../types/cli';
import type * as actions_handlersModule from '../../ipc/actions.handlers';
type ActionHandlers = NullEventHandlers<ReturnType<typeof actions_handlersModule.buildHandlers>>;
let _handlers: ActionHandlers | undefined;
const handlers = (): ActionHandlers => (_handlers ??= require('../../ipc/actions.handlers').buildHandlers());

const showBankroll = async () => {
    if (!ensureAuthenticated()) return;
    const result = await handlers()['get-bankroll'](null);
    logger.withCategory('ui').info('=== GuruShots Bankroll ===');
    if (!result?.success) {
        // Never print 0 on a failed read — that would falsely imply an empty balance.
        logger.withCategory('ui').info(`  (unavailable — ${result?.error || 'could not read balance'})`);
        return;
    }
    logger.withCategory('ui').info(`  🔑 Keys:  ${result.keys}`);
    logger.withCategory('ui').info(`  🔄 Swaps: ${result.swaps}`);
    logger.withCategory('ui').info(`  🧩 Fills: ${result.fills}`);
    logger.withCategory('ui').info(`  🪙 Coins: ${result.coins}`);
};

export { showBankroll };
