import * as ipc from '@/api/ipc';
import { challengePageUrl } from '@/utils/challengePageUrl';

export function ChallengePageLink({ slug }: { slug?: string }) {
    if (!slug) return null;

    const url = challengePageUrl(slug);
    return (
        <div className="text-xs text-base-content/70 mt-1">
            <button
                type="button"
                onClick={() => void ipc.callOrNull(() => ipc.openExternalUrl(url))}
                className="font-mono hover:text-info hover:underline text-left min-h-6 py-1"
            >
                {url.replace('https://', '')}
            </button>
        </div>
    );
}
