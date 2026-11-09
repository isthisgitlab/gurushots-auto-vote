import type * as ChildProcess from 'node:child_process';
import type * as Fs from 'node:fs';
import type * as Os from 'node:os';
import { join } from 'node:path';

jest.unmock('node:fs');

const { execFileSync } = jest.requireActual<typeof ChildProcess>('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = jest.requireActual<typeof Fs>('node:fs');
const { tmpdir } = jest.requireActual<typeof Os>('node:os');

type PullRequestFile = { filename: string; previous_filename?: string };
type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type FetchImpl = (url: string) => Promise<FetchResponse>;

type Classifier = {
    classifyPullRequest: (input: { author: string; files: unknown }) => {
        workflowOnly: boolean;
        codeqlChanged: boolean;
    };
    fetchPullRequestFiles: (input: {
        apiUrl: string;
        fetchImpl: FetchImpl;
        repository: string;
        number: string;
        token: string;
    }) => Promise<PullRequestFile[]>;
    main: (input: { env: NodeJS.ProcessEnv; fetchImpl: FetchImpl }) => Promise<void>;
};

const { classifyPullRequest, fetchPullRequestFiles } =
    require('../scripts/classify-dependabot-workflow-pr.mts') as Classifier;
const { main } = require('../scripts/classify-dependabot-workflow-pr.mts') as Classifier;
const root = join(__dirname, '..');
const classifierCommand =
    'const { main } = await import("./scripts/classify-dependabot-workflow-pr.mts"); await main({ env: process.env, fetchImpl: globalThis.fetch })';

const workflowFile = (filename: string, previous_filename?: string): PullRequestFile =>
    previous_filename === undefined ? { filename } : { filename, previous_filename };

describe('Dependabot workflow-only PR classifier', () => {
    test.each([
        ['empty file list', 'dependabot[bot]', [], false],
        [
            'a mixed file list',
            'dependabot[bot]',
            [workflowFile('.github/workflows/test.yml'), workflowFile('package.json')],
            false,
        ],
        ['a composite action', 'dependabot[bot]', [workflowFile('.github/actions/setup-build/action.yml')], false],
        ['a nested workflow path', 'dependabot[bot]', [workflowFile('.github/workflows/nested/test.yml')], false],
        ['a human PR', 'maintainer', [workflowFile('.github/workflows/test.yml')], false],
        ['a Dependabot rerun', 'dependabot[bot]', [workflowFile('.github/workflows/test.yaml')], true],
        [
            'a rename within workflows',
            'dependabot[bot]',
            [workflowFile('.github/workflows/new.yml', '.github/workflows/old.yaml')],
            true,
        ],
        [
            'a rename out of workflows',
            'dependabot[bot]',
            [workflowFile('package.json', '.github/workflows/old.yml')],
            false,
        ],
        [
            'a rename into workflows',
            'dependabot[bot]',
            [workflowFile('.github/workflows/new.yml', 'package.json')],
            false,
        ],
    ])('%s is classified correctly', (_scenario, author, files, workflowOnly) => {
        expect(classifyPullRequest({ author, files: files as PullRequestFile[] }).workflowOnly).toBe(workflowOnly);
    });

    test('records CodeQL workflow changes on both sides of a rename', () => {
        expect(
            classifyPullRequest({
                author: 'dependabot[bot]',
                files: [workflowFile('.github/workflows/codeql.yml')],
            }),
        ).toMatchObject({ workflowOnly: true, codeqlChanged: true });
        expect(
            classifyPullRequest({
                author: 'dependabot[bot]',
                files: [workflowFile('.github/workflows/renamed.yml', '.github/workflows/codeql.yml')],
            }),
        ).toMatchObject({ workflowOnly: true, codeqlChanged: true });
    });

    test('fetches every API page before classifying', async () => {
        const firstPage = Array.from({ length: 100 }, (_, index) => workflowFile(`.github/workflows/${index}.yml`));
        const fetchImpl = jest
            .fn<Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>, [string]>()
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => firstPage })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [workflowFile('.github/workflows/final.yml')],
            });

        await expect(
            fetchPullRequestFiles({
                apiUrl: 'https://api.github.test',
                fetchImpl,
                repository: 'owner/repo',
                number: '42',
                token: 'token',
            }),
        ).resolves.toHaveLength(101);
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
            'https://api.github.test/repos/owner/repo/pulls/42/files?per_page=100&page=1',
            'https://api.github.test/repos/owner/repo/pulls/42/files?per_page=100&page=2',
        ]);
    });

    test('rejects classifier API errors', async () => {
        await expect(
            fetchPullRequestFiles({
                apiUrl: 'https://api.github.test',
                fetchImpl: async () => ({ ok: false, status: 403, json: async () => [] }),
                repository: 'owner/repo',
                number: '42',
                token: 'token',
            }),
        ).rejects.toThrow('403');
    });

    test.each([
        [
            'a non-array files response',
            async (): Promise<FetchResponse> => ({ ok: true, status: 200, json: async () => ({}) }),
        ],
        [
            'a file without a filename',
            async (): Promise<FetchResponse> => ({ ok: true, status: 200, json: async () => [{}] }),
        ],
        [
            'a file with an invalid previous filename',
            async (): Promise<FetchResponse> => ({
                ok: true,
                status: 200,
                json: async () => [{ filename: 'x', previous_filename: null }],
            }),
        ],
    ])('rejects %s', async (_scenario, response) => {
        await expect(
            fetchPullRequestFiles({
                apiUrl: 'https://api.github.test',
                fetchImpl: response,
                repository: 'owner/repo',
                number: '42',
                token: 'token',
            }),
        ).rejects.toThrow('GitHub returned');
    });

    test('rejects a malformed classifier input', () => {
        expect(() => classifyPullRequest({ author: 'dependabot[bot]', files: {} })).toThrow(
            'invalid pull-request file list',
        );
        expect(() => classifyPullRequest({ author: 'dependabot[bot]', files: [null] })).toThrow('without a filename');
        expect(() =>
            classifyPullRequest({ author: 'dependabot[bot]', files: [{ filename: 'x', previous_filename: null }] }),
        ).toThrow('invalid previous_filename');
    });

    test('writes full-check outputs for non-PR events without calling the API', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'dependabot-classifier-'));
        const output = join(directory, 'output');
        writeFileSync(output, '');
        const fetchImpl = jest.fn<Promise<FetchResponse>, [string]>();

        await main({
            env: { GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: output },
            fetchImpl,
        });
        expect(readFileSync(output, 'utf8')).toBe('workflow_only=false\ncodeql_changed=false\n');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('writes Dependabot workflow-only outputs after fetching the PR files', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'dependabot-classifier-'));
        const output = join(directory, 'output');
        writeFileSync(output, '');
        const fetchImpl = jest.fn<Promise<FetchResponse>, [string]>().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => [workflowFile('.github/workflows/test.yml')],
        });

        await main({
            env: {
                GITHUB_API_URL: 'https://api.github.test',
                GITHUB_EVENT_NAME: 'pull_request',
                GITHUB_OUTPUT: output,
                GITHUB_REPOSITORY: 'owner/repo',
                GITHUB_TOKEN: 'token',
                PR_AUTHOR: 'dependabot[bot]',
                PR_NUMBER: '42',
            },
            fetchImpl,
        });
        expect(readFileSync(output, 'utf8')).toBe('workflow_only=true\ncodeql_changed=false\n');
    });

    test('uses the default API URL and stdout when no output file is configured', async () => {
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const fetchImpl = jest.fn<Promise<FetchResponse>, [string]>().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => [workflowFile('.github/workflows/test.yml')],
        });

        await main({
            env: {
                GITHUB_EVENT_NAME: 'pull_request',
                GITHUB_REPOSITORY: 'owner/repo',
                GITHUB_TOKEN: 'token',
                PR_AUTHOR: 'dependabot[bot]',
                PR_NUMBER: '42',
            },
            fetchImpl,
        });

        expect(fetchImpl).toHaveBeenCalledWith(
            'https://api.github.com/repos/owner/repo/pulls/42/files?per_page=100&page=1',
            expect.anything(),
        );
        expect(write).toHaveBeenCalledWith('workflow_only=true\ncodeql_changed=false\n');
        write.mockRestore();
    });

    test.each([[{ GITHUB_TOKEN: 'token' }], [{ GITHUB_REPOSITORY: 'owner/repo' }]])(
        'rejects pull-request classification without required environment',
        async (partial) => {
            await expect(
                main({
                    env: { GITHUB_EVENT_NAME: 'pull_request', PR_NUMBER: '42', ...partial },
                    fetchImpl: jest.fn<Promise<FetchResponse>, [string]>(),
                }),
            ).rejects.toThrow('Missing GitHub pull-request classification environment');
        },
    );

    test('runs natively without dependency installation', () => {
        const directory = mkdtempSync(join(tmpdir(), 'dependabot-classifier-'));
        const output = join(directory, 'output');
        writeFileSync(output, '');
        execFileSync(process.execPath, ['--input-type=module', '--eval', classifierCommand], {
            cwd: root,
            env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: output },
        });
        expect(readFileSync(output, 'utf8')).toBe('workflow_only=false\ncodeql_changed=false\n');
    });
});
