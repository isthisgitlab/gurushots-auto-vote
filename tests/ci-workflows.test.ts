/**
 * Release-pipeline invariants of the GitHub workflows: the Android keystore is
 * only ever in the signing job, a release is pushed before it is published,
 * the bump type comes from the commit subject, and every action is pinned.
 * The workflows are parsed, and the version-bump script is run, not grepped.
 */

import { parse } from 'yaml';
import { isPlainObject } from '../src/ts/plainObject';

const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
const os = jest.requireActual<typeof import('node:os')>('node:os');
const path = jest.requireActual<typeof import('node:path')>('node:path');

interface Step {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    id?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
}

interface Job {
    needs?: string | string[];
    env?: Record<string, string>;
    steps: Step[];
}

interface Workflow {
    jobs: Record<string, Job>;
}

const root = path.join(__dirname, '..');
const text = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const isWorkflow = (value: unknown): value is Workflow => isPlainObject(value) && isPlainObject(value.jobs);

const load = (file: string): Workflow => {
    const parsed: unknown = parse(text(file));
    if (!isWorkflow(parsed)) throw new Error(`${file} has no jobs`);
    return parsed;
};

const needsOf = (job: Job) => (typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []));
const stepNamed = (job: Job, name: string) => {
    const step = job.steps.find((candidate) => candidate.name === name);
    if (!step) throw new Error(`no step named ${name}`);
    return step;
};
const indexOfStep = (job: Job, name: string) => job.steps.indexOf(stepNamed(job, name));

const build = load('.github/workflows/build.yml');
const testWorkflow = load('.github/workflows/test.yml');
const SHA_PIN = /^[^@]+@[0-9a-f]{40}$/;

describe('every workflow action', () => {
    const files = fs.readdirSync(path.join(root, '.github', 'workflows')).filter((file) => file.endsWith('.yml'));

    test.each(files)('%s pins each external action by commit SHA', (file) => {
        const unpinned = Object.values(load(`.github/workflows/${file}`).jobs).flatMap((job) =>
            job.steps.flatMap((step) =>
                step.uses && !step.uses.startsWith('./') && !SHA_PIN.test(step.uses) ? [step.uses] : [],
            ),
        );
        expect(unpinned).toEqual([]);
    });
});

describe('Gradle wrapper validation', () => {
    test.each([
        ['build.yml', build],
        ['test.yml', testWorkflow],
    ])('%s validates the wrapper before every job that runs it', (_file, workflow) => {
        const gradleJobs = Object.entries(workflow.jobs).filter(([, job]) =>
            job.steps.some((step) => step.run?.includes('./gradlew')),
        );
        expect(gradleJobs.length).toBeGreaterThan(0);
        for (const [, job] of gradleJobs) {
            const validation = job.steps.findIndex((step) =>
                step.uses?.startsWith('gradle/actions/wrapper-validation@'),
            );
            const firstGradle = job.steps.findIndex((step) => step.run?.includes('./gradlew'));
            expect(validation).toBeGreaterThanOrEqual(0);
            expect(validation).toBeLessThan(firstGradle);
            expect(job.steps[validation].uses).toMatch(SHA_PIN);
        }
    });
});

describe('Gradle dependency verification', () => {
    const HINT = './.github/actions/gradle-verification-hint';
    const codeql = load('.github/workflows/codeql.yml');

    test.each([
        ['build.yml', build],
        ['test.yml', testWorkflow],
        ['codeql.yml', codeql],
    ])('%s explains a failed dependency check before every job that runs gradle', (_file, workflow) => {
        const gradleJobs = Object.values(workflow.jobs).filter((job) =>
            job.steps.some((step) => step.run?.includes('./gradlew')),
        );
        expect(gradleJobs.length).toBeGreaterThan(0);
        for (const job of gradleJobs) {
            const hint = job.steps.findIndex((step) => step.uses === HINT);
            expect(hint).toBeGreaterThanOrEqual(0);
            expect(hint).toBeLessThan(job.steps.findIndex((step) => step.run?.includes('./gradlew')));
            const validation = job.steps.findIndex((step) =>
                step.uses?.startsWith('gradle/actions/wrapper-validation@'),
            );
            // Where the wrapper is validated, the hint comes straight after it.
            if (validation >= 0) expect(hint).toBe(validation + 1);
        }
    });

    test('the hint names the regeneration script, and the checksums file it requires exists', () => {
        const action = text('.github/actions/gradle-verification-hint/action.yml');
        const init = text('.github/actions/gradle-verification-hint/dependency-verification-hint.init.gradle');
        for (const content of [action, init]) {
            expect(content).toContain('scripts/android-verification-metadata.sh');
            expect(content).toContain('android/gradle/verification-metadata.xml');
        }
        expect(init).toContain('Dependency verification failed');
        expect(fs.existsSync(path.join(root, 'scripts', 'android-verification-metadata.sh'))).toBe(true);
        const metadata = text('android/gradle/verification-metadata.xml');
        expect(metadata).toContain('<verify-metadata>true</verify-metadata>');
        expect(metadata).toMatch(/aapt2-[\d.-]+-linux\.jar/);
        expect(metadata).toMatch(/aapt2-[\d.-]+-osx\.jar/);
    });
});

