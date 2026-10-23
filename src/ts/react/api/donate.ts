import * as ipc from './ipc';

export const DONATE_URL = 'https://donatr.ee/isthisgitlab/';

// A refused or failed open stays silent, like the challenge URL row: the URL is a constant https page.
export const openDonatePage = () => {
    void ipc.callOrNull(() => ipc.openExternalUrl(DONATE_URL));
};
