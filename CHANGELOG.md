# Changelog

A tag `v<version>` publishes the image and the GitHub release (`.github/workflows/release.yml`); the release notes are
the section of this file under `## <version>`. A version with a `-` (such as `0.1.0-rc.1`) is a pre-release.

## 0.2.4

Executor 0.7.3, unchanged.

- The Deployer's own settings on the page (D45): Environment variables has a "Deployer" card for administrators.
  - What the Deployer needs before it opens its state database stays in `deployer.env` and is only shown there: the
    credential and compare keys and the emergency password hash (shown only as set or not), the peer key hashes,
    secure cookies, where it listens, its base path, data directory and `environment.json`.
  - Workbench's addresses, the release and issue repositories, OMA's address and ids, the Builder addresses, UAT's
    address and the daily brief's hour can be set there. They are kept in the state database, checked together before
    any is kept, and each change goes to the audit.
  - Tokens (the `*_FILE` settings) are pasted there, kept sealed with `DEPLOYER_CREDENTIAL_ENCRYPTION_KEY` and never
    shown again. The Workbench API key works as before: checked against Workbench and in effect at once.
  - A value set in `deployer.env` wins and the page cannot change it: remove the line there to set it on the page.
  - A change applies at the next start. The page marks what is waiting and can restart the Deployer: it exits and the
    container's restart policy (`restart: unless-stopped`) starts it again; refused while a job is running. Only in
    the image (`DEPLOYER_RESTART_BY_EXIT=true`).

**Tried before this release**
- On a test container built from this version (no Workbench, the emergency account): a batch with a bad value is
  refused as a whole, a token never comes back, the restart came back in 2 seconds through the restart policy, and
  the saved values were in effect afterwards while the file's value still won.

## 0.2.3

Executor 0.7.3, unchanged; only the page changed.

- Apps & manifests: the form for registering an app or changing its manifest says what to do in three steps
  (paste or open deploy.json, Check, Save), opens the file from disk or takes it dropped on the box, offers a starting
  template for a new app, and says why Check is not available yet. Changing the text after a check asks for a new
  check before Save, so what is saved is what was checked. An empty registry says how to add the first app.

## 0.2.2

Executor 0.7.3, unchanged; only the page changed.

- Confirmations open in the page's own dialog, in its style and colour scheme, instead of the browser's `confirm()`.
  Each confirm button is named after its action; on destructive ones (remove, revoke, stop a deploy, go back a
  version) it is red and Enter stays on Cancel. Escape or a click outside cancels.

## 0.2.1

Executor 0.7.3; the Deployer is unchanged apart from carrying it. Upgrade the executors from the Overview after the
Deployer.

- Executor 0.7.3: a data directory made beforehand and still empty (by another account on the host) now goes to the user
  the image runs as, like a new one, and the job log says so; before, only a missing directory did, and Workbench
  (1000) could not write to one made by another account. A directory with files in it keeps its owner.

## 0.2.0

First setup (D41): a new installation goes from `bootstrap.sh` on the server to Workbench signing people in on one
Setup page, and then lists what the AI features still need. Executor 0.7.2, unchanged. An installation on 0.1.0
upgrades from the Overview as before; it opens on the Setup page until its Workbench is 1.24.0 or newer and the
deploy groups exist, both done from that page.

**First setup (D41, phase 1)**
- A new installation opens on a Setup page, the only page until Workbench signs people in and the Deployer has its
  Workbench API key. Each step is checked on the spot: environment settings, executors, the Workbench manifest,
  deploying Workbench, signing in with Workbench, the API key.
- The first environment settings can be made from a form on that page; `environment.json` is still imported when present.
- The image ships Workbench's manifest (from 1.25.1, image from GHCR, no build) for a one-click import while the
  registry has no Workbench. PROD still takes its manifests from UAT.
- The emergency account can issue and revoke executor tokens, so a new host can be connected before Workbench exists.
- Each release attaches `open-atlas-deployer-setup-<version>.tar.gz`: `bootstrap.sh` installs the executor, lays out
  the Deployer's directory with its keys generated into `deployer.env` (the emergency password goes to a mode 600
  file, never printed), creates the apps' network as compose would, and starts the Deployer.

**First setup (D41, phase 2)**
- The Deployer's Workbench API key can be pasted on the Setup page: it is tried against Workbench, kept sealed with
  the credential key and used at once. A key in `DEPLOYER_WORKBENCH_API_KEY_FILE` still wins. API keys and the
  maintenance notice now work with either.
- A new Workbench's environment variables are generated on the Setup page; the initial admin's password is in that
  answer only. Workbench's app menu gets a link to the Deployer (`WORKBENCH_APP_LINKS`).
- A Workbench the Deployer did not deploy (1.24.0 or newer) is taken over: import its env file, deploy it once.
- Setup checks that the Workbench API key works and creates the missing deploy groups; it is complete once the
  Deployer runs Workbench, the key works and the groups exist.
