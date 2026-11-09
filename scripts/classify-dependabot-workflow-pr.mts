import { appendFileSync } from 'node:fs';

type PullRequestFile = { filename: string; previous_filename?: string };
type Classification = { workflowOnly: boolean; codeqlChanged: boolean };
type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type FetchImpl = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponse>;

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const CODEQL_WORKFLOW = '.github/workflows/codeql.yml';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const readPullRequestFile = (file: unknown): PullRequestFile => {
    if (!isPlainObject(file) || typeof file.filename !== 'string') {
        throw new Error('GitHub returned a pull-request file without a filename');
    }
    if (file.previous_filename !== undefined && typeof file.previous_filename !== 'string') {
        throw new Error('GitHub returned a pull-request file with an invalid previous_filename');
    }
    return file.previous_filename === undefined
        ? { filename: file.filename }
        : { filename: file.filename, previous_filename: file.previous_filename };
};

const changedPaths = (file: unknown): string[] => {
    const pullRequestFile = readPullRequestFile(file);
    return pullRequestFile.previous_filename === undefined
        ? [pullRequestFile.filename]
        : [pullRequestFile.filename, pullRequestFile.previous_filename];
};

const classifyPullRequest = ({ author, files }: { author: string | undefined; files: unknown }): Classification => {
    if (!Array.isArray(files)) throw new Error('GitHub returned an invalid pull-request file list');

    const paths = files.map(changedPaths);
    return {
        workflowOnly:
            author === 'dependabot[bot]' &&
            paths.length > 0 &&
            paths.every((filePaths) => filePaths.every((path) => WORKFLOW_FILE.test(path))),
        codeqlChanged: paths.some((filePaths) => filePaths.includes(CODEQL_WORKFLOW)),
    };
};

const fetchPullRequestFiles = async ({
    apiUrl,
    fetchImpl,
    repository,
    number,
    token,
}: {
    apiUrl: string;
    fetchImpl: FetchImpl;
    repository: string;
    number: string;
    token: string;
}): Promise<PullRequestFile[]> => {
    const files: PullRequestFile[] = [];
    for (let page = 1; ; page += 1) {
        const response = await fetchImpl(
            `${apiUrl}/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
            {
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${token}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            },
        );
        if (!response.ok) throw new Error(`GitHub pull-request files request failed with ${response.status}`);

        const rawPageFiles: unknown = await response.json();
        if (!Array.isArray(rawPageFiles)) throw new Error('GitHub returned an invalid pull-request files page');
        const pageFiles = rawPageFiles.map(readPullRequestFile);
        files.push(...pageFiles);
        if (pageFiles.length < 100) return files;
    }
};

const writeOutputs = ({ outputFile, result }: { outputFile: string | undefined; result: Classification }): void => {
    const output = `workflow_only=${result.workflowOnly}\ncodeql_changed=${result.codeqlChanged}\n`;
    if (outputFile) appendFileSync(outputFile, output);
    else process.stdout.write(output);
};

const main = async ({
    env = process.env,
    fetchImpl = globalThis.fetch,
}: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchImpl;
} = {}): Promise<void> => {
    if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.PR_NUMBER) {
        writeOutputs({ outputFile: env.GITHUB_OUTPUT, result: { workflowOnly: false, codeqlChanged: false } });
        return;
    }
    if (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN || !fetchImpl) {
        throw new Error('Missing GitHub pull-request classification environment');
    }

    const files = await fetchPullRequestFiles({
        apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
        fetchImpl,
        repository: env.GITHUB_REPOSITORY,
        number: env.PR_NUMBER,
        token: env.GITHUB_TOKEN,
    });
    writeOutputs({
        outputFile: env.GITHUB_OUTPUT,
        result: classifyPullRequest({ author: env.PR_AUTHOR, files }),
    });
};

export { classifyPullRequest, fetchPullRequestFiles, main };

if (import.meta.main) {
    void main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
