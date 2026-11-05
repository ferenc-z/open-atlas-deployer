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
from the directories it is given, and svc-read (§6 step 5), which reads an installation's configuration files for the
Deployer to import; their content goes once over the job's content channel, never into the job's status. The executor
refuses any kind it does not know, deploy jobs included.

The release holds one file: package.sh puts executor_core's code in place of the import block below (bundle.py).

Standard library only; Python 3.9.
"""
import base64
import glob
import hashlib
import hmac
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
        # svc-discover: where NiFi is looked for besides the running processes (globs, separated by spaces or commas;
        # set and empty: nowhere).
        "scan_dirs": tuple(re.split(r"[\s,]+", e["EXECUTOR_SCAN_DIRS"].strip())) if e.get("EXECUTOR_SCAN_DIRS", "").strip()
        else (() if "EXECUTOR_SCAN_DIRS" in e else COMMON_DIRS),
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
# Where NiFi is often unpacked; an instance there is found even when it does not run. EXECUTOR_SCAN_DIRS replaces them.
COMMON_DIRS = ("/opt/nifi*", "/opt/*/nifi*", "/usr/local/nifi*", "/srv/nifi*")
# The configuration files nifi.properties (or bootstrap.conf) names, resolved against the installation (NiFi's working
# directory): with conf.dir moved out of the installation, they may still be under <install>/conf.
CONF_FILE_KEYS = {
    "state-management.xml": ("nifi.properties", "nifi.state.management.configuration.file"),
    "authorizers.xml": ("nifi.properties", "nifi.authorizer.configuration.file"),
    "login-identity-providers.xml": ("nifi.properties", "nifi.login.identity.provider.configuration.file"),
    "zookeeper.properties": ("nifi.properties", "nifi.state.management.embedded.zookeeper.properties"),
    "bootstrap-notification-services.xml": ("bootstrap.conf", "notification.services.file"),
}
# Values never sent to the Deployer: passwords and keys in the properties, and secrets in the start environment.
SECRET_PROPERTY = re.compile(r"pass(word|wd|phrase)?|secret|token|credential|sensitive\.props\.key|\.key$|private", re.I)
SECRET_ENV = re.compile(r"PASS|SECRET|TOKEN|CREDENTIAL|_KEY$|^KEY$|PRIVATE|COOKIE", re.I)
HIDDEN = "(hidden)"
MAX_DIRS = 32
# svc-read: the largest configuration file sent, and all of one installation's together.
READ_FILE_MAX = 1 << 20
READ_TOTAL_MAX = 4 << 20
# Where an init system would start NiFi at boot (§6 step 3, the risk "no autostart", S10).
AUTOSTART_DIRS = ("/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system", "/etc/init.d")


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


def secret_fingerprints(props, key, pattern=SECRET_PROPERTY):
    """For the values hide_secrets hides: an HMAC under the Deployer's key (the request's fingerprintKey), so the nodes
    of a cluster can be compared (nifi.sensitive.props.key the same everywhere) without the value leaving the host."""
    return {k: hmac.new(key.encode(), f"{k}\0{v}".encode(), hashlib.sha256).hexdigest()[:32]
            for k, v in props.items() if v and pattern.search(k)}


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

    def __init__(self, proc="/proc", uid=None, common=COMMON_DIRS, log=lambda text: None, fingerprint_key=None, autostart=AUTOSTART_DIRS):
        self.proc = pathlib.Path(proc)
        self.uid = uid
        self.common = common
        self.log = log
        self.fingerprint_key = fingerprint_key
        self.autostart_dirs = autostart

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
            found[int(d.name)] = {"pid": int(d.name), "args": args, "uid": uid, "ppid": ppid}
        return found

    @staticmethod
    def define(args, name):
        prefix = f"-D{name}="
        return next((a[len(prefix):] for a in args if a.startswith(prefix)), None)

    @staticmethod
    def classpath(args):
        """The entries of a java command line's class path (-cp, -classpath, --class-path)."""
        for i, a in enumerate(args):
            if a in ("-cp", "-classpath", "--class-path") and i + 1 < len(args):
                yield from (e for e in args[i + 1].split(":") if e)
            elif a.startswith("--class-path="):
                yield from (e for e in a.split("=", 1)[1].split(":") if e)

    @classmethod
    def install_from_classpath(cls, args):
        """The installation whose lib/ the jars on the class path come from: lib/bootstrap/* (the bootstrap) or
        lib/*.jar (the NiFi JVM). Directories on the class path (conf/, wherever it is) do not count."""
        for entry in cls.classpath(args):
            if not (entry.endswith(".jar") or entry.endswith("/*")) or not entry.startswith("/"):
                continue
            parts = os.path.normpath(entry).split("/")[:-1]
            if "lib" in parts:
                at = len(parts) - 1 - parts[::-1].index("lib")
                return "/".join(parts[:at]) or "/"
        return None

    def cwd(self, pid):
        try:
            return os.path.normpath(os.readlink(self.proc / str(pid) / "cwd"))
        except OSError:
            return None

    @staticmethod
    def resolve(home, value):
        """A path NiFi reads relative to its working directory (nifi.sh starts it in the installation)."""
        return os.path.normpath(value if os.path.isabs(value) else os.path.join(str(home), value))

    @classmethod
    def layout(cls, home, conf=None, bootstrap_file=None, properties_file=None):
        """Where an installation's pieces are: installDir (bin/, lib/), confDir (nifi.properties and the files beside
        it), bootstrapFile. confDir, when not given: the directory of properties_file (the JVM's
        -Dnifi.properties.file.path), else bootstrap.conf's conf.dir (relative to the installation), else <install>/conf.
        bootstrap.conf: bootstrap_file (the bootstrap's -Dorg.apache.nifi.bootstrap.config.file), else <install>/conf
        (where nifi.sh reads it), else the conf directory."""
        home = os.path.normpath(str(home))
        if properties_file:
            properties_file = cls.resolve(home, properties_file)
            conf = conf or os.path.dirname(properties_file)
        if bootstrap_file:
            bootstrap_file = cls.resolve(home, bootstrap_file)
        else:
            candidates = [os.path.join(home, "conf", "bootstrap.conf")] + ([os.path.join(conf, "bootstrap.conf")] if conf else [])
            bootstrap_file = next((c for c in candidates if os.path.isfile(c)), candidates[0])
        if not conf:
            try:
                value = read_properties(bootstrap_file).get("conf.dir", "").strip()
            except OSError:
                value = ""
            conf = cls.resolve(home, value) if value else os.path.join(home, "conf")
        conf = os.path.normpath(conf)
        return {"installDir": home, "confDir": conf, "bootstrapFile": bootstrap_file,
                "propertiesFile": properties_file or os.path.join(conf, "nifi.properties")}

    def layout_of(self, main, boot):
        """An instance's layout from its processes (main: the NiFi JVM's, boot: the bootstrap's, either may be None).
        The installation: where the class path's jars are, else the working directory, else above the conf directory."""
        main_args, boot_args = (main or {}).get("args", []), (boot or {}).get("args", [])
        props = self.define(main_args, "nifi.properties.file.path")
        boot_file = self.define(boot_args, "org.apache.nifi.bootstrap.config.file") or self.define(main_args, "org.apache.nifi.bootstrap.config.file")
        home = self.install_from_classpath(main_args) or self.install_from_classpath(boot_args)
        if not home:
            home = self.cwd((boot or main)["pid"]) if (boot or main) else None
        if not home and (props or boot_file):
            if not os.path.isabs(props or boot_file):
                return None
            home = os.path.normpath(os.path.dirname(os.path.dirname(props or boot_file)))
        if not home:
            return None
        return self.layout(home, bootstrap_file=boot_file, properties_file=props)

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
        """(installDir, confDir) -> what its processes say (layout, bootstrap and NiFi JVM pids, user, java, start
        environment, ports). A NiFi JVM belongs with the bootstrap that started it (its parent); one installation may
        run several instances, each with its own conf directory."""
        procs = self.processes()
        groups = {}
        for pid, p in sorted(procs.items()):
            if NIFI_MAIN in p["args"]:
                parent = procs.get(p["ppid"])
                root = p["ppid"] if parent and NIFI_MAIN not in parent["args"] else pid
                groups.setdefault(root, {})["pid"] = pid
            else:
                groups.setdefault(pid, {})["bootstrapPid"] = pid
        out = {}
        for g in groups.values():
            main, boot = procs.get(g.get("pid")), procs.get(g.get("bootstrapPid"))
            where = self.layout_of(main, boot)
            if not where:
                continue
            entry = out.setdefault((where["installDir"], where["confDir"]), {"uid": (main or boot)["uid"], **where})
            for role in ("pid", "bootstrapPid"):
                if g.get(role):
                    entry.setdefault(role, g[role])
        for entry in out.values():
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
        """An installation: bin/nifi.sh, or lib/ with NiFi's jars (its conf/ may be elsewhere)."""
        home = pathlib.Path(home)
        return (home / "bin" / "nifi.sh").is_file() or any((home / "lib").glob("nifi-*.jar"))

    @staticmethod
    def not_nifi(home):
        """Why a directory is not an installation, for the asked directories."""
        if (pathlib.Path(home) / "conf" / "nifi.properties").is_file():
            return "conf/nifi.properties but no bin/nifi.sh or lib/ here: give the installation directory, with this one's conf/ as its conf directory"
        return "no bin/nifi.sh or lib/nifi-*.jar here: not a NiFi installation"

    @staticmethod
    def conf_files(where, props=None, boot=None):
        """name -> path of the configuration files (NIFI_CONF_FILES): nifi.properties and bootstrap.conf as the layout
        says, the ones nifi.properties or bootstrap.conf name where they name them (same kind of file), the rest in
        the conf directory."""
        conf = where["confDir"]
        out = {"nifi.properties": where["propertiesFile"], "bootstrap.conf": where["bootstrapFile"]}
        read = {"nifi.properties": props, "bootstrap.conf": boot}
        for name in NIFI_CONF_FILES:
            if name in out:
                continue
            path = os.path.join(conf, name)
            if name in CONF_FILE_KEYS:
                source, key = CONF_FILE_KEYS[name]
                values = read[source]
                if values is None:
                    try:
                        values = read[source] = read_properties(out[source])
                    except OSError:
                        values = read[source] = {}
                value = (values.get(key) or "").strip()
                if value and os.path.splitext(value)[1] == os.path.splitext(name)[1]:
                    path = Discovery.resolve(where["installDir"], value)
            out[name] = path
        return out

    @staticmethod
    def version(home):
        lib = home / "lib"
        for pattern in ("nifi-runtime-*.jar", "bootstrap/nifi-bootstrap-*.jar", "nifi-framework-api-*.jar"):
            for jar in sorted(lib.glob(pattern)):
                m = re.search(r"-(\d+\.\d+\.\d+[0-9A-Za-z.-]*?)\.jar$", jar.name)
                if m:
                    return m.group(1)
        return None

    @staticmethod
    def storage(home, props, env):
        """Where the repositories and the logs are, with the device each is on (st_dev): on one disk, a full content
        repository stops the logs too (a risk §6 step 3 lists)."""
        def place(value):
            path = pathlib.Path(os.path.normpath(value if os.path.isabs(value) else home / value))
            probe = path
            while not probe.exists() and probe != probe.parent:
                probe = probe.parent
            try:
                return {"path": str(path), "device": probe.stat().st_dev}
            except OSError:
                return {"path": str(path), "device": None}
        return {
            "flowfile": place(props.get("nifi.flowfile.repository.directory") or "./flowfile_repository"),
            "content": place(props.get("nifi.content.repository.directory.default") or "./content_repository"),
            "provenance": place(props.get("nifi.provenance.repository.directory.default") or "./provenance_repository"),
            "database": place(props.get("nifi.database.directory") or "./database_repository"),
            "logs": place((env or {}).get("NIFI_LOG_DIR") or "logs"),
        }

    def autostart(self, home):
        """The systemd units and init scripts that name the installation: what would start it at boot."""
        found = []
        for d in self.autostart_dirs:
            try:
                entries = sorted(pathlib.Path(d).iterdir())
            except OSError:
                continue
            for f in entries:
                try:
                    if f.is_file() and f.stat().st_size < 65536 and str(home) in f.read_text(errors="replace"):
                        found.append(str(f))
                except OSError:
                    continue
        return found

    def instance(self, where, proc=None, source="process"):
        """What one instance is (where: its layout): version, users, start environment, ports, the cluster settings,
        file fingerprints."""
        home = pathlib.Path(where["installDir"])
        problems = list((proc or {}).get("problems", []))
        props_file, boot_file = where["propertiesFile"], where["bootstrapFile"]
        props, boot = {}, {}
        try:
            props = read_properties(props_file)
        except OSError as e:
            problems.append(f"cannot read {props_file}: {e.strerror or e}")
        try:
            boot = read_properties(boot_file)
        except OSError as e:
            problems.append(f"cannot read {boot_file}: {e.strerror or e}")
        try:
            owner = user_name(home.stat().st_uid)
        except OSError:
            owner = None
        files = []
        for name, path in self.conf_files(where, props, boot).items():
            path = pathlib.Path(path)
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
            # Where nifi.properties is (and the files beside it): <install>/conf unless conf.dir moved it.
            "confDir": where["confDir"],
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
            # Only when the Deployer sent a fingerprintKey (older Deployers did not).
            **({"fingerprints": {"nifi.properties": secret_fingerprints(props, self.fingerprint_key),
                                 "bootstrap.conf": secret_fingerprints(boot, self.fingerprint_key)}} if self.fingerprint_key else {}),
            "storage": self.storage(home, props, (proc or {}).get("environment")),
            "autostart": self.autostart(home),
            "files": files,
            "problems": problems,
        }

    @staticmethod
    def asked_dir(d):
        """One entry of request.dirs: an installation's path, or {"install": path, "conf": path} when its conf
        directory is elsewhere (and conf.dir in bootstrap.conf does not say so). (install, conf or None), or None."""
        ok = lambda p: isinstance(p, str) and p.startswith("/") and "\0" not in p and len(p) <= 1024
        if ok(d):
            return d, None
        if isinstance(d, dict) and set(d) <= {"install", "conf"} and ok(d.get("install")) and (d.get("conf") is None or ok(d["conf"])):
            return d["install"], d.get("conf")
        return None

    def run(self, dirs=()):
        """Every NiFi found: running ones from their processes, then the asked and the common directories."""
        procs = self.running()
        instances = {key: self.instance(p, p) for key, p in procs.items()}
        for key, i in instances.items():
            self.log(f"running: {key[0]} conf {key[1]} (pid {procs[key].get('pid') or '-'}, version {i['version']})")
        asked = []
        for d in dirs:
            install, conf = self.asked_dir(d)
            home = os.path.normpath(install)
            shown = {"dir": install, **({"conf": conf} if conf else {})}
            if not os.path.isdir(home):
                asked.append({**shown, "found": False, "error": "no such directory (or not readable by this executor)"})
                continue
            if conf and not os.path.isfile(os.path.join(conf, "nifi.properties")):
                asked.append({**shown, "found": False, "error": f"no nifi.properties in {conf} (or not readable by this executor)"})
                continue
            if conf is None:
                # An installation that runs: whichever conf directory it runs with (a nifi.sh changed to read another
                # bootstrap.conf would not show in conf.dir).
                same = [k for k in instances if k[0] == home and instances[k]["running"]]
                if same:
                    asked.append({**shown, "found": True, "running": True})
                    continue
            where = self.layout(home, conf=os.path.normpath(conf) if conf else None)
            key = (where["installDir"], where["confDir"])
            if key in instances:
                asked.append({**shown, "found": True, "running": instances[key]["running"]})
                continue
            if not self.is_nifi(home):
                asked.append({**shown, "found": False, "error": self.not_nifi(home)})
                continue
            instances[key] = self.instance(where, None, source="dir")
            asked.append({**shown, "found": True, "running": False})
            self.log(f"asked: {home} conf {where['confDir']} (not running, version {instances[key]['version']})")
        for pattern in self.common:
            for home in sorted(glob.glob(pattern)):
                home = os.path.normpath(home)
                if any(k[0] == home for k in instances) or not os.path.isdir(home) or not self.is_nifi(home):
                    continue
                where = self.layout(home)
                instances[(where["installDir"], where["confDir"])] = self.instance(where, None, source="common-dir")
                self.log(f"common directory: {home} conf {where['confDir']} (not running)")
        return {"instances": [instances[k] for k in sorted(instances)], "dirs": asked, "skipped": self.skipped}


