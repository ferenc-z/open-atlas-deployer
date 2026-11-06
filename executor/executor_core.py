"""What every Open Atlas host executor shares (design §7.4 D35, §8.6 D29; service ops S18).

Protocol 2: the executor calls the Deployer over HTTPS with its own token (dpe_, EXECUTOR_TOKEN_FILE); the Deployer
never calls a host and the host opens no port. This module holds that conversation (DeployerApi: heartbeat, the long
poll for the next job, status, log), the job loop around it (statuses kept and sent again while the Deployer is
down, a heartbeat thread during a long job, a job left running marked interrupted after a restart), registration
(the self-check's first heartbeat, a refused token stops the executor) and the executor's own upgrade
(executor-upgrade: a newer release from the host's own source, checked against SHA256SUMS, installed beside the
running one; launch.sh goes back after three failed starts).

An executor subclasses ProtocolExecutor and names its release (PACKAGE, PACKAGE_FILES, MAIN), which executor it is
(EXECUTOR: deploy or service, S18), its job kinds (KINDS, JOBS) and its version. A release stays one file: package.sh runs bundle.py, which puts this module's code in place of
the executor's `from executor_core import` block, so launch.sh runs the file as it is and executors that predate this
module accept the archive (it holds exactly the files they know).

The configuration (a dict) must hold: deployer_url, executor_token_file, ca_file, wait_seconds, poll_seconds, work,
base, upgrade_from, github_api, token_file (GitHub token, may be "").

Standard library only; Python 3.9.
"""
import datetime as dt
import hashlib
import io
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request

PROTOCOLS = [2]
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
FINAL = ("succeeded", "failed", "rolled-back", "refused")
KEEP_RELEASES = 3


class Refused(Exception):
    """The request is not something this executor does; nothing was changed."""


class Failed(Exception):
    """A step failed after it started."""


class Restarting(Exception):
    """A new release is in place: the process exits so systemd starts it (§8.6)."""


def version_key(v):
    """Orders x.y.z[-pre]; a pre-release comes before its release."""
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$", v)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 0 if m.group(4) else 1, m.group(4) or "")


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


class DeployerApi:
    """The executor's calls to the Deployer (protocol 2). Tests replace it."""

    def __init__(self, cfg, agent="open-atlas-executor"):
        self.cfg = cfg
        self.agent = agent
        self.context = None
        if cfg["deployer_url"].startswith("https://") and cfg["ca_file"]:
            import ssl
            self.context = ssl.create_default_context(cafile=cfg["ca_file"])

    def token(self):
        f = self.cfg["executor_token_file"]
        return pathlib.Path(f).read_text().strip() if f and pathlib.Path(f).is_file() else ""

    def call(self, method, path, body=None, text=None, timeout=30, raw=None):
        if not self.cfg["deployer_url"]:
            raise Failed("EXECUTOR_DEPLOYER_URL is not set")
        data, headers = None, {"authorization": f"Bearer {self.token()}", "user-agent": self.agent}
        if body is not None:
            data, headers["content-type"] = json.dumps(body).encode(), "application/json"
        elif text is not None:
            data, headers["content-type"] = text.encode(), "text/plain; charset=utf-8"
        elif raw is not None:
            data, headers["content-type"] = bytes(raw), "application/octet-stream"
        req = urllib.request.Request(self.cfg["deployer_url"] + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.context) as r:
                raw = r.read()
                return json.loads(raw) if raw and r.status != 204 else None
        except urllib.error.HTTPError as e:
            raise Failed(f"the Deployer answered {method} {path.split('?')[0]} with HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}")
        except (urllib.error.URLError, OSError) as e:
            raise Failed(f"cannot reach the Deployer at {self.cfg['deployer_url']}: {getattr(e, 'reason', e)}")

    def heartbeat(self, beat):
        return self.call("POST", "/executor/v1/heartbeat", body=beat)

    def next_job(self, wait):
        r = self.call("GET", f"/executor/v1/jobs/next?wait={int(wait)}", timeout=wait + 30)
        return r["job"] if r else None

    def put_status(self, job_id, status):
        self.call("PUT", f"/executor/v1/jobs/{job_id}/status", body=status)

    def append_log(self, job_id, text):
        self.call("POST", f"/executor/v1/jobs/{job_id}/log", text=text)

    def put_env_content(self, job_id, text):
        self.call("PUT", f"/executor/v1/jobs/{job_id}/env-content", text=text)

    def report_state(self, containers, files):
        self.call("POST", "/executor/v1/state", body={"containers": containers, "files": files})

    def post_samples(self, samples):
        """The service executor's collected samples (§15.3), at most 20 at a time."""
        return self.call("POST", "/executor/v1/samples", body={"samples": samples})

    def put_content(self, job_id, data):
        """A job's binary content (§15.3: a log search's matches, a download's tar.gz); the Deployer cuts it at the job's limit."""
        self.call("PUT", f"/executor/v1/jobs/{job_id}/content", raw=data, timeout=120)

    def post_chunk(self, job_id, chunk):
        """A log-tail's next piece (§15.2 P7); the answer says whether anyone still follows ({"stop": true}: nobody)."""
        return self.call("POST", f"/executor/v1/jobs/{job_id}/chunk", body=chunk)


