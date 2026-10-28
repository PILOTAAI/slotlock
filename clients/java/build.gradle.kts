// A client for Slotlock's REST API. No runtime dependencies: java.net.http and a strict JSON codec
// of its own. Build and test with Gradle 9: `gradle test` (SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY run
// the suite against a server).
plugins {
    `java-library`
    `maven-publish`
    signing
}

group = "io.pylota"
version = "0.4.0"
description = "A client for Slotlock's REST API: calendars AI agents cannot double-book."

repositories {
    mavenCentral()
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

java {
    withSourcesJar()
    withJavadocJar()
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 17
    options.encoding = "UTF-8"
    options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror"))
}

tasks.withType<Javadoc>().configureEach {
    (options as StandardJavadocDocletOptions).apply {
        addBooleanOption("Xdoclint:all", true)
        addBooleanOption("Xwerror", true)
    }
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

// Maven Central: release.yml's maven-central job runs `gradle publishMavenPublicationToBundleRepository`
// with the signing key in its environment, then scripts/central-bundle.sh uploads build/central-bundle
// as a deployment a maintainer publishes. Central requires the name, description, URL, licence,
// developers and SCM below, and a signature on every file (central.sonatype.org/publish/requirements).
publishing {
    publications {
        create<MavenPublication>("maven") {
            artifactId = "slotlock"
            from(components["java"])
            pom {
                name = "Slotlock"
                description = project.description
                url = "https://slotlock.pylota.io"
                licenses {
                    license {
                        name = "Apache-2.0"
                        url = "https://www.apache.org/licenses/LICENSE-2.0"
                    }
                }
                developers {
                    developer {
                        id = "cleverom"
                        name = "TREFT LTD"
                        url = "https://github.com/PILOTAAI/slotlock/blob/main/MAINTAINERS.md"
                    }
                }
                scm {
                    url = "https://github.com/PILOTAAI/slotlock"
                    connection = "scm:git:https://github.com/PILOTAAI/slotlock.git"
                    developerConnection = "scm:git:ssh://git@github.com/PILOTAAI/slotlock.git"
                }
            }
        }
    }
    repositories {
        maven {
            name = "bundle"
            url = uri(layout.buildDirectory.dir("central-bundle"))
        }
    }
}

// Signs only where the release job provides the key (ASCII-armoured, from the maven-central
// environment); a local or CI build signs nothing and needs no key. A key without a passphrase takes
// an empty one: with none at all, Gradle configures no signatory.
val signingKey = providers.environmentVariable("MAVEN_SIGNING_KEY")
if (signingKey.isPresent) {
    signing {
        useInMemoryPgpKeys(
            signingKey.get(),
            providers.environmentVariable("MAVEN_SIGNING_PASSWORD").getOrElse(""),
        )
        sign(publishing.publications["maven"])
    }
}
