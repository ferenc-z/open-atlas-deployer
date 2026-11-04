#!/usr/bin/env python3
"""Open Atlas service executor (service ops, design S18, §12).

Runs on a machine with managed services (NiFi) beside or instead of the deploy executor, and needs no Docker, only
Python 3.9+. It speaks protocol 2 like the deploy executor (executor_core.py): it calls the Deployer over HTTPS with
its own token (dpe_, issued on the Hosts page as this host's service executor token, EXECUTOR_TOKEN_FILE); the Deployer
never calls the host and the host opens no port. Its heartbeat says it is the service executor and which user it runs
as: not root, it sees and manages only that user's services.

Jobs come on two channels (§12). The read channel runs jobs that only look (discover, read a file, read a log) side
by side, at most EXECUTOR_READ_SLOTS at a time, each within its timeout (the request's timeoutSeconds, at most
EXECUTOR_READ_TIMEOUT); a job that runs over is reported failed and its late result dropped. The change channel runs one
job at a time, after the reads in flight have ended; for now it only has executor-upgrade (the executor's own release,
§8.6). The read jobs so far: svc-discover (§6 step 2), which finds the NiFi on the machine from their processes and
from the directories it is given. The executor refuses any kind it does not know, deploy jobs included.

The release holds one file: package.sh puts executor_core's code in place of the import block below (bundle.py).

Standard library only; Python 3.9.
"""
import glob
import hashlib
import json
import os
import pathlib
import pwd
import re
import sys
import threading
import time

# >>> executor_core
# The protocol, registration and self-upgrade every executor shares (executor_core.py, S18). package.sh (bundle.py) puts
# that module's code in place of this block, so a release stays one file that launch.sh runs as it is.
from executor_core import (  # noqa: F401
    FINAL, ID_RE, PROTOCOLS, Failed, ProtocolExecutor, Refused, Restarting, load_env_file, now_iso, write_json)
# <<< executor_core

VERSION = "0.7.3"
# The executor's release (§8.6): one directory in the archive, holding only these files.
PACKAGE = "open-atlas-service-executor"
PACKAGE_FILES = ("service_executor.py", "launch.sh", "switch", "install.sh", "open-atlas-service-executor.service", "service-executor.env.example")


def config(env_file=None, environ=None):
    e = dict(load_env_file(env_file))
    e.update({k: v for k, v in (environ or os.environ).items() if k.startswith("EXECUTOR_")})
    return {
        # D35: where this executor reaches the Deployer, with the token issued for this host's service executor.
        "deployer_url": e.get("EXECUTOR_DEPLOYER_URL", "").rstrip("/"),
        "executor_token_file": e.get("EXECUTOR_TOKEN_FILE", ""),
        "ca_file": e.get("EXECUTOR_CA_FILE", ""),
        "wait_seconds": int(e.get("EXECUTOR_WAIT_SECONDS", "25")),
        "poll_seconds": float(e.get("EXECUTOR_POLL_SECONDS", "2")),
        "work": pathlib.Path(e.get("EXECUTOR_WORK", "/var/lib/open-atlas-service-executor")),
        # The read channel: how many reads run at once, and the longest one may take.
        "read_slots": max(1, int(e.get("EXECUTOR_READ_SLOTS", "4"))),
        "read_timeout": max(1, int(e.get("EXECUTOR_READ_TIMEOUT", "120"))),
        # §8.6: where the installed releases are, and the only place a newer one may come from.
        "base": pathlib.Path(e.get("EXECUTOR_BASE", "/opt/open-atlas-deployer/service-executor")),
        "upgrade_from": e.get("EXECUTOR_UPGRADE_FROM", "").strip(),
        "token_file": e.get("EXECUTOR_GITHUB_TOKEN_FILE", ""),
        "github_api": e.get("EXECUTOR_GITHUB_API", "https://api.github.com").rstrip("/"),
    }


class ReadJob:
    """One job on the read channel: its log, and whether it already ran over its time."""

    def __init__(self, request, timeout):
        self.request = request
        self.id = str(request["id"])
        self.timeout = timeout
        self.deadline = time.monotonic() + timeout
        self.lines = []
        self.lock = threading.Lock()

    def log(self, text):
        with self.lock:
            self.lines.append(text.rstrip("\n") + "\n")

    def take_log(self):
        with self.lock:
            text, self.lines = "".join(self.lines), []
        return text

    def left(self):
        return max(0.0, self.deadline - time.monotonic())


