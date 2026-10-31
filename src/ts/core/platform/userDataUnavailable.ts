/**
 * The error a platform family throws when the app's user-data directory does
 * not exist and cannot be created. Declared once in core so an instanceof
 * against either family's throw answers the same class.
 */

/**
 * The app's user-data directory does not exist and cannot be created. The message says what happened, why and what to
 * do next, so a shell can show it as it is.
 */
class UserDataUnavailableError extends Error {
    readonly path: string;
    constructor(userDataPath: string, reason: string) {
        super(
            `The app's data folder ${userDataPath} does not exist and could not be created (${reason}). Settings and the login are not stored anywhere else, so nothing was started. Create the folder, or make its parent writable by this account, and run again.`,
        );
        this.name = 'UserDataUnavailableError';
        this.path = userDataPath;
    }
}

export { UserDataUnavailableError };
