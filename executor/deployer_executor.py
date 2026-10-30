#!/usr/bin/env python3
"""Open Atlas Deployer host executor (design §8.2, D29).

Runs on the host as a systemd service; the Deployer's container has no Docker socket and no registry
credentials, so everything that touches Docker happens here. The two sides only exchange files in the
handoff directory (written to a temporary name, then renamed):

    handoff/requests/<id>.json   Deployer: one job (build, deploy, env, env-read), protocol 1
    handoff/jobs/<id>/request.json   the executor claims a request by moving it here
    handoff/jobs/<id>/status.json    executor: state, steps, result
    handoff/jobs/<id>/log.txt        executor: every command and its output (never compose config output,
                                     which holds env values)
    handoff/jobs/<id>/env.content    env-read: the app's env file, 0600 and owned by the Deployer; removed after 10 minutes
    handoff/executor.json            executor heartbeat: version, protocols, job kinds, what this host has configured

It only performs a fixed set of actions. A request never carries a command: a build runs the pinned
release tools' build-images.sh, a deploy writes a compose fragment that first passes a policy check on
`docker compose config` (no privileged mode, no host namespaces, bind mounts only inside the app's
directory, images only from registered registries or pinned public ones). Every image is pinned to the
digest it was pulled at, so a rollback restores exactly what ran before. An env job writes one app's env
file (its content checked against its hash and removed from the request on pickup) and restarts the
services that read it, putting the previous file back if they do not come up.

Phase 5: a deploy's release files may come from a GitHub Release asset (the app's bundle), downloaded here and
checked against the sha256 the Deployer recorded; and a deploy may run database migrations (db-migration): the
scripts of the release, in name order, each in one transaction with its record in deployer.migrations, through
psql inside the database container, after the database is up and before the rest of the app starts.

Standard library only; Python 3.9 (Rocky 9's python3).
"""
import base64
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

VERSION = "0.3.0"
PROTOCOLS = [1]
# Job kinds, plus what a deploy may ask for (bundle files, migrations): an older executor is not sent those.
KINDS = ["build", "deploy", "env", "env-read", "bundle", "db-migration"]
ENV_FILE_RE = re.compile(r"^[a-z0-9][a-z0-9.-]*\.env$")
ENV_MAX_BYTES = 1024 * 1024
ENV_COPY_SECONDS = 600
BUILD_JSON_IN_IMAGE = "/opt/open-atlas/BUILD.json"
APP_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$")
SERVICE_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
ASSET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMPONENT_RE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
# Runs psql in the database container as the image's own superuser, on its local socket; arguments follow.
PSQL = 'exec psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" "$@"'
MIGRATIONS_TABLE = ("CREATE SCHEMA IF NOT EXISTS deployer; CREATE TABLE IF NOT EXISTS deployer.migrations ("
                    "component text NOT NULL, name text NOT NULL, kind text NOT NULL, sha256 text NOT NULL, "
                    "applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (component, name));")
FINAL = ("succeeded", "failed", "rolled-back", "refused")


class Refused(Exception):
    """The request is not something this executor does; nothing was changed."""


class Failed(Exception):
    """A step failed after it started."""


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, value, mode=0o644):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def load_env_file(path):
    out = {}
    if not path or not pathlib.Path(path).is_file():
        return out
    for line in pathlib.Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def config(env_file=None, environ=None):
    e = dict(load_env_file(env_file))
    e.update({k: v for k, v in (environ or os.environ).items() if k.startswith("EXECUTOR_")})
    root = pathlib.Path(e.get("EXECUTOR_ROOT", "/webapp/data/open-atlas"))
    deployer = root / "deployer"
    db = {}
    for k, v in e.items():
        m = re.match(r"^EXECUTOR_DB_(DUMP|RESTORE)_([A-Z0-9_]+)$", k)
        if m and v:
            db.setdefault(m.group(2).lower().replace("_", "-"), {})[m.group(1).lower()] = shlex.split(v)
    return {
        "root": root,
        "project": e.get("EXECUTOR_PROJECT", "open-atlas"),
        "handoff": pathlib.Path(e.get("EXECUTOR_HANDOFF", str(deployer / "handoff"))),
        "state_file": pathlib.Path(e.get("EXECUTOR_STATE_FILE", str(deployer / "state" / "containers.jsonl"))),
        "backups": pathlib.Path(e.get("EXECUTOR_BACKUPS", str(deployer / "backups"))),
        "work": pathlib.Path(e.get("EXECUTOR_WORK", "/var/lib/open-atlas-deployer-executor")),
        "registries": [r.rstrip("/") for r in e.get("EXECUTOR_REGISTRIES", "").split()],
        "bind_roots": [pathlib.Path(p) for p in e.get("EXECUTOR_BIND_ROOTS", "").split()],
        "token_file": e.get("EXECUTOR_GITHUB_TOKEN_FILE", ""),
        "github_api": e.get("EXECUTOR_GITHUB_API", "https://api.github.com").rstrip("/"),
        "tools_repo": e.get("EXECUTOR_TOOLS_REPO", "gaojie197710-tech/open-atlas-release"),
        "health_seconds": int(e.get("EXECUTOR_HEALTH_SECONDS", "300")),
        "keep_backups": int(e.get("EXECUTOR_KEEP_BACKUPS", "3")),
        "poll_seconds": float(e.get("EXECUTOR_POLL_SECONDS", "2")),
        "state_seconds": float(e.get("EXECUTOR_STATE_SECONDS", "30")),
        "db": db,
    }


# --- what a deploy fragment may and may not do --------------------------------------------------------

HOST_MODES = ("network_mode", "pid", "ipc", "userns_mode", "cgroup", "uts")


def image_allowed(ref, registries):
    """Images come from a registered registry, or are public with a pinned tag or digest (D4, §5.1)."""
    name = ref.split("@", 1)[0]
    first = name.split("/", 1)[0]
    if "/" in name and ("." in first or ":" in first or first == "localhost"):
        return any(name == r or name.startswith(r + "/") for r in registries)
    if "@sha256:" in ref:
        return True
    tag = name.rsplit(":", 1)[1] if ":" in name.rsplit("/", 1)[-1] else ""
    return bool(tag) and tag != "latest"


