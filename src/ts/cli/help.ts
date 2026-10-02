import * as logger from '../logger';
import * as settings from '../settings';

const showHelp = () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.mock;

    logger.withCategory('ui').info(`
GuruShots Auto Voter - CLI ${isMockMode ? '(MOCK MODE)' : '(REAL MODE)'}

Usage: <command>

Commands:
  login    - Authenticate with GuruShots and save token
  logout   - Clear the saved authentication token
  vote     - Run one manual voting cycle (votes to 100% regardless of settings).
             Add --challenge=<id> to manually vote a single challenge.
  run      - Run one full auto-strategy cycle (boost / turbo / auto-submit / threshold-aware vote).
             Add --challenge=<id> to scope to a single challenge.
  boost    - Apply a boost to a challenge: boost --challenge=<id> [--image=<id>]
  turbo    - Play the turbo mini-game on a challenge: turbo --challenge=<id>
  submit   - Submit photo(s) to a challenge's empty slots: submit --challenge=<id> [--all]
  unlock-boost  - Spend a key to unlock a locked boost (does not apply it):
             unlock-boost --challenge=<id> [--yes]
  swap     - Spend a swap to replace an entered photo with a different one:
             swap --challenge=<id> --image=<id> [--to=<id> --yes]
  swap-back - Swap a photo that was swapped out while boosted/turbo'd back in (it gets
             its boost/turbo back): swap-back --challenge=<id> --image=<current id> [--yes]
  fill-exposure - Spend a fill to top exposure up to 100%: fill-exposure --challenge=<id> [--yes]
             Currency actions spend nothing without --yes; they print the cost first.
  start    - Start continuous voting with cron scheduling (runs until stopped with Ctrl+C)
  status   - Show current status and settings
  bankroll - Show your currency balances (keys / swaps / fills / coins). Alias: coins
  discover - List open (un-joined) challenges you can join
  join <id> [--yes] - Join an open challenge. Free joins immediately; paid joins
             print the coin cost and require --yes before spending coins.
  check-updates - Check GitHub for a newer release
  get-setting <key> [--challenge=<id>] - Get a setting value (effective value for a challenge with --challenge)
  set-setting <key> <value> [--challenge=<id>] - Set a setting value (per-challenge override with --challenge)
  set-global-default <key> <value> - Set global default with validation
  list-settings [--challenge=<id>] - Show all settings (per-challenge view with --challenge)
  reset-setting <key> [--challenge=<id>] - Reset a setting to default (clear a challenge override with --challenge)
  reset-all-settings - Reset all settings to defaults
  list-profiles - Show saved challenge-settings profiles
  save-profile "<name>" --challenge=<id> - Save a challenge's overrides as a named profile
  apply-profile "<name>" --challenge=<id> - Replace a challenge's overrides with a profile
  delete-profile "<name>" - Delete a saved profile
  list-scenarios - Show saved scenarios and the example templates
  scenario-template <id> [file] - Print (or write) an example scenario to start from
  import-scenario <file> [--overwrite] [--yes] - Check a scenario file and show what it does; --yes imports it
  export-scenario "<name>" [file] - Print (or write) a scenario as JSON to share
  rename-scenario "<old>" "<new>" - Rename a scenario; its assignments follow
  delete-scenario "<name>" - Delete a scenario and clear its assignments
  scenario-status --challenge=<id> - Where a challenge is in its scenario
  scenario-dry-run --challenge=<id> - What the scenario would do right now (spends nothing)
  scenario-simulate --challenge=<id> - A what-if timeline until the challenge closes (spends nothing)
  scenario-reset --challenge=<id> - Forget a challenge's scenario progress (the plan restarts)
  scenario-vocabulary - List every condition, selector and action a scenario can use
             Assign one with: set-setting scenario "<name>" --challenge=<id> (or a challenge rule)
  help-settings - Show detailed settings help (includes profile details)
  logs [--error|--api|--settings|--lexicon] [--lines=<n>] - Show logs or the local lexicon report
  reset-windows  - Reset window positions to default
  help     - Show this help message

Examples:
  login
  vote
  vote --challenge=12345
  run
  run --challenge=12345
  boost --challenge=12345
  turbo --challenge=12345
  submit --challenge=12345 --all
  unlock-boost --challenge=12345 --yes
  swap --challenge=12345 --image=abc123
  fill-exposure --challenge=12345 --yes
  bankroll
  discover
  join 12345
  join 12345 --yes
  check-updates
  set-setting exposure 80 --challenge=12345
  list-settings --challenge=12345
  logs --error --lines=50
  start
  logout
  reset-windows

Note: You must login first before you can vote, boost, turbo, or submit.
      The 'start' command will run continuously until stopped with Ctrl+C.
      Voting interval adjusts dynamically based on challenge states.
      Use 'get-setting checkFrequencyMin'/'checkFrequencyMax' to view, 'set-setting checkFrequencyMin 2' / 'set-setting checkFrequencyMax 5' to set the random range.
      Current mode: ${isMockMode ? 'MOCK (simulated API calls)' : 'REAL (live API calls)'}
    `);
};

export { showHelp };