describe('Android signing', () => {
    const secretsIn = (job: Job) => JSON.stringify(job).match(/secrets\.[A-Z_]+/g) ?? [];

    test('the build job builds unsigned and sees no secret', () => {
        const job = build.jobs['build-android'];
        expect(secretsIn(job)).toEqual([]);
        const gradle = job.steps.map((step) => step.run ?? '').join('\n');
        expect(gradle).toContain('./gradlew assembleRelease)');
        expect(gradle).not.toMatch(/signing|KEYSTORE|KEY_/);
        expect(gradle).toContain('app-release-unsigned.apk');
        expect(job.steps.some((step) => step.run?.includes('release.jks'))).toBe(false);
    });

    test('only the signing job reads the keystore secrets', () => {
        const readers = Object.entries(build.jobs)
            .filter(([, job]) => secretsIn(job).some((secret) => secret.startsWith('secrets.ANDROID_')))
            .map(([name]) => name);
        expect(readers).toEqual(['sign-android']);
    });

    test('the signing job runs after the build and before attestation and release', () => {
        expect(needsOf(build.jobs['sign-android'])).toContain('build-android');
        expect(needsOf(build.jobs.attest)).toContain('sign-android');
        expect(needsOf(build.jobs['create-release'])).toContain('sign-android');
        expect(needsOf(build.jobs.attest)).not.toContain('build-android');
        expect(needsOf(build.jobs['create-release'])).not.toContain('build-android');
    });

    test('the signing job pins the certificate, fails when the pin is unset, and deletes the key always', () => {
        const job = build.jobs['sign-android'];
        expect(job.env).toHaveProperty('ANDROID_CERT_SHA256');
        const signing = stepNamed(job, 'Align, sign and verify APKs');
        expect(signing.run).toContain('zipalign');
        expect(signing.run).toContain('apksigner" sign');
        expect(signing.run).toContain('apksigner" verify --print-certs');
        expect(signing.run).toMatch(/\[ -z "\$ANDROID_CERT_SHA256" \][\s\S]*exit 1/);
        expect(signing.run).toMatch(/"\$ACTUAL" != "\$EXPECTED"/);
        const cleanup = stepNamed(job, 'Delete keystore');
        expect(cleanup.if).toBe('always()');
        expect(indexOfStep(job, 'Delete keystore')).toBeGreaterThan(indexOfStep(job, 'Align, sign and verify APKs'));
        expect(indexOfStep(job, 'Upload signed Android artifact')).toBeGreaterThan(indexOfStep(job, 'Delete keystore'));
    });

    test('the signed APKs keep the artifact and file names the release lists', () => {
        const upload = stepNamed(build.jobs['sign-android'], 'Upload signed Android artifact');
        expect(upload.with?.name).toContain('android-builds');
        expect(upload.with?.path).toBe('signed/GuruShotsAutoVote-v*.apk');
        const files = String(stepNamed(build.jobs['create-release'], 'Create Release').with?.files);
        expect(files).toContain('android-builds/GuruShotsAutoVote-v*.apk');
    });
});

describe('release job', () => {
    const job = build.jobs['create-release'];
    const publish = () => indexOfStep(job, 'Create Release');

    test('builds from the commit the binaries were built from', () => {
        expect(job.steps[0].with?.ref).toBe('${{ github.sha }}');
    });

    test('pushes the version bump to the branch before publishing, and stops if it is refused', () => {
        const push = stepNamed(job, 'Commit and push version bump');
        expect(indexOfStep(job, 'Commit and push version bump')).toBeLessThan(publish());
        expect(push.run).toContain('git push origin "HEAD:refs/heads/$REF_NAME"');
        expect(push.run).toMatch(/if ! git push[\s\S]*exit 1/);
        expect(push.run).toContain('git rev-parse HEAD');
        expect(push.env?.REF_NAME).toBe('${{ github.ref_name }}');
    });

    test('tags the bump commit and ships the third-party notices', () => {
        const release = stepNamed(job, 'Create Release');
        expect(release.with?.target_commitish).toBe('${{ steps.bump_commit.outputs.sha }}');
        expect(stepNamed(job, 'Commit and push version bump').id).toBe('bump_commit');
        expect(String(release.with?.files)).toContain('src/assets/THIRD_PARTY_NOTICES.txt');
    });
});

