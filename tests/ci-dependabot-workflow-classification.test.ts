import type * as ChildProcess from 'node:child_process';
import type * as Fs from 'node:fs';
import type * as Os from 'node:os';
import { join } from 'node:path';

const { execFileSync } = jest.requireActual<typeof ChildProcess>('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = jest.requireActual<typeof Fs>('node:fs');
const { tmpdir } = jest.requireActual<typeof Os>('node:os');

type PullRequestFile = { filename: string; previous_filename?: string };

type Classifier = {
    classifyPullRequest: (input: { author: string; files: PullRequestFile[] }) => {
        workflowOnly: boolean;
        codeqlChanged: boolean;
    };
    fetchPullRequestFiles: (input: {
        apiUrl: string;
        fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
        repository: string;
        number: string;
        token: string;
    }) => Promise<PullRequestFile[]>;
};

const { classifyPullRequest, fetchPullRequestFiles } =
    require('../scripts/classify-dependabot-workflow-pr.mts') as Classifier;
const script = join(__dirname, '..', 'scripts', 'classify-dependabot-workflow-pr.mts');

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

    test('non-PR events produce full-check outputs without calling the API', () => {
        const directory = mkdtempSync(join(tmpdir(), 'dependabot-classifier-'));
        const output = join(directory, 'output');
        writeFileSync(output, '');
        execFileSync(process.execPath, [script], {
            env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: output },
        });
        expect(readFileSync(output, 'utf8')).toBe('workflow_only=false\ncodeql_changed=false\n');
    });
});
