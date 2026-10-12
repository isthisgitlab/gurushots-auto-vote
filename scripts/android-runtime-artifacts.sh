#!/usr/bin/env bash
# Regenerates the two lists the third-party notices test holds the Android notices to, from the release APK's runtime
# classpath (`:app:dependencies --configuration releaseRuntimeClasspath`):
#
#   android/release-runtime-artifacts.txt  the libraries the release APK ships (group:artifact, sorted, one per line)
#   android/release-runtime-notices.txt    the ones of them whose jar or aar (or a jar inside it) carries a META-INF/NOTICE* file
#
# CI runs it in the Android job and fails when either file differs from the committed one;
# scripts/android-verification-metadata.sh runs it too, so a dependency change regenerates all of it in one go.
#
#   scripts/android-runtime-artifacts.sh
#
# Needs: JDK 21 (JAVA_HOME or on PATH), the Android SDK (android/local.properties or ANDROID_HOME), a network or a Gradle
# cache, and `cap sync android` already done (`pnpm build:prep && pnpm exec cap sync android`), as for any local Android
# build. No Docker.

set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
artifacts="$repo/android/release-runtime-artifacts.txt"
notices="$repo/android/release-runtime-notices.txt"

# Everything is written beside its target and moved into place only once both lists exist, so a failed run leaves the
# committed files as they were; whatever is left over is removed on the way out.
work=$(mktemp -d)
new_artifacts=$(mktemp "$artifacts.XXXXXX")
new_notices=$(mktemp "$notices.XXXXXX")
cleanup() {
    rm -rf "$work"
    rm -f "$new_artifacts" "$new_notices"
}
trap cleanup EXIT

# Prints "SCANNED group:artifact" for every module of the release runtime classpath it opened, "NOTICE group:artifact"
# for the ones whose jar, or a jar inside its aar (classes.jar, libs/*.jar), has a META-INF/NOTICE* entry, and
# "UNSCANNED group:artifact" for a module that resolves to a file the scan did not open, "NOFILE group:artifact" for a
# module of the resolved graph that has no file at all (a BOM or platform), and "FAILED <reason>" for an artifact the
# configuration could not resolve, other than the Capacitor projects (the lenient views would otherwise skip it
# silently).
cat > "$work/notices.init.gradle" <<'GRADLE'
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.attributes.Attribute

