import * as logger from '../logger';
import * as settings from '../settings';
import { COMMAND_ROWS } from './commandRows';

const showHelp = () => {
    const userSettings = settings.loadSettings();
    const isMockMode = userSettings.app.mock;

    // The help is a block of text the user asked to read: printed whole, with its line breaks,
    // on the console only (the log file's one-line entries would flatten it). The Commands block is
    // the rows' own help lines — each command's row is the one place its text lives.
    logger.printDocument(`
GuruShots Auto Voter - CLI ${isMockMode ? '(MOCK MODE)' : '(REAL MODE)'}

Usage: <command>

Commands:
${COMMAND_ROWS.flatMap((row) => row.help).join('\n')}

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