class ProtocolExecutor:
    """The job loop, registration and self-upgrade. A subclass names what follows and adds its jobs."""

    # The release (§8.6): one directory <PACKAGE>-<version> in the archive, holding only PACKAGE_FILES; MAIN says its version.
    PACKAGE = ""
    PACKAGE_FILES = ()
    MAIN = ""
    # Which executor this is (S18): "deploy" or "service"; the heartbeat says it, and the Deployer checks it against the token.
    EXECUTOR = ""
    EXECUTABLES = ("launch.sh", "switch", "install.sh")
    # Job kinds the heartbeat names, and the method each job kind runs (looked up when the job comes).
    KINDS = ["executor-upgrade"]
    JOBS = {"executor-upgrade": "upgrade"}
    INTERRUPTED = "The executor stopped while this job ran."

    def __init__(self, cfg, out=sys.stdout, api=None):
        self.cfg = cfg
        self.out = out
        self.api = api or DeployerApi(cfg, agent=f"{self.PACKAGE}/{self.version}")
        # The running job's id and its log lines not yet sent to the Deployer.
        self.job_id = None
        self.log_buffer = []
        self.log_lock = threading.Lock()
        self.beat_lock = threading.Lock()
        # How often a status is tried before it is kept for later (a job that takes the Deployer down tries once).
        self.status_tries = 5
        # A job can run for minutes (a build, a health wait); the heartbeat keeps going meanwhile.
        self.beat_seconds = 10.0

    @property
    def version(self):
        raise NotImplementedError

    # Host access. Tests replace these.
    def sh(self, args, cwd=None, env=None, check=True, timeout=None, input=None, quiet=False):
        full_env = dict(os.environ, **(env or {}))
        if cwd:
            full_env["PWD"] = str(cwd)
        p = subprocess.run(args, cwd=cwd, env=full_env, capture_output=True, text=True, timeout=timeout, input=input)
        if self.job_id:
            output = f"[output not logged]\n" if quiet else f"{p.stdout}{p.stderr}"
            self.log(f"$ {' '.join(shlex.quote(a) for a in args)}\n{output}[exit {p.returncode}]")
        if check and p.returncode != 0:
            raise Failed(f"{' '.join(args[:3])} failed (exit {p.returncode}): {(p.stderr or p.stdout).strip()[-600:]}")
        return p

    def sleep(self, seconds):
        time.sleep(seconds)

    def log(self, text):
        if self.job_id:
            with self.log_lock:
                self.log_buffer.append(text.rstrip("\n") + "\n")

    def flush_log(self):
        """Sends the buffered log lines; kept for the next try when the Deployer cannot be reached."""
        with self.log_lock:
            if not self.job_id or not self.log_buffer:
                return
            text, job_id = "".join(self.log_buffer), self.job_id
            self.log_buffer = []
        try:
            self.api.append_log(job_id, text)
        except Exception as e:
            with self.log_lock:
                self.log_buffer.insert(0, text)
            self.say(f"cannot send the log of {job_id}: {e}")

    def say(self, msg):
        print(f"{now_iso()} {msg}", file=self.out, flush=True)

    def token(self):
        """The GitHub token (EXECUTOR_GITHUB_TOKEN_FILE), for releases in private repositories; not the Deployer's."""
        f = self.cfg["token_file"]
        return pathlib.Path(f).read_text().strip() if f and pathlib.Path(f).is_file() else ""

    def http_get(self, url, accept, auth=True):
        """GitHub's API. A redirect (an asset's download URL) is followed without the token."""
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        token = self.token() if auth else ""
        headers = {"Accept": accept, "User-Agent": self.PACKAGE, **({"Authorization": f"Bearer {token}"} if token else {})}
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

    # --- registration and the loop -------------------------------------------------------------------

    def beat_body(self, busy):
        """What every heartbeat says; a subclass adds what its host has configured."""
        source = self.cfg["upgrade_from"]
        return {
            **({"executor": self.EXECUTOR} if self.EXECUTOR else {}),
            "version": self.version, "protocols": PROTOCOLS, "kinds": self.KINDS, "at": now_iso(), "pid": os.getpid(), "busy": busy,
            # §8.6: whether this host can upgrade its executor, and from what kind of source (never the source itself).
            "upgradeFrom": ("directory" if source.startswith("/") else "github") if source else None,
        }

    def send_beat(self, body):
        with self.beat_lock:
            try:
                reply = self.api.heartbeat(body)
            except Exception as e:  # the Deployer may be restarting; the next beat tries again
                self.say(f"heartbeat failed: {e}")
                return
        self.on_beat_reply(reply if isinstance(reply, dict) else {})

    def on_beat_reply(self, reply):
        """What the Deployer answered a heartbeat with (the service executor takes its watch list from it, §15.2 P5)."""

    def heartbeat(self, busy=None):
        self.send_beat(self.beat_body(busy))

    def report_state(self, force=False):
        """What the host looks like, for the Deployer's pages; nothing by default."""

    def check_host(self):
        """What this executor needs on the host, checked before it registers (a failure stops it)."""

    def describe(self):
        return f"executor {self.version}"

    def current_marker(self):
        return self.cfg["work"] / "current-job.json"

    def recover(self):
        """A job left running by a previous process was interrupted: say so instead of leaving it running."""
        marker = self.current_marker()
        if not marker.is_file():
            return
        status = json.loads(marker.read_text())
        if status.get("state") not in FINAL:
            status.update(state="failed", finishedAt=now_iso(), message=self.INTERRUPTED)
            self.api.put_status(status["id"], status)
        marker.unlink()

    def pending_dir(self):
        return self.cfg["work"] / "pending"

    def keep_pending(self, status, log=""):
        """A status (and log) the Deployer could not take: sent again once it answers (deliver_pending)."""
        path = self.pending_dir() / f"{status['id']}.json"
        kept = json.loads(path.read_text()) if path.is_file() else {"log": ""}
        write_json(path, {"status": status, "log": kept.get("log", "") + log}, mode=0o600)

    def deliver_pending(self):
        d = self.pending_dir()
        if not d.is_dir():
            return
        for path in sorted(d.glob("*.json")):
            kept = json.loads(path.read_text())
            try:
                if kept.get("log"):
                    self.api.append_log(kept["status"]["id"], kept["log"])
                    kept["log"] = ""
                    write_json(path, kept, mode=0o600)
                self.api.put_status(kept["status"]["id"], kept["status"])
            except Exception as e:
                self.say(f"cannot send the kept status of {kept['status']['id']} yet: {e}")
                return
            path.unlink()
            self.say(f"sent the kept status of {kept['status']['id']}: {kept['status'].get('state')}")

    def run_once(self, wait=0):
        self.deliver_pending()
        self.heartbeat()
        self.report_state()
        request = self.api.next_job(wait)
        if not request:
            return False
        self.handle(request)
        self.report_state(force=True)
        return True

    def serve(self):
        self.say(self.describe())
        self.cfg["work"].mkdir(parents=True, exist_ok=True)
        self.recover()
        self.selfcheck()
        self.finish_upgrade()
        self.deliver_pending()
        while True:
            try:
                # The long poll waits at the Deployer; a heartbeat thread keeps the host online meanwhile.
                self.run_once(wait=self.cfg["wait_seconds"])
            except Restarting as e:
                self.say(str(e))
                return
            except Exception as e:  # keep serving; the job itself already recorded its failure
                self.say(f"error: {e}")
                self.sleep(self.cfg["poll_seconds"])

    def selfcheck(self):
        """Registers with the Deployer. After an upgrade, launch.sh counts starts until this clears the marker (§8.6)."""
        self.check_host()
        if not self.cfg["deployer_url"] or not self.api.token():
            raise SystemExit("EXECUTOR_DEPLOYER_URL and EXECUTOR_TOKEN_FILE (this host's dpe_ token) are required")
        # The Deployer may be starting or restarting: wait for it rather than exit. A refused token stops here.
        waited = 0
        while True:
            try:
                reply = self.api.heartbeat(self.beat_body(None))
                self.on_beat_reply(reply if isinstance(reply, dict) else {})
                break
            except Failed as e:
                if "HTTP 401" in str(e):
                    raise SystemExit(f"the Deployer refused this host's token: {e}")
                if waited % 30 == 0:
                    self.say(f"waiting for the Deployer: {e}")
                self.sleep(5)
                waited += 5
        marker = self.cfg["work"] / "upgrade-pending"
        if marker.exists():
            marker.unlink()
            self.say("upgrade self-check passed")

    # --- one job --------------------------------------------------------------------------------------

    def handle(self, request):
        job_id = str(request.get("id", ""))
        if not ID_RE.match(job_id):
            self.say(f"refused a job with the id {job_id[:80]!r}")
            return
        self.job_id = job_id
        self.log_buffer = []
        status = {"protocol": 2, "id": job_id, "state": "running", "startedAt": now_iso(), "steps": [], "result": {}}
        done = threading.Event()
        beating = threading.Thread(target=self.keep_beating, args=(done, job_id), daemon=True)
        beating.start()
        try:
            status.update(kind=request.get("kind"), app=request.get("app"), version=request.get("version"))
            self.write_status(status)
            self.heartbeat(busy=job_id)
            if request.get("protocol") not in PROTOCOLS:
                raise Refused(f"protocol {request.get('protocol')} is not supported (this executor speaks {PROTOCOLS})")
            method = self.JOBS.get(request.get("kind"))
            if not method:
                raise Refused(f"unknown job kind {request.get('kind')}")
            getattr(self, method)(request, status)
        except Restarting:
            raise
        except Refused as e:
            self.finish(status, "refused", str(e))
        except Exception as e:
            if status["state"] not in FINAL:
                self.finish(status, "failed", str(e))
        finally:
            done.set()
            beating.join()
            self.flush_log()
            with self.log_lock:
                unsent, self.log_buffer = "".join(self.log_buffer), []
            if unsent:
                self.keep_pending(status, unsent)
            self.status_tries = 5
            self.job_id = None
            self.current_marker().unlink(missing_ok=True)
            self.heartbeat()

    def keep_beating(self, done, busy):
        while not done.wait(self.beat_seconds):
            self.heartbeat(busy=busy)
            self.flush_log()

    def write_status(self, status):
        """To the Deployer, and to a local marker so a restart can say the job was interrupted."""
        self.cfg["work"].mkdir(parents=True, exist_ok=True)
        write_json(self.current_marker(), status, mode=0o600)
        self.flush_log()
        for attempt in range(self.status_tries):
            try:
                self.api.put_status(status["id"], status)
                kept = self.pending_dir() / f"{status['id']}.json"
                if kept.is_file():
                    # Taken now; a log kept earlier still goes out with the next delivery.
                    if json.loads(kept.read_text()).get("log"):
                        self.keep_pending(status)
                    else:
                        kept.unlink()
                return
            except Exception as e:
                if attempt == self.status_tries - 1:
                    self.say(f"cannot send the status of {status['id']}, kept for later: {e}")
                    self.keep_pending(status)
                else:
                    self.sleep(2)

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

    # --- executor-upgrade: a newer release of this executor (§8.6, D29) -----------------------------------------

    def upgrade(self, req, status):
        """Installs the release beside the running one, points `current` at it, and exits for systemd to start it.
        The Deployer only names the version: the code comes from EXECUTOR_UPGRADE_FROM, checked against SHA256SUMS."""
        version, source, base = req.get("version", ""), self.cfg["upgrade_from"], self.cfg["base"]
        if not VERSION_RE.match(version):
            raise Refused("version is malformed")
        if version_key(version) <= version_key(self.version):
            raise Refused(f"executor {self.version} is not older than {version}; going back is `switch <version>` on the host")
        if not source:
            raise Refused("EXECUTOR_UPGRADE_FROM is not set on this host")
        current = base / "current"
        if not current.is_symlink():
            raise Refused(f"{current} is not a link to a release: install the executor with install.sh first")
        previous = pathlib.PurePosixPath(os.readlink(current)).name
        name = f"{self.PACKAGE}-{version}.tar.gz"

        self.step(status, "download")
        archive, sums = self.release_files(source, version, name)
        want = next((line.split()[0] for line in sums.splitlines() if line.split()[1:] in ([name], [f"*{name}"])), "")
        got = hashlib.sha256(archive).hexdigest()
        if not SHA256_RE.match(want):
            raise Failed(f"SHA256SUMS of executor-v{version} does not list {name}")
        if got != want:
            raise Failed(f"{name} is sha256:{got}, SHA256SUMS says sha256:{want}")
        self.log(f"{name} sha256:{got}")

        self.step(status, "install")
        files = self.package_files(archive, version)
        target, tmp = base / "releases" / version, base / "releases" / f".{version}.tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        for f, data in files.items():
            (tmp / f).write_bytes(data)
            os.chmod(tmp / f, 0o755 if f in self.EXECUTABLES else 0o644)
        shutil.rmtree(target, ignore_errors=True)
        os.replace(tmp, target)
        status["result"] = {"from": self.version, "to": version, "previous": previous, "sha256": got}
        launch = base / "launch.sh"
        if "launch.sh" in files and launch.is_file() and launch.read_bytes() != files["launch.sh"]:
            # launch.sh is what takes a failed upgrade back, so an upgrade never replaces it (install.sh does).
            status["result"]["note"] = f"launch.sh changed in {version}: run its install.sh on the host to take it"

        self.step(status, "restart")
        work = self.cfg["work"]
        for f in ("upgrade-starts", "upgrade-failed.json"):
            (work / f).unlink(missing_ok=True)
        write_json(work / "upgrade-job.json", status, mode=0o600)
        (work / "upgrade-pending").write_text(previous)
        link = base / "current.tmp"
        link.unlink(missing_ok=True)
        os.symlink(f"releases/{version}", link)
        os.replace(link, current)
        self.write_status(status)
        raise Restarting(f"executor {version} installed; exiting so that systemd starts it")

    def release_files(self, source, version, name):
        """The release archive and its SHA256SUMS, from a directory (<dir>/executor-v<version>/) or a GitHub release."""
        tag = f"executor-v{version}"
        if source.startswith("/"):
            d = pathlib.Path(source) / tag
            if not (d / name).is_file() or not (d / "SHA256SUMS").is_file():
                raise Failed(f"{d} does not hold {name} and SHA256SUMS")
            return (d / name).read_bytes(), (d / "SHA256SUMS").read_text()
        if not REPO_RE.match(source):
            raise Refused("EXECUTOR_UPGRADE_FROM is neither an absolute directory nor owner/name")
        release = json.loads(self.http_get(f"{self.cfg['github_api']}/repos/{source}/releases/tags/{tag}", "application/vnd.github+json"))
        found = {a.get("name"): a for a in release.get("assets") or []}
        for wanted in (name, "SHA256SUMS"):
            if wanted not in found:
                raise Failed(f"{source} release {tag} has no asset {wanted}")
        return self.http_get(found[name]["url"], "application/octet-stream"), self.http_get(found["SHA256SUMS"]["url"], "application/octet-stream").decode()

    def package_files(self, archive, version):
        """The release's files: one directory, only the known files, regular files only; the code must say its version."""
        top, files = f"{self.PACKAGE}-{version}", {}
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            for m in tar.getmembers():
                name = m.name[2:] if m.name.startswith("./") else m.name
                if m.isdir() and name.rstrip("/") == top:
                    continue
                parts = name.split("/")
                if not m.isfile() or len(parts) != 2 or parts[0] != top or parts[1] not in self.PACKAGE_FILES:
                    raise Failed(f"the release holds {m.name}, which is not one of the executor's files")
                with tar.extractfile(m) as f:
                    files[parts[1]] = f.read()
        code = files.get(self.MAIN)
        if code is None:
            raise Failed(f"the release has no {self.MAIN}")
        said = re.search(rb'^VERSION = "([^"]+)"', code, re.M)
        if not said or said.group(1).decode() != version:
            raise Failed(f"the release's {self.MAIN} is not version {version}")
        try:
            compile(code, self.MAIN, "exec")
        except SyntaxError as e:
            raise Failed(f"the release's {self.MAIN} does not compile: {e}")
        return files

    def finish_upgrade(self):
        """After the restart an upgrade asked for: whichever version runs now says how the upgrade ended."""
        work = self.cfg["work"]
        path, failed = work / "upgrade-job.json", work / "upgrade-failed.json"
        if not path.is_file():
            return
        status = json.loads(path.read_text())
        to = status.get("result", {}).get("to")
        if to == self.version:
            state, message = "succeeded", f"Executor upgraded from {status['result'].get('from')} to {self.version}"
            self.prune_releases(status["result"].get("previous"))
        else:
            gave_up = " after three failed starts" if failed.is_file() else ""
            state, message = "failed", f"Executor {to} did not start{gave_up}; back on {self.version}"
        for s in status.get("steps", []):
            if s.get("state") == "running":
                s["state"] = "done" if state == "succeeded" else "failed"
        status.update(state=state, finishedAt=now_iso(), message=message)
        for attempt in range(5):
            try:
                self.api.put_status(status["id"], status)
                break
            except Exception as e:
                self.say(f"cannot send the status of {status['id']}: {e}")
                self.sleep(2)
        self.say(f"{status['id']} {state}: {message}")
        path.unlink()
        failed.unlink(missing_ok=True)

    def prune_releases(self, previous):
        """Keeps the running release, the one before it, and the newest few."""
        releases = self.cfg["base"] / "releases"
        found = sorted((d.name for d in releases.iterdir() if d.is_dir() and VERSION_RE.match(d.name)), key=version_key)
        keep = {self.version, previous, *found[-KEEP_RELEASES:]}
        for name in found:
            if name not in keep:
                shutil.rmtree(releases / name, ignore_errors=True)