class ServiceExecutor(ProtocolExecutor):
    """The service executor: the read channel, and executor-upgrade on the change channel."""

    PACKAGE = PACKAGE
    PACKAGE_FILES = PACKAGE_FILES
    MAIN = "service_executor.py"
    EXECUTOR = "service"
    # Read jobs: kind -> method(job) returning the job's result (a dict).
    READ_JOBS = {"svc-discover": "discover", "svc-read": "read_files"}
    # Where discovery looks (tests point these elsewhere; the directories scanned are the configuration's scan_dirs).
    PROC = "/proc"
    AUTOSTART_DIRS = AUTOSTART_DIRS
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
        if not isinstance(dirs, list) or len(dirs) > MAX_DIRS or not all(Discovery.asked_dir(d) for d in dirs):
            raise Refused(f"dirs is a list of at most {MAX_DIRS} installations: absolute paths, or {{install, conf}} with absolute paths")
        if not pathlib.Path(self.PROC).is_dir():
            raise Failed(f"{self.PROC} is not readable here: svc-discover needs Linux")
        key = job.request.get("fingerprintKey")
        if key is not None and (not isinstance(key, str) or not 16 <= len(key) <= 128):
            raise Refused("fingerprintKey is a string of 16 to 128 characters")
        name, root = self.user()
        found = Discovery(self.PROC, uid=None if root else os.geteuid(), common=self.cfg.get("scan_dirs", COMMON_DIRS), log=job.log, fingerprint_key=key,
                          autostart=self.AUTOSTART_DIRS).run(dirs)
        job.log(f"found {len(found['instances'])} NiFi" + (f"; {len(found['skipped'])} process(es) of other users not looked at (not root)" if found["skipped"] else ""))
        return {"scannedAt": now_iso(), "user": name, "isRoot": root, **found}

    def read_files(self, job):
        """svc-read (§6 step 5): an installation's configuration files, for the Deployer to import as the first revision.
        request.installDir: a NiFi installation (absolute); request.confDir: its conf directory as discovery reported
        it (absent: as discovery would find it, bootstrap.conf's conf.dir or <install>/conf); request.bootstrapFile: the
        bootstrap.conf discovery saw (absent: <install>/conf's, else the conf directory's); request.files: names among
        the configuration files (NIFI_CONF_FILES), all of them when absent. Each is read where discovery fingerprinted
        it (Discovery.conf_files). The content goes once over the content channel (it holds passwords and keys; the
        Deployer seals them); the status carries only names, sizes and hashes."""
        home, conf, names = job.request.get("installDir"), job.request.get("confDir"), job.request.get("files")
        if not isinstance(home, str) or not home.startswith("/") or "\0" in home:
            raise Refused("installDir is the absolute path of a NiFi installation")
        if conf is not None and (not isinstance(conf, str) or not conf.startswith("/") or "\0" in conf):
            raise Refused("confDir is the absolute path of the installation's conf directory")
        if names is None:
            names = list(NIFI_CONF_FILES)
        if not isinstance(names, list) or not all(n in NIFI_CONF_FILES for n in names):
            raise Refused(f"files are names among {', '.join(NIFI_CONF_FILES)}")
        home = pathlib.Path(os.path.normpath(home))
        if not home.is_dir() or not Discovery.is_nifi(home):
            raise Refused(f"{home} is not a NiFi installation (or not readable by this executor)")
        if conf is not None and not os.path.isfile(os.path.join(conf, "nifi.properties")):
            raise Refused(f"{conf} holds no nifi.properties (or is not readable by this executor)")
        boot = job.request.get("bootstrapFile")
        if boot is not None and (not isinstance(boot, str) or not boot.startswith("/") or "\0" in boot or os.path.basename(boot) != "bootstrap.conf"):
            raise Refused("bootstrapFile is the absolute path of the installation's bootstrap.conf")
        where = Discovery.layout(home, conf=os.path.normpath(conf) if conf else None, bootstrap_file=boot)
        paths = Discovery.conf_files(where)
        files, content, missing, total = [], [], [], 0
        for name in dict.fromkeys(names):
            path = pathlib.Path(paths[name])
            try:
                data = path.read_bytes() if path.is_file() else None
                st = path.stat() if data is not None else None
            except OSError as e:
                raise Failed(f"cannot read {path}: {e.strerror or e}")
            if data is None:
                missing.append(name)
                continue
            if len(data) > READ_FILE_MAX or total + len(data) > READ_TOTAL_MAX:
                raise Failed(f"{path} is too large to import ({len(data)} bytes)")
            total += len(data)
            meta = {"name": name, "path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "modifiedAt": iso_at(st.st_mtime)}
            files.append(meta)
            content.append({**meta, "content": base64.b64encode(data).decode()})
            job.log(f"read {path} ({len(data)} bytes)")
        self.api.put_env_content(job.id, json.dumps({"installDir": str(home), "confDir": where["confDir"], "files": content}))
        return {"installDir": str(home), "confDir": where["confDir"], "files": files, "missing": missing}

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
