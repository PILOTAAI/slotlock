# Publishing the language clients

Each release publishes the five clients in `clients/` at the package's version. `release.yml` runs
one job per registry once its "Verify, test and pack" job has passed, and each job waits for a
maintainer to approve its environment (`scripts/configure-github.sh` creates them, with whoever
runs it as the required reviewer). The versions move together: `scripts/prepare-release.sh` sets
every client's manifest and User-Agent constant to the release (`scripts/client-versions.sh`), and
`scripts/check-release-tag.sh` refuses a release where one disagrees.

| Client | Registry and name | Job and environment | Credential |
| --- | --- | --- | --- |
| Python | PyPI, `slotlock` | `pypi` | Trusted publishing (OIDC); no token stored |
| Rust | crates.io, `slotlock` | `crates-io` | Trusted publishing (OIDC), after a first manual publish |
| .NET | NuGet, `Slotlock.Client` | `nuget` | Trusted publishing (OIDC); no token stored |
| Java | Maven Central, `io.pylota:slotlock` | `maven-central` | Central Portal user token and a signing key, in the environment |
| Go | `github.com/PILOTAAI/slotlock/clients/go` | `go-module` | `GITHUB_TOKEN` pushes the `clients/go/v<version>` tag |

Approving an environment is the human gate for PyPI, crates.io, NuGet and Go: once approved, the
job publishes. Maven Central has a second gate: the job uploads a deployment that waits in the
Central Portal until a maintainer publishes it there.

Maven Central holds 0.3.0 only (checked 2026-10-29: `https://repo1.maven.org/maven2/io/pylota/slotlock/maven-metadata.xml`
lists 0.3.0, and `…/0.4.0/` and `…/0.5.3/` answer 404): the 0.4.x and 0.5.x deployments were
uploaded but never published in the Central Portal. Until the one-time setup below is done for a
registry, its job fails at the publish step and the other jobs carry on; re-run the failed job once
the setup is in place.

## After each release

Do these for every version `<v>`, once its Release run has finished:

1. Approve the `pypi`, `crates-io`, `nuget`, `maven-central` and `go-module` environments in the
   Release run, and check each job passed.
2. Publish the Central Portal deployment: central.sonatype.com > Publishing > Deployments, check
   `slotlock-<v>` validated, and click **Publish**. `scripts/central-bundle.sh` uploads it as
   `USER_MANAGED`, so nothing reaches Maven Central until you do.
3. Verify Maven Central serves it: `curl -sI https://repo1.maven.org/maven2/io/pylota/slotlock/<v>/`
   returns 200. Central can take up to an hour after publishing; until it does, the Java client of
   `<v>` is pending, not released.

## One-time setup, by the repository owner

Run `scripts/configure-github.sh` first: it creates the five environments, each limited to `v*`
tags, with you as the required reviewer.

Then `scripts/configure-registries.sh --tag v<version>` does the rest that can be done from a
terminal, and prints the exact values for each web form that cannot:

- **PyPI, NuGet and crates.io trusted publishing:** each is added only in that registry's web form.
  The script prints the four values (owner, repository, `release.yml`, environment).
- **crates.io's first version:** published from the tag with a token you paste once.
- **NuGet:** the `NUGET_USER` variable.
- **Maven Central:** the Portal token (checked with the Portal before it is stored), and a new
  signing key, which it proves can sign, sends to keyserver.ubuntu.com and stores. Gradle reads only
  the ASCII-armored secret key with its line breaks: base64 of it, or the public key, fails with
  "Could not read PGP secret key".
- **Cloudflare:** the site secrets, through `configure-github.sh --site-secrets`.
- **The release:** the failed jobs of the tag's run, re-run.

The sections below are what it automates, step by step.

### PyPI

1. Sign in to pypi.org with two-factor authentication.
2. Account > Publishing > Add a new pending publisher (GitHub): PyPI project name `slotlock`,
   owner `PILOTAAI`, repository `slotlock`, workflow `release.yml`, environment `pypi`.
   A pending publisher creates the project at its first publish and does not reserve the name
   before then (docs.pypi.org/trusted-publishers/creating-a-project-through-oidc), so do this
   shortly before the release that first publishes the client.

### crates.io

crates.io accepts trusted publishing only for a crate that already exists: the first version is
published by hand (blog.rust-lang.org, 2025-07-11).

1. Sign in to crates.io with GitHub and create an API token scoped to `publish-new` for the crate
   `slotlock`, with a short expiry.
2. From a clean checkout of the release tag: `cd clients/rust && cargo publish --locked`, with the
   token in `CARGO_REGISTRY_TOKEN`. Then revoke the token.
3. In the crate's Settings > Trusted Publishing, add GitHub: owner `PILOTAAI`, repository
   `slotlock`, workflow `release.yml`, environment `crates-io`.

### NuGet

1. Sign in to nuget.org. Under your username > Trusted Publishing, add a policy: repository owner
   `PILOTAAI`, repository `slotlock`, workflow file `release.yml`, environment `nuget`
   (learn.microsoft.com/nuget/nuget-org/trusted-publishing).
2. Set the repository variable `NUGET_USER` to your nuget.org profile name (not your email):
   Settings > Secrets and variables > Actions > Variables.

### Maven Central

Maven Central has no trusted publishing; the Central Portal takes a user token
(central.sonatype.org/publish/publish-portal-api).

1. Create an account at central.sonatype.com and register the namespace `io.pylota`. Verify it with
   the DNS TXT record the Portal gives you, on `pylota.io` itself
   (central.sonatype.org/register/namespace).
2. Create a signing key for the project (`gpg --full-generate-key`, with a passphrase) and send its
   public half to a key server Central reads, for example
   `gpg --keyserver keyserver.ubuntu.com --send-keys <fingerprint>`
   (central.sonatype.org/publish/requirements/gpg).
3. Generate a Portal user token, and store three secrets in the `maven-central` environment:
   `CENTRAL_PORTAL_TOKEN` (the base64 of `<username>:<password>` of the token),
   `MAVEN_SIGNING_KEY` (`gpg --armor --export-secret-keys <fingerprint>`) and
   `MAVEN_SIGNING_PASSWORD`.
4. At each release, publish the deployment and verify it, as [After each release](#after-each-release)
   steps 2 and 3 say.

### Go

Nothing to create. The `go-module` job pushes the annotated tag `clients/go/v<version>` on the
release commit and asks proxy.golang.org for it, which lists it for `go get` and pkg.go.dev. The
"Release tags are permanent" ruleset keeps anyone but an admin from moving or deleting the tag.

## Installing a published client

```sh
pip install slotlock==<version>
cargo add slotlock@<version>
dotnet add package Slotlock.Client --version <version>
go get github.com/PILOTAAI/slotlock/clients/go@v<version>
```

Gradle: `implementation("io.pylota:slotlock:<version>")`.
