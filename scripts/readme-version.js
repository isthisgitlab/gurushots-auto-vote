#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const check = process.argv.includes('--check');
const root = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!version) {
    console.error('No version in package.json');
    process.exit(1);
}

// The pattern source matches any prior version via the `v` placeholder regex below — the
// current `version` value is never spliced into the pattern, so no regex escaping is
// needed there. It IS spliced verbatim into the *replacement* string, which honours
// String.replace back-reference sequences ($&, $', $`, $$, $n), so escape `$` → `$$`
// in case a pre-release tag ever contains one.
const vRepl = version.replace(/\$/g, '$$$$');

const v = `[\\d.]+(?:-[a-zA-Z0-9.]+)?`;
const dl = `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download`;

// Each rule: [pattern, replacement, requirement]. Update mode rewrites every match;
// --check mode flags both stale matches AND zero matches when the rule is required.
// Requirement values:
//   'always' — required in every file (GUI download artifacts; every install doc must list them)
//   'cli'    — required only in files that already contain a CLI section (matches the old
//              verify-readme-version.js `required: hasCLISection` logic; INSTALACIJA.md skips,
//              README enforces because it has gurucli-* references)
//   false    — optional everywhere
//
// Ordering note: `-linux-arm` rules MUST precede `-linux` because /-linux/ matches inside
// /-linux-arm/. Insert any new variants (e.g. `-linux-riscv`) BEFORE the bare `-linux` rules.
const rules = [
    [`\\*\\*Latest Version: v${v}`, `**Latest Version: v${vRepl}`, 'always'],
    [`GuruShotsAutoVote-v${v}-x64\\.exe`, `GuruShotsAutoVote-v${vRepl}-x64.exe`, 'always'],
    [`GuruShotsAutoVote-v${v}-arm64\\.dmg`, `GuruShotsAutoVote-v${vRepl}-arm64.dmg`, 'always'],
    [`GuruShotsAutoVote-v${v}-arm64\\.app\\.zip`, `GuruShotsAutoVote-v${vRepl}-arm64.app.zip`, 'always'],
    [`GuruShotsAutoVote-v${v}-x86_64\\.AppImage`, `GuruShotsAutoVote-v${vRepl}-x86_64.AppImage`, 'always'],
    [`GuruShotsAutoVote-v${v}-arm64\\.AppImage`, `GuruShotsAutoVote-v${vRepl}-arm64.AppImage`, 'always'],
    [`GuruShotsAutoVote-v${v}\\.apk`, `GuruShotsAutoVote-v${vRepl}.apk`, 'always'],
    [`gurucli-v${v}-mac`, `gurucli-v${vRepl}-mac`, 'cli'],
    [`gurucli-v${v}-linux-arm`, `gurucli-v${vRepl}-linux-arm`, 'cli'],
    [`gurucli-v${v}-linux`, `gurucli-v${vRepl}-linux`, 'cli'],
    [`${dl}/GuruShotsAutoVote-v${v}-x64\\.exe`, `${dl}/GuruShotsAutoVote-v${vRepl}-x64.exe`, 'always'],
    [`${dl}/GuruShotsAutoVote-v${v}-arm64\\.dmg`, `${dl}/GuruShotsAutoVote-v${vRepl}-arm64.dmg`, 'always'],
    [`${dl}/GuruShotsAutoVote-v${v}-arm64\\.app\\.zip`, `${dl}/GuruShotsAutoVote-v${vRepl}-arm64.app.zip`, 'always'],
    [`${dl}/GuruShotsAutoVote-v${v}-x86_64\\.AppImage`, `${dl}/GuruShotsAutoVote-v${vRepl}-x86_64.AppImage`, 'always'],
    [`${dl}/GuruShotsAutoVote-v${v}-arm64\\.AppImage`, `${dl}/GuruShotsAutoVote-v${vRepl}-arm64.AppImage`, 'always'],
    [`${dl}/GuruShotsAutoVote-v${v}\\.apk`, `${dl}/GuruShotsAutoVote-v${vRepl}.apk`, 'always'],
    [`${dl}/gurucli-v${v}-mac`, `${dl}/gurucli-v${vRepl}-mac`, 'cli'],
    [`${dl}/gurucli-v${v}-linux-arm`, `${dl}/gurucli-v${vRepl}-linux-arm`, 'cli'],
    [`${dl}/gurucli-v${v}-linux`, `${dl}/gurucli-v${vRepl}-linux`, 'cli'],
    [`chmod \\+x GuruShotsAutoVote-v${v}-\\*\\.AppImage`, `chmod +x GuruShotsAutoVote-v${vRepl}-*.AppImage`, false],
    [`\\./GuruShotsAutoVote-v${v}-\\*\\.AppImage`, `./GuruShotsAutoVote-v${vRepl}-*.AppImage`, false],
    [`\\./gurucli-v${v}-\\[platform\\]`, `./gurucli-v${vRepl}-[platform]`, false],
    // Latvian (INSTALACIJA.md) localizes the placeholder as `[platforma]`; without this
    // rule those example lines are invisible to update/verify and silently drift on bumps.
    [`\\./gurucli-v${v}-\\[platforma\\]`, `./gurucli-v${vRepl}-[platforma]`, false],
];

const files = [path.join(root, 'README.md'), path.join(root, 'docs', 'INSTALACIJA.md')];

let anyFailure = false;
let totalChanges = 0;

for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const name = path.relative(root, file);
    const original = fs.readFileSync(file, 'utf8');
    let content = original;
    let changes = 0;
    let fileFailed = false;
    // A file is treated as having a CLI section if it already references the gurucli binary.
    // 'cli' rules are required only for such files (matches the old verify script's hasCLISection).
    const hasCLI = original.includes('gurucli-v') || original.includes('CLI Applications');

    for (const [pattern, replacement, required] of rules) {
        const isRequired = required === 'always' || (required === 'cli' && hasCLI);
        const re = new RegExp(pattern, 'g');
        const matched = content.match(re);
        if (!matched || matched.length === 0) {
            if (isRequired && check) {
                console.error(
                    `✗ ${name}: required pattern /${pattern}/ has zero matches — section may have been removed`,
                );
                fileFailed = true;
            }
            continue;
        }
        const correct = matched.every((m) => m === replacement);
        if (correct) continue;
        if (check) {
            console.error(`✗ ${name}: ${matched.length} occurrence(s) of /${pattern}/ do not match v${version}`);
            fileFailed = true;
        } else {
            content = content.replace(re, replacement);
            changes += matched.length;
        }
    }

    if (fileFailed) {
        anyFailure = true;
    } else if (!check && content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        console.log(`✓ ${name}: ${changes} occurrence(s) updated to v${version}`);
        totalChanges += changes;
    } else if (!check) {
        console.log(`✓ ${name}: already at v${version}`);
    } else {
        console.log(`✓ ${name}: matches v${version}`);
    }
}

if (check && anyFailure) {
    console.error(`\nRun \`pnpm run update:readme\` to fix.`);
    process.exit(1);
}
if (!check) {
    console.log(`\n${totalChanges} total replacement(s) for v${version}.`);
}