describe('release job: the version bump is idempotent', () => {
    const script = stepNamed(build.jobs['create-release'], 'Commit and push version bump').run ?? '';
    const BUMP_FILES = ['package.json', 'README.md', 'README.lv.md', 'docs/usage.md', 'docs/usage.lv.md'];

    const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: 'pipe',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
        })
            .toString()
            .trim();

    type Scenario = {
        origin: string;
        builtSha: string;
        clone: () => string;
        run: (dir: string, version: string) => string;
    };

    // A bare origin on `develop` holding the built commit, and clones of it that run the step the way the job does:
    // checked out at the built commit, with the bumped files in the tree.
    const withOrigin = (check: (scenario: Scenario) => void) => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-step-'));
        try {
            const origin = path.join(base, 'origin.git');
            const seed = path.join(base, 'seed');
            fs.mkdirSync(seed);
            git(base, 'init', '--bare', '--initial-branch=develop', origin);
            git(seed, 'init', '--initial-branch=develop');
            git(seed, 'config', 'user.email', 'seed@example.com');
            git(seed, 'config', 'user.name', 'Seed');
            fs.mkdirSync(path.join(seed, 'docs'));
            for (const file of BUMP_FILES) {
                fs.writeFileSync(
                    path.join(seed, file),
                    file === 'package.json' ? '{"version":"1.0.0"}\n' : 'docs 1.0.0\n',
                );
            }
            git(seed, 'add', '.');
            git(seed, 'commit', '-m', 'Earlier work');
            fs.writeFileSync(path.join(seed, 'notes.txt'), 'the built commit\n');
            git(seed, 'add', '.');
            git(seed, 'commit', '-m', 'The built commit');
            git(seed, 'remote', 'add', 'origin', `file://${origin}`);
            git(seed, 'push', 'origin', 'develop');
            const builtSha = git(seed, 'rev-parse', 'HEAD');

            let clones = 0;
            // Checked out at the built commit alone, as the job's checkout is.
            const clone = () => {
                const dir = path.join(base, `job-${clones++}`);
                fs.mkdirSync(dir);
                git(dir, 'init', '--quiet', '--initial-branch=develop');
                git(dir, 'remote', 'add', 'origin', `file://${origin}`);
                git(dir, 'fetch', '--quiet', '--depth=1', 'origin', builtSha);
                git(dir, 'checkout', '--quiet', 'FETCH_HEAD');
                return dir;
            };
            const run = (dir: string, version: string) => {
                for (const file of BUMP_FILES) {
                    const current = fs.readFileSync(path.join(dir, file), 'utf8');
                    fs.writeFileSync(path.join(dir, file), current.replace(/\d+\.\d+\.\d+/, version));
                }
                const output = path.join(base, `output-${clones}-${version}`);
                fs.writeFileSync(output, '');
                execFileSync('bash', ['-c', script], {
                    cwd: dir,
                    stdio: 'pipe',
                    env: {
                        PATH: process.env.PATH,
                        HOME: base,
                        GIT_CONFIG_GLOBAL: '/dev/null',
                        GITHUB_OUTPUT: output,
                        REF_NAME: 'develop',
                        BUILT_SHA: builtSha,
                        NEW_VERSION: version,
                        BUMP_TYPE: 'patch',
                    },
                });
                return fs.readFileSync(output, 'utf8').trim();
            };
            check({ origin, builtSha, clone, run });
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    };

    test('the first run commits the bump on top of the built commit and pushes it', () => {
        withOrigin(({ origin, builtSha, clone, run }) => {
            const output = run(clone(), '1.0.1');

            const tip = git(origin, 'rev-parse', 'develop');
            expect(output).toBe(`sha=${tip}`);
            expect(git(origin, 'rev-parse', 'develop^')).toBe(builtSha);
            expect(git(origin, 'log', '-1', '--format=%s', 'develop')).toBe(
                'Bump version to 1.0.1 (patch) and update documentation [skip ci]',
            );
        });
    });

    test('a re-run after the bump was pushed reuses it instead of committing again', () => {
        withOrigin(({ origin, builtSha, clone, run }) => {
            run(clone(), '1.0.1');
            const pushed = git(origin, 'rev-parse', 'develop');

            const second = clone();
            const output = run(second, '1.0.1');

            expect(output).toBe(`sha=${pushed}`);
            expect(git(origin, 'rev-parse', 'develop')).toBe(pushed);
            expect(git(origin, 'rev-list', '--count', `${builtSha}..develop`)).toBe('1');
            // Nothing was committed in the re-run's own checkout either.
            expect(git(second, 'rev-parse', 'HEAD')).toBe(builtSha);
        });
    });

    test('a branch tip that bumps to another version is not reused: the push is refused and the job stops', () => {
        withOrigin(({ origin, clone, run }) => {
            run(clone(), '1.0.1');
            const pushed = git(origin, 'rev-parse', 'develop');

            expect(() => run(clone(), '1.0.2')).toThrow();
            expect(git(origin, 'rev-parse', 'develop')).toBe(pushed);
        });
    });

    test('a branch that moved on with another commit is not reused: the push is refused and the job stops', () => {
        withOrigin(({ origin, builtSha, clone, run }) => {
            const other = path.join(path.dirname(origin), 'other');
            git(path.dirname(origin), 'clone', '--quiet', `file://${origin}`, other);
            git(other, 'config', 'user.email', 'other@example.com');
            git(other, 'config', 'user.name', 'Other');
            fs.writeFileSync(path.join(other, 'later.txt'), 'a push that landed since\n');
            git(other, 'add', '.');
            git(other, 'commit', '-m', 'A later commit');
            git(other, 'push', 'origin', 'develop');
            const moved = git(origin, 'rev-parse', 'develop');
            expect(git(origin, 'rev-parse', 'develop^')).toBe(builtSha);

            expect(() => run(clone(), '1.0.1')).toThrow();
            expect(git(origin, 'rev-parse', 'develop')).toBe(moved);
        });
    });

    test('a branch tip on the built commit itself (nothing pushed yet) is committed on, not reused', () => {
        withOrigin(({ origin, builtSha, clone, run }) => {
            expect(git(origin, 'rev-parse', 'develop')).toBe(builtSha);

            run(clone(), '1.0.1');

            expect(git(origin, 'rev-parse', 'develop')).not.toBe(builtSha);
        });
    });
});

