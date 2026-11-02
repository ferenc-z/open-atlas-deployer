# Changelog

A tag `v<version>` publishes the image and the GitHub release (`.github/workflows/release.yml`); the release notes are
the section of this file under `## <version>`. A version with a `-` (such as `0.1.0-rc.1`) is a pre-release.

## Unreleased

- Environment variables: values saved before the first import (a new environment, where the file does not exist on
  the server yet) are no longer buried under the empty imported revision: they come back as the newest revision, so
  the next write still carries them. Importing a file the Deployer already wrote or imported adds no revision.

## 0.1.0-rc.2

- The Deploy Assistant says why it is blank: when Workbench's chat has not loaded after 10 seconds (Workbench
  unreachable, or a certificate the browser does not trust), the panel says so, links to Workbench in a new tab and
  offers to try again.
- Executor 0.7.1: the same code as 0.7.0, released so hosts can try upgrading an executor from GitHub.
- Development: `npm run dev:web` no longer sends the page's own `api.ts` to the API server.

## 0.1.0-rc.1

The first release candidate: everything below is new.

**Deploying**
- Manifests per app and version range turn into compose fragments; deploys run from a plan (versions, hosts, steps,
  blocking findings) through an executor on each host; failed deploys roll back, and rollback keeps the manifest the
  version was deployed with.
- Promotion: PROD deploys only versions UAT has run, and takes UAT's manifest revision with them (PROD manifests are
  read-only). The registry page on PROD can take every app's manifests from UAT at once.
- App drivers for Workbench applications, Studio graphs and OMA agents; env files with schemas and encrypted values;
  ingress through nginx with saved configuration revisions.

**Running the platform**
- The Deployer is a container image (`ghcr.io/ferenc-z/open-atlas-deployer`), installed with `examples/deployer`.
- Executors (Python 3.9+, systemd) talk to the Deployer over HTTPS long-poll with per-host tokens, and upgrade
  themselves from the release `executor-v<version>`, checked against its SHA256SUMS, rolling back if the new one does
  not start.
- The Deployer upgrades itself through the executor on its host (D16): back up the data, switch the image, wait for
  the new version, otherwise restore.
- Overview's Platform area holds every upgrade: the Deployer (versions from `DEPLOYER_RELEASE_REPO`, plan first,
  confirmation for older versions) and the executors (one host at a time, stopping on failure).
- Environment settings live in the state database with revisions (imported from `environment.json` on the first
  start), edited on the Environment settings page.

**People and agents**
- Sign-in through Workbench; personal and service API keys; an MCP endpoint with deploy tools and, for admins, tools
  to read and save manifests, environment settings and nginx configuration, revoke tokens and keys, and read the audit.
- The Deploy Assistant beside the page, failure diagnosis and the daily brief through OMA, assessments of new apps and
  versions, drift reports.

**Before 0.1.0**
- Not yet run on real UAT and PROD servers together; MCP admin tools not yet tried from a real client.
- Checking that the versions affected by a manifest's new image source have images there is not done yet.
