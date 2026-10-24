import * as logger from '../logger';
import * as settings from '../settings';

const showHelp = () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.app.mock;

    // The help is a block of text the user asked to read: printed whole, with its line breaks,
    // on the console only (the log file's one-line entries would flatten it).
    logger.printDocument(`
GuruShots Auto Voter - CLI ${isMockMode ? '(MOCK MODE)' : '(REAL MODE)'}

Usage: <command>

Commands:
  login    - Authenticate with GuruShots and save token
  logout   - Clear the saved authentication token
  vote     - Run one manual voting cycle (votes to 100% regardless of settings; skips Manual Only challenges).
             Add --challenge=<id> to manually vote a single challenge, which works on a Manual Only one too.
  run      - Run one full auto-strategy cycle (boost / turbo / auto-submit / threshold-aware vote).
             Add --challenge=<id> to scope to a single challenge; on a Manual Only challenge it does nothing.
  boost    - Apply a boost to a challenge: boost --challenge=<id> [--image=<id>]
  pin      - Pin the photo Boost and Turbo land on (timing is unchanged; none clears a pin; no flags lists them):
             pin --challenge=<id> [--boost=<imageId|none>] [--turbo=<imageId|none>]
  turbo    - Play the turbo mini-game on a challenge: turbo --challenge=<id>
  submit   - Submit photo(s) to a challenge's empty slots: submit --challenge=<id> [--all]
  unlock-boost  - Spend a key to unlock a locked boost (does not apply it):
             unlock-boost --challenge=<id> [--yes]
  swap     - Spend a swap to replace an entered photo: without --to it suggests a different one,
             with --to=<id> it swaps in the photo you name (list-photos --challenge=<id> shows them):
             swap --challenge=<id> --image=<id> [--to=<id>] [--yes]
  swap-back - Swap a photo that was swapped out while boosted/turbo'd back in (it gets
             its boost/turbo back): swap-back --challenge=<id> --image=<current id> [--yes]
  fill-exposure - Spend a fill to top exposure up to 100%: fill-exposure --challenge=<id> [--yes]
             Currency actions spend nothing without --yes; they print the cost first.
  start    - Start continuous voting on a schedule (runs until stopped with Ctrl+C)
  status   - Show current status and settings
  bankroll - Show your currency balances (keys / swaps / fills / coins). Alias: coins
  discover - List open (un-joined) challenges you can join, and the upcoming ones starting
             within discoverUpcomingHours (24 by default; 0 = open only). An upcoming challenge
             can't be joined until it starts, but you can choose its photos now.
  join <id> [--yes [--max-coins=<coins>]] - Join an open challenge. Free joins immediately; paid joins
             print the coin cost and require --yes before spending coins. --yes alone pays
             up to the cost printed first; with --max-coins=<coins> it refuses (and spends nothing) if the cost
             is above that. An upcoming challenge answers that it has not started. Exits 1 when the
             challenge was not joined, including a paid challenge priced without --yes.
  forget-payment <id> - Forget a join payment the app could not confirm (it got no answer), after checking on the
             GuruShots website that the coins were not taken. The next join asks for the price again; if the
             coins were taken, joining again charges a second time, and auto-join may join it again within its
             coin budget.
  list-photos [--challenge=<id>] [--search=<tag>] [--sort=votes|newest|oldest] - List your photo ids, to choose
             them for auto-join / auto-submit. With --challenge each photo shows whether that challenge accepts
             it. --sort orders the whole library on the server — votes (the default), newest or oldest (the
             date the photo was added to your library) — and the whole listing comes out in that order.
  list-photos --challenge=<id> --suggest - Rank your photos for that challenge by your auto-submit rules and list
             the top 5, best first. It is a ranking under those rules, not a replay of the next fill, and
             nothing is submitted. It cannot be combined with --search or --sort.
  check-updates - Check GitHub for a newer release
  get-setting <key> [--challenge=<id>] - Get a setting value (effective value for a challenge with --challenge)
  set-setting <key> <value> [--challenge=<id>] - Set a setting value (per-challenge override with --challenge)
  set-global-default <key> <value> - Set global default with validation
  list-settings [--challenge=<id>] - Show all settings (per-challenge view with --challenge)
  reset-setting <key> [--challenge=<id>] - Reset a setting to default (clear a challenge override with --challenge)
  reset-all-settings - Reset all settings to defaults
      To remove one challenge's own chosen-photos list (it then inherits from rules / global):
             reset-setting chosenPhotos --challenge=<id>
      To use no chosen photos for that challenge (overriding rules / global):
             set-setting chosenPhotos '[]' --challenge=<id>
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
  scenario-reset --challenge=<id> - Forget a challenge's scenario progress (the plan restarts). It may spend again an action
             whose outcome is unknown (no answer, or the app could not record it), and it restarts the scenario's
             spend counter.
  scenario-reset --all - Forget every challenge's scenario progress: the only way past a progress file that cannot be
             read. The rules that already ran can run again, with the same warning as above.
  scenario-vocabulary - List every condition, selector and action a scenario can use
             Assign one with: set-setting scenario "<name>" --challenge=<id> (or a challenge rule)
  help-settings - Show detailed settings help (includes profile details)
  logs [--error|--api|--settings|--lexicon] [--lines=<n>] - Show logs or the local lexicon report
  licenses - Print the third-party license notices
  reset-data --yes - Delete everything stored on this device: settings and the saved login, every store, logs and
             the extracted vision runtime. It cannot be undone, so it does nothing without --yes. Quit the
             desktop app, stop the web UI and wait for (or stop) any other CLI command or session first: it refuses to
             delete while one is running.
  reset-windows  - Reset window positions to default
  settings-recovery retry|start-fresh|report|acknowledge - When the saved settings are not in use: try importing
             settings.json again, begin with default settings (settings.json is left as it is; refused while the import
             may pass by itself, unless start-fresh --force), print what the import left unresolved (report), or mark
             that report as seen (acknowledge)
  help     - Show this help message

Examples:
  login
  vote
  vote --challenge=12345
  run
  run --challenge=12345
  boost --challenge=12345
  pin --challenge=12345 --boost=abc123 --turbo=none
  turbo --challenge=12345
  submit --challenge=12345 --all
  unlock-boost --challenge=12345 --yes
  swap --challenge=12345 --image=abc123
  swap --challenge=12345 --image=abc123 --to=def456 --yes
  fill-exposure --challenge=12345 --yes
  bankroll
  discover
  join 12345
  join 12345 --yes
  forget-payment 12345
  check-updates
  list-photos --challenge=12345
  list-photos --sort=newest
  list-photos --challenge=12345 --suggest
  set-setting chosenPhotos '["<id>"]' --challenge=12345
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