describe('version bump type', () => {
    const script = stepNamed(build.jobs['version-bump'], 'Determine version bump type').run ?? '';

    const bumpFor = (message: string) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-type-'));
        try {
            const output = path.join(directory, 'output');
            fs.writeFileSync(output, '');
            execFileSync('bash', ['-c', script], {
                env: { PATH: process.env.PATH, COMMIT_MSG: message, GITHUB_OUTPUT: output },
            });
            return fs.readFileSync(output, 'utf8').trim();
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    };

    test.each([
        ['Add a thing [major]', 'BUMP_TYPE=major'],
        ['Add a thing [minor]', 'BUMP_TYPE=minor'],
        ['Add a thing [patch]', 'BUMP_TYPE=patch'],
        ['Add a thing', 'BUMP_TYPE=patch'],
        ['[major] first line wins\n\nbody mentions [minor]', 'BUMP_TYPE=major'],
    ])('%j selects %s', (message, expected) => {
        expect(bumpFor(message)).toBe(expected);
    });

    test.each([
        ['a body token does not promote the release', 'Fix a bug\n\n* Squashed: [major] rewrite'],
        ['a body [minor] does not either', 'Fix a bug\n\nNotes: [minor]'],
    ])('%s', (_label, message) => {
        expect(bumpFor(message)).toBe('BUMP_TYPE=patch');
    });
});

describe('test workflow', () => {
    test('checks that the committed third-party notices are up to date', () => {
        const step = stepNamed(testWorkflow.jobs.test, 'Verify third-party notices are up to date');
        expect(step.run).toContain('pnpm build:notices');
        expect(step.run).toContain('git diff --quiet -- src/assets/THIRD_PARTY_NOTICES.txt');
    });

    test('tells a contributor with stale notices how to fix them', () => {
        const step = stepNamed(testWorkflow.jobs.test, 'Verify third-party notices are up to date');
        expect(step.run).toMatch(/::error::.*pnpm build:notices.*src\/assets\/THIRD_PARTY_NOTICES\.txt/);
        expect(step.run).toContain('exit 1');
    });

    test('points at pnpm-workspace.yaml for the audit exceptions that live there', () => {
        expect(text('.github/workflows/test.yml')).not.toContain('`auditConfig` in package.json');
        expect(text('pnpm-workspace.yaml')).toMatch(/^auditConfig:/m);
    });
});

describe('CLI build Node version', () => {
    test('both CLI build jobs pin the Node whose LICENSE the notices vendor', () => {
        const { NODE_LICENSE_VERSION } =
            require('../scripts/build-notices') as typeof import('../scripts/build-notices');
        const pinned = (job: Job, name: string) => stepNamed(job, name).with?.['node-version'];
        expect(pinned(build.jobs.build, 'Setup Node.js 26 for CLI builds')).toBe(NODE_LICENSE_VERSION);
        expect(pinned(build.jobs['build-cli-arm'], 'Setup Node.js 26 for CLI build')).toBe(NODE_LICENSE_VERSION);
    });
});