- When Workbench is behind nginx, the recommended nginx configuration is saved from the Workbench step, since the
  Ingress page is not open until setup is complete.

**First setup (D41, phase 3)**
- Once setup is complete, the Setup page lists what the AI features need (L3), each checked on the spot against OMA
  and Workbench: OMA deployed by this Deployer and answering, the Deployer's OMA key and Application, the Deploy
  Assistant and the Onboarding Assessor with its Environment, a service key in an OMA Vault for the Deployer's
  `/mcp`, the "Deploy Assistant" Business Agent, and the Deployer's entry in Workbench (`chat.embed`).
  `GET /api/setup/ai`; deploys do not depend on it. OMA shows a Vault's credentials only to its owner, so when the
  Deployer's key cannot list them, a service key that has been used counts; the Application id is a note, not a step.
- An installation whose Workbench (deployed by the Deployer) is older than 1.24.0 is asked to deploy 1.25.1 or newer
  from the Setup page before the deploy groups are created.
- The Overview's "Setup complete" line says how many AI items are open; the Deploy Assistant panel and the
  Onboarding page say what they still miss.
- The Deployer registers itself in Workbench's application list with one click (an application entry that embeds
  the chat, visible to the deploy groups); an entry that is there keeps its other fields. An address the browser
  would not embed on Workbench's page (http inside https, another site) is refused, and an entry with one is not done.
- `examples/oma.manifest.json`: a starting point for registering OMA (no build, `oma-beta-v{version}` images, one
  data directory for both services).

**Tried before this release**
- On the local UAT (a real Workbench and OMA), upgraded in place from 0.1.0: Workbench 1.23.1 to 1.25.1 from the Setup
  page, the deploy groups, the AI checklist against what runs, registering the Deployer in Workbench and opening it
  from there with the embedded chat, OMA 0.1.0-beta.8 to beta.9 with the example manifest.

**Known limits**
- `bootstrap.sh` on a fresh server and the setup steps before Workbench answers have run only in tests and on a
  local test instance, not on a real server.
- OMA's settings stay in `deployer.env` (a restart after changing them); the Business Agent is created in Workbench.

## 0.1.0

The first release: the same code as 0.1.0-rc.5, with executor 0.7.2. What it does is under 0.1.0-rc.1; the release
candidates after it fixed what trying them turned up.

**What it does**
- Deploys apps from manifests the Deployer keeps (per app and version range), through an executor on each host, with
  a plan before every deploy, backups, rollback and an audit log.
- Promotes to PROD only what UAT has run, by UAT's image digests and with UAT's manifest revision; an administrator
  can skip the rule with a reason.
- Upgrades itself and its executors from the Overview's Platform area, from this repository's releases.
- Environment variables, environment settings and nginx configuration as revisions; API keys and an MCP endpoint,
  with admin tools for manifests and settings; the Deploy Assistant and failure diagnosis through OMA.

**Tried before this release**
- On a local UAT and PROD (one machine): installing from this repository's releases, upgrading the Deployer and the
  executors from the page, a missing version refused before anything stops, promotion and its block, the admin MCP
  tools.

**Known limits**
- Not yet installed on a real server: the executor's `install.sh` (root, systemd) and a system nginx have not run
  there. Report what a first installation runs into; fixes follow in 0.1.x.
- Checking that the versions affected by a manifest's new image source have images there follows in 0.1.x (saving
  such a manifest warns).
- The Deployer's version list is cached for 5 minutes: a release just published may need "Other version…".

## 0.1.0-rc.5

- Executor 0.7.2, for upgrading the Deployer (D16):
  - when `docker compose up` itself fails on the new version (a port taken, a container in the way), the upgrade goes
    back to the previous image and state; before, it stopped there with `.env` already naming the new version;
  - it refuses before touching anything when the Deployer's `compose.yaml` names a different project than
    `EXECUTOR_DEPLOYER_PROJECT` (the executor's `-p` wins over the file, so it would have stopped another project).
- Found upgrading a local UAT and PROD on one machine; upgrade the executors from the Platform area after the Deployer.

## 0.1.0-rc.4

- MCP: an administrator's personal key can revoke API keys with `revoke_key` (it was listed but always refused, since
  `/mcp` takes only keys). Making a key stays on the page.
- Tried the admin MCP tools from a client: reading and saving environment settings (a repeated `request_id` saves
  once), manifests read-only on PROD, PROD deploys refused to keys, every call in the audit log with its key.

## 0.1.0-rc.3

- Environment variables: values saved before the first import (a new environment, where the file does not exist on
  the server yet) are no longer buried under the empty imported revision: they come back as the newest revision, so
  the next write still carries them. Importing a file the Deployer already wrote or imported adds no revision.
- Tried on a local UAT and PROD together: promotion by UAT's digests, the block on versions UAT has not run, the
  administrator override.
- Not in 0.1.0: checking that the versions affected by a manifest's new image source have images there. Saving such
  a manifest still warns to deploy those versions in UAT again first; the check follows in 0.1.x.

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