# --- discovery (svc-discover, §6 step 2): which NiFi run here, and what they are -------------------------------------

# NiFi's processes: the bootstrap that nifi.sh starts (RunNiFi in 1.x, BootstrapProcess in 2.x) and the NiFi JVM it runs.
# 2.x keeps no run/nifi.pid, so instances are found by their command lines, never by pid files.
NIFI_BOOTSTRAP = ("org.apache.nifi.bootstrap.RunNiFi", "org.apache.nifi.bootstrap.BootstrapProcess")
NIFI_MAIN = "org.apache.nifi.NiFi"
# The configuration files fingerprinted (the profile's files, §5.1, and the ones beside them in conf/).
NIFI_CONF_FILES = ("nifi.properties", "bootstrap.conf", "state-management.xml", "authorizers.xml", "login-identity-providers.xml",
                   "logback.xml", "zookeeper.properties", "bootstrap-notification-services.xml")
# Where NiFi is often unpacked; an instance there is found even when it does not run.
COMMON_DIRS = ("/opt/nifi*", "/opt/*/nifi*", "/usr/local/nifi*", "/srv/nifi*")
# Values never sent to the Deployer: passwords and keys in the properties, and secrets in the start environment.
SECRET_PROPERTY = re.compile(r"pass(word|wd|phrase)?|secret|token|credential|sensitive\.props\.key|\.key$|private", re.I)
SECRET_ENV = re.compile(r"PASS|SECRET|TOKEN|CREDENTIAL|_KEY$|^KEY$|PRIVATE|COOKIE", re.I)
HIDDEN = "(hidden)"
MAX_DIRS = 32


def read_properties(path):
    """A Java properties file as a dict (NiFi's files: key=value, # and ! comments, \\ continues a line)."""
    out, pending = {}, ""
    for raw in pathlib.Path(path).read_text(errors="replace").splitlines():
        line = pending + raw.strip() if pending else raw.lstrip()
        pending = ""
        if line.endswith("\\") and not line.endswith("\\\\"):
            pending = line[:-1]
            continue
        if not line or line[0] in "#!":
            continue
        m = re.match(r"([^=:\s]+)\s*[=:]?\s*(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).rstrip()
    return out


def hide_secrets(props, pattern=SECRET_PROPERTY):
    """Secret-looking values replaced by "(hidden)"; an empty one stays empty, so a missing key shows."""
    return {k: (HIDDEN if v and pattern.search(k) else v) for k, v in props.items()}


def as_port(value):
    try:
        port = int(str(value).strip().rsplit(":", 1)[-1].rstrip("/"))
    except (TypeError, ValueError):
        return None
    return port if 0 < port < 65536 else None


def user_name(uid):
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def iso_at(seconds):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))