allprojects {
    tasks.register('printRuntimeNotices') {
        doLast {
            def isNotice = { String name -> name ==~ /(?i)META-INF\/NOTICE.*/ }
            def hasNotice = { File file ->
                def found = false
                new ZipFile(file).withCloseable { zip ->
                    zip.entries().each { ZipEntry entry ->
                        if (isNotice(entry.name)) found = true
                        if (entry.name == 'classes.jar' || entry.name ==~ /libs\/[^\/]+\.jar/) {
                            new ZipInputStream(zip.getInputStream(entry)).withCloseable { nested ->
                                ZipEntry inner
                                while ((inner = nested.nextEntry) != null) {
                                    if (isNotice(inner.name)) found = true
                                }
                            }
                        }
                    }
                }
                found
            }
            // A module is an aar or a jar as published; the view takes each kind, and skips what the other kind lacks.
            def withNotice = new TreeSet<String>()
            def scanned = new TreeSet<String>()
            ['aar', 'jar'].each { String kind ->
                def view = configurations.getByName('releaseRuntimeClasspath').incoming.artifactView { config ->
                    config.lenient = true
                    config.attributes { attrs -> attrs.attribute(Attribute.of('artifactType', String), kind) }
                }
                view.artifacts.artifacts.each { artifact ->
                    def id = artifact.id.componentIdentifier
                    if (id instanceof ModuleComponentIdentifier) {
                        scanned.add("${id.group}:${id.module}".toString())
                        if (hasNotice(artifact.file)) withNotice.add("${id.group}:${id.module}".toString())
                    }
                }
            }
            // Lenient resolution skips what a view cannot take, so what resolves to a file at all is asked of a view
            // that takes whatever the configuration gives; a module it lists that was not opened is a gap in the scan,
            // and an artifact it failed to resolve is reported rather than hidden.
            def resolved = new TreeSet<String>()
            def everything = configurations.getByName('releaseRuntimeClasspath').incoming.artifactView { config ->
                config.lenient = true
            }.artifacts
            everything.artifacts.each { artifact ->
                def id = artifact.id.componentIdentifier
                if (id instanceof ModuleComponentIdentifier) resolved.add("${id.group}:${id.module}".toString())
            }
            // The Capacitor projects (npm packages, not Maven artifacts) are ambiguous for a view without attributes and
            // are not what is scanned; a failure about any other component is a module the scan cannot see.
            def failures = everything.failures.collect { it.message.readLines().first() }.findAll { !(it ==~ /.*project ':.*/) }
            // A module of the resolved graph with no file at all is a BOM or a platform: there is nothing to open.
            def noFile = new TreeSet<String>()
            configurations.getByName('releaseRuntimeClasspath').incoming.resolutionResult.allComponents.each { component ->
                def id = component.id
                if (id instanceof ModuleComponentIdentifier) {
                    def coordinate = "${id.group}:${id.module}".toString()
                    if (!resolved.contains(coordinate)) noFile.add(coordinate)
                }
            }
            scanned.each { println "SCANNED ${it}" }
            withNotice.each { println "NOTICE ${it}" }
            resolved.findAll { !scanned.contains(it) }.each { println "UNSCANNED ${it}" }
            noFile.each { println "NOFILE ${it}" }
            failures.each { println "FAILED ${it}" }
        }
    }
}
GRADLE

(
    cd "$repo/android"
    # The tree without version constraints ("(c)") and without the Capacitor projects (npm packages).
    ./gradlew --no-daemon --console=plain -q :app:dependencies --configuration releaseRuntimeClasspath > "$work/tree"
    ./gradlew --no-daemon --console=plain -q -I "$work/notices.init.gradle" :app:printRuntimeNotices > "$work/notices"
)

# A scan that opened nothing would report "no NOTICE" for everything, one that skipped a module that resolves to a
# file would hide its NOTICE, and an artifact that failed to resolve has no file to look in: each is a failure, not an
# empty answer.
sed -nE 's/^SCANNED ([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)$/\1/p' "$work/notices" > "$work/scanned"
if [ ! -s "$work/scanned" ]; then
    echo "The NOTICE scan opened no artifact of the release runtime classpath; nothing was written." >&2
    exit 1
fi
echo "==> scanned for a NOTICE file ($(wc -l < "$work/scanned" | tr -d ' ') artifacts):"
sed 's/^/    /' "$work/scanned"
unscanned=$(sed -nE 's/^UNSCANNED ([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)$/\1/p' "$work/notices")
if [ -n "$unscanned" ]; then
    echo "These release runtime artifacts resolve to a file the NOTICE scan did not open; nothing was written:" >&2
    echo "$unscanned" | sed 's/^/    /' >&2
    exit 1
fi

failed=$(sed -n 's/^FAILED //p' "$work/notices")
if [ -n "$failed" ]; then
    echo "These release runtime artifacts failed to resolve, so the NOTICE scan may have missed them; nothing was written:" >&2
    echo "$failed" | sed 's/^/    /' >&2
    exit 1
fi

grep -v ' (c)$' "$work/tree" |
    sed -nE 's/^[|+\\ -]*([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)([: ]|$).*/\1/p' |
    LC_ALL=C sort -u > "$new_artifacts"
if [ ! -s "$new_artifacts" ]; then
    echo "No release runtime artifacts were found in the Gradle output; nothing was written." >&2
    exit 1
fi
# Every artifact of the dependency tree has to be one the scan opened, or one that has no file (a BOM or platform).
sed -nE 's/^NOFILE ([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)$/\1/p' "$work/notices" > "$work/nofile"
unaccounted=$(LC_ALL=C sort -u "$work/scanned" "$work/nofile" | LC_ALL=C comm -13 - "$new_artifacts")
if [ -n "$unaccounted" ]; then
    echo "These release runtime artifacts were neither scanned for a NOTICE file nor are a BOM or platform; nothing was written:" >&2
    echo "$unaccounted" | sed 's/^/    /' >&2
    exit 1
fi
sed -nE 's/^NOTICE ([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)$/\1/p' "$work/notices" | LC_ALL=C sort -u > "$new_notices"

mv "$new_artifacts" "$artifacts"
mv "$new_notices" "$notices"
echo "==> $(wc -l < "$artifacts" | tr -d ' ') runtime artifacts, $(wc -l < "$notices" | tr -d ' ') with a NOTICE"