def policy_findings(cfg, app, services, compose_json):
    """Problems with this app's services in the normalized compose config; empty when allowed."""
    found = []
    app_dir = (cfg["root"] / app).resolve()
    roots = [app_dir] + [p.resolve() for p in cfg["bind_roots"]]
    all_services = compose_json.get("services", {})
    for name in services:
        s = all_services.get(name)
        if s is None:
            found.append(f"{name}: not in the fragment")
            continue
        if s.get("privileged"):
            found.append(f"{name}: privileged is not allowed")
        for key in ("cap_add", "devices", "device_cgroup_rules"):
            if s.get(key):
                found.append(f"{name}: {key} is not allowed")
        for key in HOST_MODES:
            v = str(s.get(key) or "")
            if v == "host" or v.startswith("container:") or v.startswith("service:"):
                found.append(f"{name}: {key}: {v} is not allowed")
        for opt in s.get("security_opt") or []:
            if "unconfined" in str(opt) or "no-new-privileges:false" in str(opt):
                found.append(f"{name}: security_opt {opt} is not allowed")
        if s.get("build"):
            found.append(f"{name}: build is not allowed (images are built by a build job)")
        image = s.get("image") or ""
        if not image_allowed(image, cfg["registries"]):
            found.append(f"{name}: image {image} is neither from a registered registry nor a pinned public image")
        for v in s.get("volumes") or []:
            if v.get("type") != "bind":
                continue
            src = pathlib.Path(v.get("source", "")).resolve()
            if "docker.sock" in str(src):
                found.append(f"{name}: mounting the Docker socket is not allowed")
            elif not any(src == r or r in src.parents for r in roots):
                found.append(f"{name}: bind mount {src} is outside {app_dir} and EXECUTOR_BIND_ROOTS")
    return found


def unset_variables(stderr):
    """Compose only warns about an unset ${KEY} and uses a blank string (design §7.3), so the executor refuses.
    Compose 5 logs it as: level=warning msg="The \\"GREETING\\" variable is not set. Defaulting to a blank string."
    """
    return sorted(set(re.findall(r'The \\?"?(\w+)\\?"? variable is not set', stderr)))


def repository(ref):
    """ghcr.io/acme/shop:1.2.0@sha256:… → ghcr.io/acme/shop"""
    name = ref.split("@", 1)[0]
    return name.rsplit(":", 1)[0] if ":" in name.rsplit("/", 1)[-1] else name


def pinned(ref, digest):
    return f"{ref.split('@', 1)[0]}@{digest}"


def published_ports(compose_json, services):
    out = {}
    for name in services:
        for p in (compose_json.get("services", {}).get(name, {}).get("ports") or []):
            if p.get("published"):
                out[int(p["published"])] = name
    return out


def ports_in_use(docker_ps_lines, exclude_services, project):
    """Host ports published by containers other than this app's own services in this project."""
    used = {}
    for line in docker_ps_lines:
        if not line.strip():
            continue
        c = json.loads(line)
        labels = dict(pair.split("=", 1) for pair in (c.get("Labels") or "").split(",") if "=" in pair)
        if labels.get("com.docker.compose.project") == project and labels.get("com.docker.compose.service") in exclude_services:
            continue
        if c.get("State") != "running":
            continue
        for m in re.finditer(r":(\d+)->", c.get("Ports") or ""):
            used[int(m.group(1))] = labels.get("com.docker.compose.service") or c.get("Names", "")
    return used


# --- the executor -------------------------------------------------------------------------------------