class Discovery:
    """One svc-discover pass over /proc and the given directories. Only reads.

    proc: the /proc to read (tests give a fake one); uid: whose processes count (None: everyone's, as root)."""

    def __init__(self, proc="/proc", uid=None, common=COMMON_DIRS, log=lambda text: None):
        self.proc = pathlib.Path(proc)
        self.uid = uid
        self.common = common
        self.log = log

    # --- processes ---

    def processes(self):
        """pid -> {cmdline, uid, ppid}: the NiFi processes this executor may look at; others' go to self.skipped."""
        found, self.skipped = {}, []
        for d in sorted((d for d in self.proc.iterdir() if d.name.isdigit()), key=lambda d: int(d.name)):
            try:
                args = [a for a in (d / "cmdline").read_bytes().split(b"\0") if a]
            except OSError:
                continue
            args = [a.decode(errors="replace") for a in args]
            if not any(a in NIFI_BOOTSTRAP or a == NIFI_MAIN for a in args):
                continue
            try:
                status = dict(line.split(":", 1) for line in (d / "status").read_text().splitlines() if ":" in line)
                uid, ppid = int(status["Uid"].split()[0]), int(status["PPid"].strip())
            except (OSError, KeyError, ValueError):
                continue
            if self.uid is not None and uid != self.uid:
                self.skipped.append({"pid": int(d.name), "user": user_name(uid)})
                continue
            found[int(d.name)] = {"args": args, "uid": uid, "ppid": ppid}
        return found

    @staticmethod
    def define(args, name):
        prefix = f"-D{name}="
        return next((a[len(prefix):] for a in args if a.startswith(prefix)), None)

    def home_of(self, pid, args):
        """The installation a NiFi process belongs to: two levels above its bootstrap.conf or nifi.properties, else its cwd."""
        for name in ("org.apache.nifi.bootstrap.config.file", "nifi.properties.file.path"):
            value = self.define(args, name)
            if value:
                return os.path.normpath(os.path.dirname(os.path.dirname(value)))
        try:
            return os.path.normpath(os.readlink(self.proc / str(pid) / "cwd"))
        except OSError:
            return None

    def environ(self, pid):
        try:
            raw = (self.proc / str(pid) / "environ").read_bytes()
        except OSError as e:
            return None, f"cannot read the start environment of {pid}: {e.strerror or e}"
        env = dict(p.decode(errors="replace").split("=", 1) for p in raw.split(b"\0") if b"=" in p)
        return hide_secrets(env, SECRET_ENV), None

    def started_at(self, pid):
        try:
            fields = (self.proc / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
            btime = next(int(line.split()[1]) for line in (self.proc / "stat").read_text().splitlines() if line.startswith("btime "))
            return iso_at(btime + int(fields[19]) / os.sysconf("SC_CLK_TCK"))
        except (OSError, IndexError, ValueError, StopIteration):
            return None

    def listening(self, pid):
        """The TCP ports the process listens on: its socket inodes against its network namespace's tcp tables."""
        inodes = set()
        try:
            for fd in (self.proc / str(pid) / "fd").iterdir():
                try:
                    target = os.readlink(fd)
                except OSError:
                    continue
                m = re.match(r"socket:\[(\d+)\]$", target)
                if m:
                    inodes.add(m.group(1))
        except OSError:
            return None
        ports = set()
        for table in ("tcp", "tcp6"):
            try:
                lines = (self.proc / str(pid) / "net" / table).read_text().splitlines()[1:]
            except OSError:
                continue
            for line in lines:
                f = line.split()
                if len(f) > 9 and f[3] == "0A" and f[9] in inodes:
                    ports.add(int(f[1].rsplit(":", 1)[1], 16))
        return sorted(ports)

    def running(self):
        """installDir -> what its processes say (bootstrap and NiFi JVM pids, user, java, start environment, ports)."""
        procs = self.processes()
        out = {}
        for pid, p in sorted(procs.items()):
            home = self.home_of(pid, p["args"])
            if not home:
                continue
            entry = out.setdefault(home, {"uid": p["uid"]})
            role = "pid" if NIFI_MAIN in p["args"] else "bootstrapPid"
            entry.setdefault(role, pid)
            if role == "pid":
                entry["propertiesFile"] = self.define(p["args"], "nifi.properties.file.path")
        for home, entry in out.items():
            main, boot = entry.get("pid"), entry.get("bootstrapPid")
            # The environment nifi.sh started with is the bootstrap's (S10); the JVM inherits it.
            env, problem = self.environ(boot or main)
            entry["environment"] = env
            entry["problems"] = [problem] if problem else []
            try:
                entry["java"] = os.readlink(self.proc / str(main or boot) / "exe")
            except OSError:
                entry["java"] = None
            entry["startedAt"] = self.started_at(main or boot)
            entry["listening"] = self.listening(main) if main else []
        return out

    # --- installations ---

    @staticmethod
    def is_nifi(home):
        return (home / "conf" / "nifi.properties").is_file() or (home / "bin" / "nifi.sh").is_file()

    @staticmethod
    def version(home):
        lib = home / "lib"
        for pattern in ("nifi-runtime-*.jar", "bootstrap/nifi-bootstrap-*.jar", "nifi-framework-api-*.jar"):
            for jar in sorted(lib.glob(pattern)):
                m = re.search(r"-(\d+\.\d+\.\d+[0-9A-Za-z.-]*?)\.jar$", jar.name)
                if m:
                    return m.group(1)
        return None

    def instance(self, home, proc=None, source="process"):
        """What one installation is: version, users, start environment, ports, the cluster settings, file fingerprints."""
        home = pathlib.Path(home)
        problems = list((proc or {}).get("problems", []))
        props_file = pathlib.Path(os.path.normpath((proc or {}).get("propertiesFile") or home / "conf" / "nifi.properties"))
        conf = props_file.parent
        props, boot = {}, {}
        try:
            props = read_properties(props_file)
        except OSError as e:
            problems.append(f"cannot read {props_file}: {e.strerror or e}")
        try:
            boot = read_properties(conf / "bootstrap.conf")
        except OSError as e:
            problems.append(f"cannot read {conf / 'bootstrap.conf'}: {e.strerror or e}")
        try:
            owner = user_name(home.stat().st_uid)
        except OSError:
            owner = None
        files = []
        for name in NIFI_CONF_FILES:
            path = props_file if name == "nifi.properties" else conf / name
            try:
                st = path.stat()
                files.append({"name": name, "path": str(path), "sha256": sha256_file(path), "size": st.st_size, "modifiedAt": iso_at(st.st_mtime)})
            except FileNotFoundError:
                continue
            except OSError as e:
                problems.append(f"cannot read {path}: {e.strerror or e}")
        args = [v for k, v in sorted(boot.items()) if k.startswith("java.arg")]
        heap = {flag: next((a[4:] for a in args if a.startswith(f"-{flag}")), None) for flag in ("Xms", "Xmx")}
        https, http = as_port(props.get("nifi.web.https.port")), as_port(props.get("nifi.web.http.port"))
        web_host = props.get("nifi.web.https.host") if https else props.get("nifi.web.http.host")
        running = bool(proc and proc.get("pid"))
        node = props.get("nifi.cluster.is.node", "false").strip().lower() == "true"
        return {
            "service": "nifi",
            "installDir": str(home),
            "source": source,
            "running": running,
            "version": self.version(home),
            "owner": owner,
            # The user it runs as; one not running is started as the installation's owner (S10).
            "serviceUser": user_name(proc["uid"]) if proc else owner,
            "process": {k: proc.get(k) for k in ("pid", "bootstrapPid", "java", "startedAt", "listening")} if proc else None,
            "startEnvironment": proc.get("environment") if proc else None,
            "ports": {
                "https": https, "http": http,
                # The cluster's ports only count on a node (standalone ones keep the defaults but do not listen).
                "clusterProtocol": as_port(props.get("nifi.cluster.node.protocol.port")) if node else None,
                "loadBalance": as_port(props.get("nifi.cluster.load.balance.port")) if node else None,
                "remoteInput": as_port(props.get("nifi.remote.input.socket.port")),
                # 2.x: the bootstrap's management server (bootstrap.conf); 1.x picks a random one each start.
                "management": as_port(boot.get("management.server.address")),
            },
            "webUrl": f"{'https' if https else 'http'}://{web_host or 'localhost'}:{https or http}/nifi" if (https or http) else None,
            "cluster": {
                "isNode": node,
                "nodeAddress": props.get("nifi.cluster.node.address") or None,
                "zookeeper": props.get("nifi.zookeeper.connect.string") or None,
                "zookeeperRoot": props.get("nifi.zookeeper.root.node") or None,
            },
            "heap": heap,
            # The JDK it runs on: the process's JAVA_HOME; not running, bootstrap.conf's java= when it names one.
            "javaHome": (proc.get("environment") or {}).get("JAVA_HOME") if proc else None,
            "bootstrapJava": boot.get("java") or None,
            "properties": hide_secrets(props),
            "bootstrap": hide_secrets(boot),
            "files": files,
            "problems": problems,
        }

    def run(self, dirs=()):
        """Every NiFi found: running ones from their processes, then the asked and the common directories."""
        procs = self.running()
        instances = {home: self.instance(home, p) for home, p in procs.items()}
        for home in instances:
            self.log(f"running: {home} (pid {procs[home].get('pid') or '-'}, version {instances[home]['version']})")
        asked = []
        for d in dirs:
            home = os.path.normpath(d)
            if home in instances:
                asked.append({"dir": d, "found": True, "running": instances[home]["running"]})
                continue
            if not os.path.isdir(home):
                asked.append({"dir": d, "found": False, "error": "no such directory (or not readable by this executor)"})
                continue
            if not self.is_nifi(pathlib.Path(home)):
                asked.append({"dir": d, "found": False, "error": "no conf/nifi.properties or bin/nifi.sh here: not a NiFi installation"})
                continue
            instances[home] = self.instance(home, None, source="dir")
            asked.append({"dir": d, "found": True, "running": False})
            self.log(f"asked: {home} (not running, version {instances[home]['version']})")
        for pattern in self.common:
            for home in sorted(glob.glob(pattern)):
                home = os.path.normpath(home)
                if home not in instances and os.path.isdir(home) and self.is_nifi(pathlib.Path(home)):
                    instances[home] = self.instance(home, None, source="common-dir")
                    self.log(f"common directory: {home} (not running)")
        return {"instances": [instances[h] for h in sorted(instances)], "dirs": asked, "skipped": self.skipped}


class ServiceExecutor(ProtocolExecutor):
    """The service executor: the read channel, and executor-upgrade on the change channel."""

    PACKAGE = PACKAGE
    PACKAGE_FILES = PACKAGE_FILES
    MAIN = "service_executor.py"
    EXECUTOR = "service"
    # Read jobs: kind -> method(job) returning the job's result (a dict).
    READ_JOBS = {"svc-discover": "discover"}
    # Where discovery looks (tests point these elsewhere).
    PROC = "/proc"
    COMMON_DIRS = COMMON_DIRS
    INTERRUPTED = "The service executor stopped while this job ran."

    def __init__(self, cfg, out=sys.stdout, api=None):
        super().__init__(cfg, out=out, api=api)
        self.reads = {}  # job id -> thread, for the reads in flight
        self.reads_lock = threading.Lock()

    @property
    def version(self):
        # The module's VERSION, read each time: tests play a newer release by changing it.
        return VERSION

    @property
    def KINDS(self):
        return [*self.READ_JOBS, *ProtocolExecutor.KINDS]

    @staticmethod
    def user():
        """Who this executor runs as: not root, it sees and manages only that user's processes and files."""
        uid = os.geteuid()
        try:
            name = pwd.getpwuid(uid).pw_name
        except KeyError:
            name = str(uid)
        return name, uid == 0

    def describe(self):
        name, root = self.user()
        return f"service executor {VERSION} as {name}{'' if root else ' (not root: only its own services)'}"

    def discover(self, job):
        """svc-discover (§6 step 2): the NiFi on this machine, read only. request.dirs: installations to read as well,
        for instances not running or unpacked somewhere uncommon. Not root, only this user's processes are looked at."""
        dirs = job.request.get("dirs") or []
        if not isinstance(dirs, list) or len(dirs) > MAX_DIRS or not all(isinstance(d, str) and d.startswith("/") and "\0" not in d for d in dirs):
            raise Refused(f"dirs is a list of at most {MAX_DIRS} absolute paths")
        if not pathlib.Path(self.PROC).is_dir():
            raise Failed(f"{self.PROC} is not readable here: svc-discover needs Linux")
        name, root = self.user()
        found = Discovery(self.PROC, uid=None if root else os.geteuid(), common=self.COMMON_DIRS, log=job.log).run(dirs)
        job.log(f"found {len(found['instances'])} NiFi" + (f"; {len(found['skipped'])} process(es) of other users not looked at (not root)" if found["skipped"] else ""))
        return {"scannedAt": now_iso(), "user": name, "isRoot": root, **found}

    def beat_body(self, busy):
        body = super().beat_body(busy)
        name, root = self.user()
        with self.reads_lock:
            reading = sorted(self.reads)
        body.update({"user": name, "isRoot": root, "reading": reading, "readSlots": self.cfg["read_slots"]})
        return body

    # --- the loop: reads side by side, changes one at a time ------------------------------------------------

    def run_once(self, wait=0):
        self.deliver_pending()
        self.heartbeat()
        if not self.wait_for_slot(wait):
            return False
        request = self.api.next_job(wait)
        if not request:
            return False
        if request.get("kind") in self.READ_JOBS and request.get("protocol") in PROTOCOLS and ID_RE.match(str(request.get("id", ""))):
            self.start_read(request)
            return True
        # The change channel: one job, after the reads in flight (an executor-upgrade restarts the process).
        self.wait_reads()
        self.handle(request)
        return True

    def wait_for_slot(self, wait):
        """True once fewer reads than EXECUTOR_READ_SLOTS run; False when none ended within `wait` seconds."""
        end = time.monotonic() + max(wait, 0.05)
        while True:
            with self.reads_lock:
                for job_id, t in list(self.reads.items()):
                    if not t.is_alive():
                        del self.reads[job_id]
                if len(self.reads) < self.cfg["read_slots"]:
                    return True
            if time.monotonic() >= end:
                return False
            time.sleep(0.05)

    def wait_reads(self):
        with self.reads_lock:
            running = list(self.reads.values())
        for t in running:
            t.join()
        with self.reads_lock:
            self.reads = {k: t for k, t in self.reads.items() if t.is_alive()}

    def read_marker(self, job_id):
        return self.cfg["work"] / "reading" / f"{job_id}.json"

    def recover(self):
        """Jobs a previous process left running, on either channel, were interrupted."""
        super().recover()
        d = self.cfg["work"] / "reading"
        if not d.is_dir():
            return
        for marker in sorted(d.glob("*.json")):
            status = json.loads(marker.read_text())
            if status.get("state") not in FINAL:
                status.update(state="failed", finishedAt=now_iso(), message=self.INTERRUPTED)
                try:
                    self.api.put_status(status["id"], status)
                except Exception as e:
                    self.say(f"cannot send the status of {status['id']}, kept for later: {e}")
                    self.keep_pending(status)
            marker.unlink()

    def start_read(self, request):
        t = threading.Thread(target=self.run_read, args=(request,), daemon=True, name=f"read-{request['id']}")
        with self.reads_lock:
            self.reads[str(request["id"])] = t
        t.start()

    def read_timeout(self, request):
        asked = request.get("timeoutSeconds")
        limit = self.cfg["read_timeout"]
        return min(float(asked), limit) if isinstance(asked, (int, float)) and asked > 0 else limit

    def run_read(self, request):
        job = ReadJob(request, self.read_timeout(request))
        status = {"protocol": 2, "id": job.id, "kind": request.get("kind"), "state": "running", "startedAt": now_iso(), "steps": [], "result": {}}
        write_json(self.read_marker(job.id), status, mode=0o600)
        self.send_read_status(job, status)
        outcome = {}

        def work():
            try:
                outcome["result"] = getattr(self, self.READ_JOBS[request["kind"]])(job) or {}
            except Refused as e:
                outcome["refused"] = str(e)
            except Exception as e:
                outcome["failed"] = str(e) or type(e).__name__

        worker = threading.Thread(target=work, daemon=True, name=f"read-{job.id}-work")
        worker.start()
        worker.join(job.timeout)
        if worker.is_alive():
            # The reading thread cannot be stopped from here; whatever it finds later is dropped.
            status.update(state="failed", message=f"timed out after {job.timeout:g} seconds")
        elif "refused" in outcome:
            status.update(state="refused", message=outcome["refused"])
        elif "failed" in outcome:
            status.update(state="failed", message=outcome["failed"])
        else:
            status.update(state="succeeded", result=outcome["result"], message=None)
        status["finishedAt"] = now_iso()
        job.log(f"=== {status['state']}{': ' + status['message'] if status.get('message') else ''}")
        self.say(f"{job.id} {status['state']}{': ' + status['message'] if status.get('message') else ''}")
        self.send_read_status(job, status)
        self.read_marker(job.id).unlink(missing_ok=True)

    def send_read_status(self, job, status):
        """The read's log so far, then its status; kept for later when the Deployer cannot take them."""
        log = job.take_log()
        try:
            if log:
                self.api.append_log(job.id, log)
                log = ""
            self.api.put_status(job.id, status)
        except Exception as e:
            self.say(f"cannot send the status of {job.id}, kept for later: {e}")
            self.keep_pending(status, log)


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Open Atlas service executor")
    p.add_argument("command", choices=["serve", "once", "check"], help="serve: the systemd loop; once: one pass; check: print the configuration")
    p.add_argument("--env-file", default=os.environ.get("EXECUTOR_ENV_FILE", "/etc/open-atlas-deployer/service-executor.env"))
    a = p.parse_args(argv)
    cfg = config(a.env_file)
    ex = ServiceExecutor(cfg)
    if a.command == "check":
        name, root = ex.user()
        print(json.dumps({**{k: (str(v) if isinstance(v, pathlib.Path) else v) for k, v in cfg.items()}, "user": name, "root": root}, indent=2))
        return 0
    if a.command == "once":
        cfg["work"].mkdir(parents=True, exist_ok=True)
        ex.recover()
        ex.run_once()
        ex.wait_reads()
        return 0
    ex.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
