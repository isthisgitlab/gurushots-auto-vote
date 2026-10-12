#!/usr/bin/env bash
# Regenerates android/gradle/verification-metadata.xml, the SHA-256 of every artifact Gradle resolves for the Android
# build (plugins, libraries, the Gradle-side tooling), which CI checks on every run, and
# android/release-runtime-artifacts.txt, the libraries the release APK ships (group:artifact, one per line), which the
# third-party notices test holds the notices' Android component list to.
#
# Run it after any change to the Android dependency graph: android/build.gradle, android/app/build.gradle,
# android/variables.gradle, a Capacitor plugin, or the Gradle wrapper. Dependabot's npm PRs that bump @capacitor/* change
# the Android dependencies too; run it on the PR branch and commit the result.
#
#   scripts/android-verification-metadata.sh
#
# Needs: JDK 21 (JAVA_HOME or on PATH), the Android SDK (android/local.properties or ANDROID_HOME), Docker, a network,
# and the web build + `cap sync android` already done (`pnpm build:prep && pnpm exec cap sync android`), as for any
# local Android build.
#
# Two passes write the one file, because some artifacts depend on the operating system (the aapt2 jar is `-osx` on a
# Mac and `-linux` on CI's ubuntu-latest): the host's, then a linux/amd64 container's (the platform CI runs on).
# Gradle merges what the second pass resolves into what the first wrote. Both start from an empty Gradle home, so every
# checksum is computed from a fresh download, never from a cache that something else may have written.
#
# What is covered is the task list below, the tasks CI runs (.github/workflows/test.yml and build.yml) plus `lint`.
# Robolectric's own downloads of its android-all runtime jars happen at test time, outside Gradle, and are not covered.

set -euo pipefail

TASKS=(testDebugUnitTest jacocoTestReport jacocoTestCoverageVerification assembleRelease lint)
# A tag, not a digest: the image only supplies a JDK and a shell; what is verified is the downloaded artifacts.
CONTAINER_IMAGE="eclipse-temurin:21-jdk"
# The hash of the Android SDK licence text AGP needs accepted before it downloads SDK packages.
LICENSE_HASH="24333f8a63b6825ea9c5514f83c2829b004d1fee"

# The pass inside the container. Gradle insists on writable project directories, so the repo is mounted read-write; the
# build directories are moved out of it (an init script) so the host's own build outputs are left alone. The tests run
# there only so that their dependencies are resolved: under amd64 emulation on an arm64 host they are slow enough for
# timing-sensitive ones (MockWebServer shutdown) to fail, which must not stop the metadata from being written; the host
# pass is the one that has to be green.
in_container() {
    export ANDROID_HOME=/tmp/android-sdk
    mkdir -p "$HOME" "$ANDROID_HOME/licenses"
    printf '\n%s\n' "$LICENSE_HASH" > "$ANDROID_HOME/licenses/android-sdk-license"
    cat > /tmp/relocate-build.init.gradle <<'GRADLE'
allprojects {
    layout.buildDirectory.set(new File("/tmp/gradle-out/" + (path == ":" ? "root" : path.substring(1).replace(':', '_'))))
    tasks.withType(Test).configureEach { ignoreFailures = true }
}
GRADLE
    cd /work/android
    ./gradlew --no-daemon --console=plain --project-cache-dir /tmp/gradle-project-cache -I /tmp/relocate-build.init.gradle \
        --continue --write-verification-metadata sha256 --rerun-tasks "${TASKS[@]}"
}

if [ "${1:-}" = "--in-container" ]; then
    in_container
    exit 0
fi

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
metadata="$repo/android/gradle/verification-metadata.xml"
runtime_artifacts="$repo/android/release-runtime-artifacts.txt"

# A failed run puts the previous file back rather than leave half of one.
succeeded=false
restore() {
    "$succeeded" && return 0
    rm -f "$metadata"
    if [ -f "$metadata.bak" ]; then mv "$metadata.bak" "$metadata"; fi
}
trap restore EXIT
rm -f "$metadata.bak"
if [ -f "$metadata" ]; then mv "$metadata" "$metadata.bak"; fi
tree=$(mktemp)

echo "==> host pass ($(uname -s))"
(
    cd "$repo/android"
    export GRADLE_USER_HOME
    GRADLE_USER_HOME=$(mktemp -d)
    ./gradlew --no-daemon --console=plain --write-verification-metadata sha256 --rerun-tasks "${TASKS[@]}"
    # The release runtime classpath without version constraints ("(c)") and the Capacitor projects (npm packages).
    ./gradlew --no-daemon --console=plain -q :app:dependencies --configuration releaseRuntimeClasspath > "$tree"
)
grep -v ' (c)$' "$tree" |
    sed -nE 's/^[|+\\ -]*([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)([: ]|$).*/\1/p' |
    LC_ALL=C sort -u > "$runtime_artifacts"
rm -f "$tree"

echo "==> linux/amd64 pass ($CONTAINER_IMAGE)"
mounts=(-v "$repo:/work")
# local.properties names the host's SDK; the container has its own.
if [ -f "$repo/android/local.properties" ]; then mounts+=(-v /dev/null:/work/android/local.properties:ro); fi
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/home -e GRADLE_USER_HOME=/tmp/gradle-home \
    "${mounts[@]}" "$CONTAINER_IMAGE" \
    bash /work/scripts/android-verification-metadata.sh --in-container

succeeded=true
rm -f "$metadata.bak"
echo "==> $(grep -c '<component ' "$metadata") components in android/gradle/verification-metadata.xml"
