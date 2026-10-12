/**
 * The hold between the app launching and an interrupted auto-vote session
 * resuming by itself, so settings can be checked before the first cycle spends
 * anything. Anchored to the launch, not to a window mount: on Electron a
 * window reload continues the same hold, and once it has passed a reload
 * resumes at once. On Android the launch is the WebView load, so a WebView
 * reload restarts the hold (it holds longer, never shorter).
 *
 * Dependency-free apart from the limits. Anything but an integer delay reads as the default, so a bad
 * setting holds the session back rather than starting it at once.
 */

import { isInteger } from '../numbers';
import { DEFAULT_STARTUP_DELAY_SECONDS, MAX_STARTUP_DELAY_SECONDS } from '../settings/limits';

/**
 * @param delaySeconds - the `autovoteStartupDelay` value, as read (any type)
 * @returns the delay in whole seconds, within `[0, MAX_STARTUP_DELAY_SECONDS]`
 */
const startupDelaySeconds = (delaySeconds: unknown): number =>
    isInteger(delaySeconds)
        ? Math.min(Math.max(delaySeconds, 0), MAX_STARTUP_DELAY_SECONDS)
        : DEFAULT_STARTUP_DELAY_SECONDS;

/**
 * @param launchedAtMs - Unix ms the app launched
 * @returns Unix ms at which the held session resumes
 */
const startupResumeAt = (launchedAtMs: number, delaySeconds: unknown): number =>
    launchedAtMs + startupDelaySeconds(delaySeconds) * 1000;

export { startupDelaySeconds, startupResumeAt };