class Executor:
    def __init__(self, cfg, out=sys.stdout):
        self.cfg = cfg
        self.out = out
        self.log_file = None
        self.last_state = 0.0

    # Host access. Tests replace these.
    def sh(self, args, cwd=None, env=None, check=True, timeout=None, input=None, quiet=False):
        full_env = dict(os.environ, **(env or {}))
        if cwd:
            full_env["PWD"] = str(cwd)
        p = subprocess.run(args, cwd=cwd, env=full_env, capture_output=True, text=True, timeout=timeout, input=input)
        if self.log_file:
            output = f"[output not logged]\n" if quiet else f"{p.stdout}{p.stderr}"
            with open(self.log_file, "a") as f:
                f.write(f"$ {' '.join(shlex.quote(a) for a in args)}\n{output}[exit {p.returncode}]\n")
        if check and p.returncode != 0:
            raise Failed(f"{' '.join(args[:3])} failed (exit {p.returncode}): {(p.stderr or p.stdout).strip()[-600:]}")
        return p

    def pipe(self, args, out=None, src=None, timeout=3600):
        """A database dump (stdout to `out`, mode 600) or restore (stdin from `src`); only messages are logged."""
        stdout = os.fdopen(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") if out else subprocess.PIPE
        stdin = open(src, "rb") if src else subprocess.DEVNULL
        try:
            p = subprocess.run(args, cwd=self.cfg["root"], stdin=stdin, stdout=stdout, stderr=subprocess.PIPE, timeout=timeout)
        finally:
            for f in (stdout, stdin):
                if hasattr(f, "close"):
                    f.close()
        messages = ("" if out else p.stdout.decode(errors="replace")) + p.stderr.decode(errors="replace")
        self.log(f"$ {' '.join(shlex.quote(a) for a in args)} {'>' if out else '<'} {out or src}\n{messages}[exit {p.returncode}]")
        if p.returncode != 0:
            raise Failed(f"{args[0]} failed (exit {p.returncode}): {messages.strip()[-400:]}")

    def sleep(self, seconds):
        time.sleep(seconds)

    def log(self, text):
        if self.log_file:
            with open(self.log_file, "a") as f:
                f.write(text.rstrip("\n") + "\n")

    def say(self, msg):
        print(f"{now_iso()} {msg}", file=self.out, flush=True)

    def token(self):
        f = self.cfg["token_file"]
        return pathlib.Path(f).read_text().strip() if f and pathlib.Path(f).is_file() else ""

    def git_env(self):
        """Authentication for git over HTTPS through the environment, never on the command line."""
        env = {"GIT_TERMINAL_PROMPT": "0"}
        token = self.token()
        if token:
            basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
            env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}"})
        return env

    def clone(self, repo, tag, dest):
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        self.sh(["git", "clone", "--quiet", "--depth", "1", "--branch", tag, f"https://github.com/{repo}.git", str(dest)], env=self.git_env())

    def compose(self, *args, check=True, quiet=False, file="compose.yaml", input=None):
        return self.sh(["docker", "compose", "-p", self.cfg["project"], "-f", file, *args], cwd=self.cfg["root"], check=check, quiet=quiet, input=input)

    def http_get(self, url, accept, auth=True):
        """GitHub's API. A redirect (an asset's download URL) is followed without the token."""
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        token = self.token() if auth else ""
        headers = {"Accept": accept, "User-Agent": "open-atlas-deployer-executor", **({"Authorization": f"Bearer {token}"} if token else {})}
        opener = urllib.request.build_opener(NoRedirect)
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                return self.http_get(e.headers["Location"], accept, auth=False)
            raise Failed(f"GET {url.split('?')[0]} failed: HTTP {e.code}")
        except urllib.error.URLError as e:
            raise Failed(f"GET {url.split('?')[0]} failed: {e.reason}")

    # --- the loop -----------------------------------------------------------------------------------

    def heartbeat(self, busy=None):
        db = {app: {"dump": "dump" in v, "restore": "restore" in v} for app, v in self.cfg["db"].items()}
        write_json(self.cfg["handoff"] / "executor.json", {
            "version": VERSION, "protocols": PROTOCOLS, "kinds": KINDS, "at": now_iso(), "pid": os.getpid(),
            "project": self.cfg["project"], "registries": self.cfg["registries"], "databaseBackup": db, "busy": busy,
        })

    def report_state(self, force=False):
        """The project's containers for the status page (what host/report-state.sh did in phase 1)."""
        if not force and time.monotonic() - self.last_state < self.cfg["state_seconds"]:
            return
        self.last_state = time.monotonic()
        p = self.sh(["docker", "ps", "-a", "--no-trunc", "--filter", f"label=com.docker.compose.project={self.cfg['project']}",
                     "--format", "{{json .}}"], check=False)
        if p.returncode != 0:
            return
        f = self.cfg["state_file"]
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f".{f.name}.tmp")
        tmp.write_text(p.stdout)
        os.chmod(tmp, 0o644)
        os.replace(tmp, f)

    def recover(self):
        """A job left running by a previous process was interrupted: say so instead of leaving it running."""
        jobs = self.cfg["handoff"] / "jobs"
        for status_file in jobs.glob("*/status.json") if jobs.is_dir() else []:
            status = json.loads(status_file.read_text())
            if status.get("state") not in FINAL:
                status.update(state="failed", finishedAt=now_iso(),
                              message="The executor stopped while this job ran; check the app before deploying again.")
                write_json(status_file, status)

    def next_request(self):
        requests = self.cfg["handoff"] / "requests"
        if not requests.is_dir():
            return None
        for f in sorted(requests.glob("*.json"), key=lambda p: p.stat().st_mtime):
            job_id = f.stem
            target = self.cfg["handoff"] / "jobs" / job_id
            if not ID_RE.match(job_id) or target.exists():
                f.rename(f.with_suffix(".rejected"))
                continue
            target.mkdir(parents=True)
            os.replace(f, target / "request.json")
            return target
        return None

    def remove_env_copies(self):
        """An env-read copy is for the Deployer to import within seconds; it does not stay in the handoff directory."""
        jobs = self.cfg["handoff"] / "jobs"
        for f in jobs.glob("*/env.content") if jobs.is_dir() else []:
            if time.time() - f.stat().st_mtime > ENV_COPY_SECONDS:
                f.unlink(missing_ok=True)

    def run_once(self):
        self.heartbeat()
        self.report_state()
        self.remove_env_copies()
        job_dir = self.next_request()
        if not job_dir:
            return False
        self.handle(job_dir)
        self.report_state(force=True)
        return True

    def serve(self):
        self.say(f"executor {VERSION} for project {self.cfg['project']} at {self.cfg['root']}")
        self.cfg["work"].mkdir(parents=True, exist_ok=True)
        self.recover()
        self.selfcheck()
        while True:
            try:
                if not self.run_once():
                    self.sleep(self.cfg["poll_seconds"])
            except Exception as e:  # keep serving; the job itself already recorded its failure
                self.say(f"error: {e}")
                self.sleep(self.cfg["poll_seconds"])

    def selfcheck(self):
        """After an upgrade, launch.sh counts starts until this clears the marker (§8.6)."""
        self.sh(["docker", "version", "--format", "{{.Server.Version}}"])
        for d in ("requests", "jobs"):
            (self.cfg["handoff"] / d).mkdir(parents=True, exist_ok=True)
        if not os.access(self.cfg["handoff"], os.W_OK):
            raise SystemExit(f"cannot write {self.cfg['handoff']}")
        marker = self.cfg["work"] / "upgrade-pending"
        if marker.exists():
            marker.unlink()
            self.say("upgrade self-check passed")

    # --- one job --------------------------------------------------------------------------------------

    def handle(self, job_dir):
        self.log_file = job_dir / "log.txt"
        self.log_file.touch()
        os.chmod(self.log_file, 0o644)
        status = {"protocol": 1, "id": job_dir.name, "state": "running", "startedAt": now_iso(), "steps": [], "result": {}}
        self.status_file = job_dir / "status.json"
        try:
            owner = (job_dir / "request.json").stat().st_uid
            request = json.loads((job_dir / "request.json").read_text())
            if "content" in request:
                # The env content has been read; it does not stay on disk beside the job.
                write_json(job_dir / "request.json", {k: v for k, v in request.items() if k != "content"}, mode=0o600)
            status.update(kind=request.get("kind"), app=request.get("app"), version=request.get("version"))
            self.write_status(status)
            self.heartbeat(busy=job_dir.name)
            if request.get("protocol") not in PROTOCOLS:
                raise Refused(f"protocol {request.get('protocol')} is not supported (this executor speaks {PROTOCOLS})")
            if request.get("kind") == "build":
                self.build(request, status)
            elif request.get("kind") == "deploy":
                self.deploy(request, status)
            elif request.get("kind") == "env":
                self.env_write(request, status)
            elif request.get("kind") == "env-read":
                self.env_read(request, status, job_dir, owner)
            else:
                raise Refused(f"unknown job kind {request.get('kind')}")
        except Refused as e:
            self.finish(status, "refused", str(e))
        except Exception as e:
            if status["state"] not in FINAL:
                self.finish(status, "failed", str(e))
        finally:
            self.log_file = None
            self.heartbeat()

    def write_status(self, status):
        write_json(self.status_file, status)

    def step(self, status, name, state="running", message=None):
        steps = status["steps"]
        if steps and steps[-1]["state"] == "running" and state == "running":
            steps[-1]["state"] = "done"
        if state == "running":
            steps.append({"name": name, "state": "running", "at": now_iso()})
        else:
            for s in reversed(steps):
                if s["name"] == name:
                    s["state"] = state
                    if message:
                        s["message"] = message
                    break
        self.write_status(status)
        self.log(f"--- {name} {state}{': ' + message if message else ''}")
        self.say(f"{status['id']} {name} {state}")

    def finish(self, status, state, message):
        for s in status["steps"]:
            if s["state"] == "running":
                s["state"] = "done" if state == "succeeded" else "failed"
        status.update(state=state, finishedAt=now_iso(), message=message)
        self.write_status(status)
        self.log(f"=== {state}: {message}")
        self.say(f"{status['id']} {state}: {message}")

    # --- build: the pinned release tools' build-images.sh (§5.2) ----------------------------------------

    def build(self, req, status):
        app, version, b = req.get("app", ""), req.get("version", ""), req.get("build") or {}
        registry, image = (req.get("registry") or "").rstrip("/"), req.get("image", "")
        if not APP_RE.match(app) or not VERSION_RE.match(version):
            raise Refused("app or version is malformed")
        if not REPO_RE.match(b.get("repo", "")) or version not in b.get("tag", ""):
            raise Refused("build.repo or build.tag is malformed")
        if b.get("script") != "build-images.sh":
            raise Refused("only open-atlas-release's build-images.sh builds images")
        if registry not in self.cfg["registries"]:
            raise Refused(f"registry {registry} is not registered on this host (EXECUTOR_REGISTRIES)")
        if image != f"open-atlas-{app}":
            raise Refused(f"build-images.sh names the image open-atlas-{app}, the manifest says {image}")
        platform = b.get("platform", "linux/amd64")
        if platform not in ("linux/amd64", "linux/arm64"):
            raise Refused(f"platform {platform} is not supported")

        src = self.cfg["work"] / "src" / f"{app}-{version}-{status['id']}"
        try:
            self.step(status, "clone")
            self.clone(b["repo"], b["tag"], src)
            commit = self.sh(["git", "-C", str(src), "rev-parse", "HEAD"]).stdout.strip()
            status["result"]["commit"] = commit

            self.step(status, "tools")
            tools_version = (src / "tools.lock").read_text().strip()
            if not re.match(r"^\d+\.\d+\.\d+$", tools_version):
                raise Failed(f"tools.lock holds {tools_version!r}")
            tools = self.cfg["work"] / "tools" / f"release-tools-{tools_version}"
            if not (tools / "scripts/release/build-images.sh").is_file():
                self.clone(self.cfg["tools_repo"], f"release-tools-{tools_version}", tools)
            status["result"]["tools"] = tools_version

            self.step(status, "build")
            self.sh(["bash", str(tools / "scripts/release/build-images.sh"), app, "--source", str(src),
                     "--platform", platform, "--registry", registry, "--push"], timeout=3 * 3600)

            self.step(status, "verify-build")
            build_json = self.sh(["python3", str(tools / "scripts/release/layout.py"), str(src), app, "build_json"]).stdout.strip()
            info = json.loads(pathlib.Path(build_json if os.path.isabs(build_json) else src / build_json).read_text())
            if info.get("version") != version or info.get("commit") != commit or info.get("dirty"):
                raise Failed(f"BUILD.json says {info.get('version')} {str(info.get('commit'))[:12]} dirty={info.get('dirty')}, "
                             f"expected {version} {commit[:12]} clean")
            ref = f"{registry}/{image}:{version}"
            digests = json.loads(self.sh(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", ref]).stdout or "[]")
            digest = next((d.split("@", 1)[1] for d in digests if d.startswith(f"{registry}/{image}@")), None)
            if not digest:
                raise Failed(f"{ref} has no digest in {registry}: was it pushed?")
            status["result"].update(image=ref, digest=digest, build=info)
            self.finish(status, "succeeded", f"built and pushed {ref}@{digest[:19]}")
        finally:
            shutil.rmtree(src, ignore_errors=True)

    # --- deploy: one app's fragment, pinned, checked, switched, verified, rolled back (§8.1, §8.3) ---------

    def deploy(self, req, status):
        cfg, root = self.cfg, self.cfg["root"]
        app, version = req.get("app", ""), req.get("version", "")
        services = req.get("services") or []
        if not APP_RE.match(app) or not VERSION_RE.match(version):
            raise Refused("app or version is malformed")
        if not services or not all(SERVICE_RE.match(s) for s in services):
            raise Refused("services are missing or malformed")
        migrations = req.get("migrations") or []
        for m in migrations:
            if not COMPONENT_RE.match(m.get("component", "")) or m.get("service") not in services:
                raise Refused("a migration names a malformed component or a service outside this app")
            if any(m.get(k) and (".." in m[k].split("/") or m[k].startswith("/")) for k in ("install", "migrations")):
                raise Refused("a migration directory is malformed")
        fragment, root_text = req.get("fragment", ""), req.get("root", "")
        if f'name: "{cfg["project"]}"' not in root_text:
            raise Refused(f"the root compose file is not for project {cfg['project']}")
        entry = f'"{app}/compose.yaml"'
        if root_text.count(entry) != 1:
            raise Refused(f"the root compose file must include {app}/compose.yaml exactly once")
        app_dir = root / app
        state = app_dir / ".deployer"
        next_fragment, next_root = app_dir / ".compose.next.yaml", root / ".compose.next.yaml"
        files_next = app_dir / ".files.next"
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")

        # 1. files from the release tag (volumes.file), staged beside the current ones
        self.step(status, "files")
        app_dir.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(files_next, ignore_errors=True)
        files = req.get("files")
        if files:
            self.fetch_files(files, files_next)

        # 2. pull every image and pin it to its digest
        self.step(status, "pull")
        digests = {}
        for im in req.get("images") or []:
            ref, pin = im["ref"], im.get("pin")
            if not image_allowed(ref, cfg["registries"]):
                raise Refused(f"image {ref} is neither from a registered registry nor a pinned public image")
            pull = pinned(ref, pin) if pin else ref
            self.sh(["docker", "pull", "--quiet", pull], timeout=3600)
            repo = repository(ref)
            found = json.loads(self.sh(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", pull]).stdout or "[]")
            names = (repo, repo.replace("docker.io/library/", "").replace("docker.io/", ""))
            digest = pin or next((d.split("@", 1)[1] for d in found if d.split("@", 1)[0] in names), None)
            if not digest:
                raise Failed(f"{ref} has no registry digest")
            digests[im["service"]] = digest
            line = f'image: "{ref}"'
            if line not in fragment:
                raise Refused(f"the fragment has no {line}")
            fragment = fragment.replace(line, f'image: "{pinned(ref, digest)}"')
            if im.get("build"):
                b = self.image_build(pinned(ref, digest))
                if not b or b.get("version") != version or b.get("dirty"):
                    raise Failed(f"{ref}: BUILD.json says {(b or {}).get('version')} dirty={(b or {}).get('dirty')}, expected {version} clean")
                status["result"].setdefault("builds", {})[im["service"]] = {"version": b.get("version"), "commit": b.get("commit")}
        status["result"]["digests"] = digests
        self.write_status(status)

        # 3. the new fragment must pass compose itself, every ${KEY} must be set, and the policy must allow it
        self.step(status, "validate")
        next_fragment.write_text(fragment)
        next_root.write_text(root_text.replace(entry, f'"{app}/.compose.next.yaml"'))
        try:
            p = self.compose("config", "--format", "json", file=next_root.name, check=False, quiet=True)
            if p.returncode != 0:
                raise Refused(f"docker compose rejected the new fragment: {p.stderr.strip()[-600:]}")
            unset = unset_variables(p.stderr)
            if unset:
                raise Refused(f"the env file does not set {', '.join(unset)}")
            normalized = json.loads(p.stdout)
            problems = policy_findings(cfg, app, services, normalized)
            if problems:
                raise Refused("the fragment is not allowed: " + "; ".join(problems))
            ps = self.sh(["docker", "ps", "--no-trunc", "--format", "{{json .}}"], quiet=True).stdout.splitlines()
            used = ports_in_use(ps, services, cfg["project"])
            clashes = [f"{port} ({used[port]})" for port in published_ports(normalized, services) if port in used]
            if clashes:
                raise Refused("host ports are taken by containers outside this app: " + ", ".join(clashes) +
                              "; stop them first (e.g. a service renamed by the manifest)")
        except Refused:
            next_fragment.unlink(missing_ok=True)
            next_root.unlink(missing_ok=True)
            shutil.rmtree(files_next, ignore_errors=True)
            raise

        # 4. back up the data (and the database, where this host has a dump command)
        self.step(status, "backup")
        images = {im["service"]: pinned(im["ref"], digests[im["service"]]) for im in req.get("images") or []}
        data_dirs = [(self.data_path(app_dir, d.get("path", "")), images.get(d.get("service"))) for d in req.get("dataDirs") or []]
        try:
            archives, dump = self.backup(app, version, stamp, services, [d for d, _ in data_dirs])
        except Exception as e:
            next_fragment.unlink(missing_ok=True)
            next_root.unlink(missing_ok=True)
            shutil.rmtree(files_next, ignore_errors=True)
            raise Failed(f"the backup failed, so nothing was changed: {e}")
        status["result"]["backups"] = [str(a) for _, a in archives] + ([str(dump)] if dump else [])

        # 5. switch: keep what ran before, put the new files in place, create missing data directories
        self.step(status, "switch")
        previous = state / "previous"
        shutil.rmtree(previous, ignore_errors=True)
        previous.mkdir(parents=True)
        had_previous = (app_dir / "compose.yaml").exists()
        if had_previous:
            shutil.copy2(app_dir / "compose.yaml", previous / "compose.yaml")
        if (root / "compose.yaml").exists():
            shutil.copy2(root / "compose.yaml", previous / "root.yaml")
            first = root / "compose.yaml.before-deployer"
            if not first.exists() and "Generated by Open Atlas Deployer" not in (root / "compose.yaml").read_text():
                shutil.copy2(root / "compose.yaml", first)
        if (app_dir / "files").exists():
            os.replace(app_dir / "files", previous / "files")
        if files_next.exists():
            os.replace(files_next, app_dir / "files")
        os.replace(next_fragment, app_dir / "compose.yaml")
        (root / ".compose.root.tmp").write_text(root_text)
        os.replace(root / ".compose.root.tmp", root / "compose.yaml")
        next_root.unlink(missing_ok=True)
        for d, image in data_dirs:
            self.ensure_data_dir(d, image)

        # 6. migrations first, with only the database running; then start everything, 7. verify
        problem = None
        if migrations:
            self.step(status, "migrate")
            targets = sorted({m["service"] for m in migrations})
            try:
                self.compose("up", "-d", "--no-build", "--pull", "never", *targets)
                problem = self.wait_healthy(targets, digests)
                if not problem:
                    status["result"]["migrations"] = self.migrate(app_dir, migrations)
                    self.write_status(status)
            except Failed as e:
                problem = str(e)
        self.step(status, "start")
        try:
            if not problem:
                self.compose("up", "-d", "--no-build", "--pull", "never", *services)
        except Failed as e:
            problem = str(e)
        if not problem:
            self.step(status, "verify")
            problem = self.wait_healthy(services, digests)
        if problem is None:
            self.step(status, "cleanup")
            self.remove_stale(app, services)
            self.prune_backups(app)
            self.finish(status, "succeeded", f"{app} {version} is running" + (", data backed up first" if archives or dump else ""))
            return
        self.rollback(status, req, app, services, problem, had_previous, previous, archives, dump, stamp)

    # --- env: write one app's env file and restart what reads it; read it for an import (§7.2) ------------

    def env_target(self, req):
        app, name = req.get("app", ""), req.get("file", "")
        if not APP_RE.match(app) or not ENV_FILE_RE.match(name):
            raise Refused("app or env file name is malformed")
        return app, self.cfg["root"] / name

    @staticmethod
    def write_private(path, data):
        tmp = path.with_name(f".{path.name}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)

    def env_write(self, req, status):
        app, target = self.env_target(req)
        content, services = req.get("content"), req.get("services") or []
        if not isinstance(content, str) or "\0" in content or len(content.encode()) > ENV_MAX_BYTES:
            raise Refused("the env content is missing, too large or not text")
        if hashlib.sha256(content.encode()).hexdigest() != req.get("sha256"):
            raise Refused("the env content does not match its sha256")
        if not all(SERVICE_RE.match(s) for s in services):
            raise Refused("services are malformed")
        app_dir = self.cfg["root"] / app
        if req.get("restart") and not (app_dir / "compose.yaml").exists():
            raise Refused(f"{app} has no compose fragment from the Deployer, so nothing of it can be restarted")

        self.step(status, "write")
        kept = app_dir / ".deployer" / "env.previous"
        kept.parent.mkdir(parents=True, exist_ok=True)
        had = target.is_file()
        if had:
            self.write_private(kept, target.read_bytes())
        else:
            kept.unlink(missing_ok=True)
        size = len(content.encode())
        self.write_private(target, content.encode())
        status["result"]["env"] = {"exists": True, "sha256": req["sha256"], "bytes": size}
        self.log(f"wrote {target} ({size} bytes, sha256 {req['sha256'][:12]}); the previous file is kept as {kept}")

        def put_back():
            if had:
                self.write_private(target, kept.read_bytes())
            else:
                target.unlink(missing_ok=True)

        if req.get("restart"):
            self.step(status, "validate")
            p = self.compose("config", "--format", "json", check=False, quiet=True)
            unset = unset_variables(p.stderr)
            if p.returncode != 0 or unset:
                put_back()
                raise Refused(f"the env file does not set {', '.join(unset)}; the previous file is back" if p.returncode == 0
                              else f"docker compose rejected the env file, the previous file is back: {p.stderr.strip()[-600:]}")
        if not services:
            self.finish(status, "succeeded", f"wrote {target.name}; nothing restarted")
            return

        self.step(status, "restart")
        problem = None
        try:
            # Compose recreates only the services whose configuration changed with the file.
            self.compose("up", "-d", "--no-build", "--pull", "never", *services)
        except Failed as e:
            problem = str(e)
        if not problem:
            self.step(status, "verify")
            problem = self.wait_healthy(services)
        if problem is None:
            status["result"]["restarted"] = services
            self.finish(status, "succeeded", f"wrote {target.name}; {', '.join(services)} running")
            return
        self.step(status, "verify", "failed", problem)
        self.step(status, "rollback")
        put_back()
        self.compose("up", "-d", "--no-build", "--pull", "never", *services, check=False)
        if self.wait_healthy(services) is None:
            self.finish(status, "rolled-back", f"{app} did not come up with the new env file ({problem}); the previous file is back")
        else:
            self.finish(status, "failed", f"{app} did not come up with the new env file ({problem}) nor with the previous one; it needs a person")

    def env_read(self, req, status, job_dir, owner):
        app, target = self.env_target(req)
        self.step(status, "read")
        if not target.is_file():
            status["result"]["env"] = {"exists": False}
            self.finish(status, "succeeded", f"there is no {target.name} on this host")
            return
        data = target.read_bytes()
        if len(data) > ENV_MAX_BYTES:
            raise Refused(f"{target.name} is larger than {ENV_MAX_BYTES} bytes")
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise Refused(f"{target.name} is not UTF-8")
        out = job_dir / "env.content"
        self.write_private(out, data)
        if os.geteuid() == 0 and owner != 0:
            os.chown(out, owner, -1)
        status["result"]["env"] = {"exists": True, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        self.finish(status, "succeeded", f"read {target.name} ({len(data)} bytes) for the Deployer to import")

    def data_path(self, app_dir, d):
        p = pathlib.Path(d)
        p = p if p.is_absolute() else app_dir / p
        resolved = p.resolve()
        roots = [app_dir.resolve()] + [r.resolve() for r in self.cfg["bind_roots"]]
        if not any(resolved == r or r in resolved.parents for r in roots):
            raise Refused(f"data directory {resolved} is outside {app_dir} and EXECUTOR_BIND_ROOTS")
        return resolved

    def ensure_data_dir(self, path, image):
        """A new data directory belongs to the user the image runs as (Studio 10001, Workbench 1000)."""
        if path.exists():
            return
        path.mkdir(parents=True)
        if not image or os.geteuid() != 0:
            return
        user = self.sh(["docker", "image", "inspect", "--format", "{{.Config.User}}", image], check=False).stdout.strip()
        m = re.match(r"^(\d+)(?::(\d+))?$", user)
        if m:
            os.chown(path, int(m.group(1)), int(m.group(2) or m.group(1)))

    def fetch_files(self, files, dest):
        """The release's files the fragment mounts read-only (e.g. Dossier's deploy/Caddyfile) or the migrations
        run: from the tag's tree, or from the release bundle when there is one."""
        paths = files.get("paths") or []
        if any(".." in p.split("/") or p.startswith("/") for p in paths):
            raise Refused("files.paths is malformed")
        bundle = files.get("bundle")
        if bundle:
            src, where = self.bundle_tree(bundle), f"bundle {bundle.get('asset')}"
        else:
            repo, tag = files.get("repo", ""), files.get("tag", "")
            if not REPO_RE.match(repo) or not tag:
                raise Refused("files.repo or files.tag is malformed")
            src, where = self.cfg["work"] / "files" / f"{repo.replace('/', '_')}-{tag}", f"{repo}@{tag}"
            self.clone(repo, tag, src)
        try:
            for rel in paths:
                s, d = src / rel, dest / rel
                if not s.exists():
                    raise Failed(f"{where} has no {rel}")
                d.parent.mkdir(parents=True, exist_ok=True)
                (shutil.copytree if s.is_dir() else shutil.copy2)(s, d)
        finally:
            shutil.rmtree(src, ignore_errors=True)

    def bundle_tree(self, b):
        """Downloads a release asset, checks it is the one the Deployer planned with, and unpacks its regular files."""
        repo, tag, asset, sha = b.get("repo", ""), b.get("tag", ""), b.get("asset", ""), b.get("sha256", "")
        if not REPO_RE.match(repo) or not TAG_RE.match(tag) or ".." in tag or not ASSET_RE.match(asset) or not SHA256_RE.match(sha):
            raise Refused("files.bundle is malformed")
        cache = self.cfg["work"] / "bundles" / repo.replace("/", "_") / tag.replace("/", "_") / asset
        if not cache.is_file() or hashlib.sha256(cache.read_bytes()).hexdigest() != sha:
            release = json.loads(self.http_get(f"{self.cfg['github_api']}/repos/{repo}/releases/tags/{urllib.request.quote(tag, safe='')}", "application/vnd.github+json"))
            found = next((a for a in release.get("assets") or [] if a.get("name") == asset), None)
            if not found:
                raise Failed(f"{repo} release {tag} has no asset {asset}")
            data = self.http_get(found["url"], "application/octet-stream")
            got = hashlib.sha256(data).hexdigest()
            if got != sha:
                raise Failed(f"{asset} is sha256:{got}, the plan was made with sha256:{sha}; the release asset changed")
            cache.parent.mkdir(parents=True, exist_ok=True)
            part = cache.with_name(cache.name + ".part")
            part.write_bytes(data)
            os.replace(part, cache)
        self.log(f"bundle {asset} sha256:{sha}")
        out = self.cfg["work"] / "files" / f"bundle-{sha[:16]}"
        shutil.rmtree(out, ignore_errors=True)
        with tarfile.open(cache, "r:gz") as tar:
            members = [m for m in tar.getmembers() if not m.isdir()]
            for m in members:
                if not m.isfile() or m.name.startswith("/") or ".." in m.name.split("/"):
                    raise Failed(f"{asset} holds {m.name}, which is not a plain file inside the bundle")
            names = [m.name[2:] if m.name.startswith("./") else m.name for m in members]
            tops = {n.split("/", 1)[0] if "/" in n else "" for n in names}
            strip = len(next(iter(tops))) + 1 if len(tops) == 1 and "" not in tops else 0
            for m, name in zip(members, names):
                target = out / name[strip:]
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(m) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        return out

    # --- db-migration (§8.3): the release's scripts in the database container -------------------------------

    def psql(self, service, *args, sql=None):
        return self.compose("exec", "-T", service, "sh", "-c", PSQL, "psql", *args, input=sql)

    def migrate(self, app_dir, migrations):
        """Each script not yet in deployer.migrations, in name order, in one transaction with its record."""
        applied = []
        for m in migrations:
            comp, svc = m.get("component", ""), m.get("service", "")
            self.psql(svc, sql=MIGRATIONS_TABLE)
            rows = self.psql(svc, "-tA", "-F", "|", "-c", f"SELECT name, kind, sha256 FROM deployer.migrations WHERE component = '{comp}'").stdout
            done = {r.split("|")[0]: r.split("|") for r in rows.splitlines() if r.count("|") == 2}
            for kind in ("install", "migrations"):
                d = m.get(kind)
                if not d:
                    continue
                src = app_dir / "files" / d
                if not src.is_dir():
                    raise Failed(f"{comp}: {d} is not a directory of the release files")
                scripts = sorted(p for p in src.iterdir() if p.is_file() and p.suffix == ".sql")
                if kind == "install":
                    # Scripts run once on an empty database (deploy-manifest v1): none recorded, no tables of the app yet.
                    tables = self.psql(svc, "-tA", "-c", "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'deployer')").stdout.strip()
                    if any(v[1] == "install" for v in done.values()) or tables not in ("0", ""):
                        self.log(f"{comp}: install scripts skipped, the database is not empty")
                        continue
                for p in scripts:
                    rel = f"{d.rstrip('/')}/{p.name}"
                    digest = hashlib.sha256(p.read_bytes()).hexdigest()
                    if rel in done:
                        if done[rel][2] != digest:
                            self.log(f"{comp}: {rel} was applied with sha256 {done[rel][2]}, the release now has {digest}; not run again")
                        continue
                    name = rel.replace("'", "''")
                    sql = p.read_text() + f"\n;\nINSERT INTO deployer.migrations (component, name, kind, sha256) VALUES ('{comp}', '{name}', '{kind}', '{digest}');\n"
                    try:
                        self.psql(svc, "--single-transaction", "-f", "-", sql=sql)
                    except Failed as e:
                        raise Failed(f"{comp}: {rel} failed and was rolled back ({e})")
                    applied.append(rel)
        return applied

    def image_build(self, ref):
        p = self.sh(["docker", "run", "--rm", "--entrypoint", "cat", ref, BUILD_JSON_IN_IMAGE], check=False)
        try:
            return json.loads(p.stdout)
        except ValueError:
            return None

    def containers(self, service):
        return self.compose("ps", "-a", "-q", service, check=False).stdout.split()

    def wait_healthy(self, services, digests=None):
        deadline = time.monotonic() + self.cfg["health_seconds"]
        last = "not started"
        while True:
            problems = []
            for s in services:
                ids = self.containers(s)
                if not ids:
                    problems.append(f"{s}: no container")
                    continue
                info = self.sh(["docker", "inspect", "-f",
                                "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}|{{.Image}}", ids[0]],
                               check=False).stdout.strip().split("|")
                st, health, restarts = (info + ["", "", "0"])[:3]
                if int(restarts or 0) > 3:
                    return f"{s}: restarted {restarts} times"
                if st != "running" or (health and health != "healthy"):
                    problems.append(f"{s}: {st}{' ' + health if health else ''}")
            if not problems:
                return None
            last = "; ".join(problems)
            if time.monotonic() >= deadline:
                return last
            self.sleep(5)

    def remove_stale(self, app, services):
        """Services this app no longer has (by our label), e.g. after a manifest removed one."""
        p = self.sh(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={self.cfg['project']}",
                     "--filter", f"label=org.open-atlas.app={app}", "--format", '{{.ID}} {{.Label "com.docker.compose.service"}}'], check=False)
        for line in p.stdout.splitlines():
            cid, _, service = line.partition(" ")
            if service and service not in services:
                self.sh(["docker", "rm", "-f", cid], check=False)

    def backup(self, app, version, stamp, services, data_dirs):
        dest = self.cfg["backups"] / app
        dest.mkdir(parents=True, exist_ok=True)
        os.chmod(dest, 0o700)
        archives = []
        existing = [d for d in data_dirs if d.exists()]
        if existing:
            ids = [i for s in services for i in self.containers(s)]
            paused = [i for i in ids if self.sh(["docker", "pause", i], check=False).returncode == 0]
            try:
                for i, d in enumerate(existing):
                    out = dest / f"{app}-data{i}-before-{version}-{stamp}.tar.gz"
                    part = out.with_suffix(".part")
                    self.sh(["tar", "czf", str(part), "-C", str(d.parent), "--exclude", f"{d.name}/logs", d.name])
                    self.sh(["tar", "tzf", str(part)], quiet=True)
                    os.chmod(part, 0o600)
                    os.replace(part, out)
                    archives.append((d, out))
            finally:
                for i in paused:
                    self.sh(["docker", "unpause", i], check=False)
        dump = None
        db = self.cfg["db"].get(app, {})
        if "dump" in db:
            dump = dest / f"{app}-db-before-{version}-{stamp}.dump"
            part = dump.with_suffix(".part")
            try:
                self.pipe(db["dump"], out=part)
                if part.stat().st_size == 0:
                    raise Failed("the database dump wrote nothing")
                os.replace(part, dump)
            finally:
                part.unlink(missing_ok=True)
        return archives, dump

    def prune_backups(self, app):
        dest = self.cfg["backups"] / app
        groups = {}
        for f in dest.glob(f"{app}-*-before-*"):
            groups.setdefault(re.sub(r"-before-.*$", "", f.name), []).append(f)
        for files in groups.values():
            for f in sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)[self.cfg["keep_backups"]:]:
                f.unlink()

    def rollback(self, status, req, app, services, problem, had_previous, previous, archives, dump, stamp):
        root, app_dir = self.cfg["root"], self.cfg["root"] / app
        logs = self.cfg["work"] / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        for s in services:
            for cid in self.containers(s):
                p = self.sh(["docker", "logs", "--tail", "3000", cid], check=False)
                (logs / f"{app}-{s}-{req['version']}-{stamp}.log").write_text(p.stdout + p.stderr)
        why = f"{app} {req['version']} did not come up within {self.cfg['health_seconds']} s ({problem})"
        self.step(status, "verify", "failed", problem)
        self.step(status, "rollback")
        # Remove what only the new version has while the new files still define it.
        old_services = self.fragment_services(previous / "compose.yaml") if had_previous else []
        dropped = [s for s in services if s not in old_services]
        if dropped:
            self.compose("rm", "-sf", *dropped, check=False)
        if (app_dir / "files").exists():
            shutil.rmtree(app_dir / "files")
        if (previous / "files").exists():
            os.replace(previous / "files", app_dir / "files")
        if (previous / "root.yaml").exists():
            shutil.copy2(previous / "root.yaml", root / "compose.yaml")
        if not had_previous:
            # First deploy through the Deployer: nothing of ours ran before; what this job started is removed.
            (app_dir / "compose.yaml").unlink(missing_ok=True)
            self.finish(status, "failed", f"{why}; this was the app's first deploy through the Deployer, its new containers "
                                          f"were removed. Logs: {logs}")
            return
        shutil.copy2(previous / "compose.yaml", app_dir / "compose.yaml")
        self.compose("up", "-d", "--no-build", *old_services, check=False)
        if self.wait_healthy(old_services) is None:
            self.finish(status, "rolled-back", f"{why}; back on the previous version. Logs: {logs}")
            return
        # The previous version does not start on what the new one left: restore the data (and database).
        self.step(status, "restore-data")
        self.compose("stop", *old_services, check=False)
        restored = []
        for d, archive in archives:
            aside = d.with_name(f"{d.name}.failed-{req['version']}-{stamp}")
            os.rename(d, aside)
            self.sh(["tar", "xzf", str(archive), "-C", str(d.parent)])
            if shutil.which("selinuxenabled") and subprocess.run(["selinuxenabled"]).returncode == 0 and shutil.which("chcon"):
                self.sh(["chcon", "-R", f"--reference={aside}", str(d)], check=False)
            restored.append(f"{d} from {archive.name} (as left: {aside.name})")
        db = self.cfg["db"].get(app, {})
        if dump and "restore" in db:
            left = self.cfg["backups"] / app / f"{app}-db-failed-{req['version']}-{stamp}.dump"
            try:
                self.pipe(db["dump"], out=left)
            except Exception as e:
                left = f"not saved ({e})"
            try:
                self.pipe(db["restore"], src=dump)
                restored.append(f"database from {dump.name} (as left: {left})")
            except Exception as e:
                self.finish(status, "failed", f"{why}; the previous version did not start either and the database could not be "
                                              f"restored: {e}. {app} is stopped and needs a person. Logs: {logs}")
                return
        self.compose("up", "-d", "--no-build", *old_services, check=False)
        if self.wait_healthy(old_services) is None:
            self.finish(status, "rolled-back", f"{why}; the previous version needed its data back: {'; '.join(restored)}. Logs: {logs}")
        else:
            self.finish(status, "failed", f"{why}; the previous version did not come back even after restoring "
                                          f"{'; '.join(restored) or 'nothing'}. {app} needs a person. Logs: {logs}")

    def fragment_services(self, path):
        """Service names in one of our generated fragments (two-space indented keys under services:)."""
        names, inside = [], False
        for line in path.read_text().splitlines():
            if line.startswith("services:"):
                inside = True
                continue
            if inside:
                m = re.match(r'^  "?([a-z0-9][a-z0-9_.-]*)"?:\s*$', line)
                if m:
                    names.append(m.group(1))
                elif line and not line.startswith(" "):
                    break
        return names


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Open Atlas Deployer host executor")
    p.add_argument("command", choices=["serve", "once", "check"], help="serve: the systemd loop; once: one pass; check: print the configuration")
    p.add_argument("--env-file", default=os.environ.get("EXECUTOR_ENV_FILE", "/etc/open-atlas-deployer/executor.env"))
    a = p.parse_args(argv)
    cfg = config(a.env_file)
    ex = Executor(cfg)
    if a.command == "check":
        shown = {k: (str(v) if isinstance(v, pathlib.Path) else v) for k, v in cfg.items() if k != "db"}
        shown["db"] = {app: sorted(v) for app, v in cfg["db"].items()}
        print(json.dumps(shown, indent=2, default=str))
        return 0
    if a.command == "once":
        cfg["work"].mkdir(parents=True, exist_ok=True)
        ex.recover()
        ex.run_once()
        return 0
    ex.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
