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

Beside the jobs runs the collector (§9.1, §15.3): every EXECUTOR_COLLECT_SECONDS it samples each NiFi the Deployer
watches on this machine (the watch list comes with every heartbeat reply, §15.2 P5; nothing else is sampled): the
process and the host from /proc, the disks of the repositories and logs, the NiFi's REST API with the monitor
certificate (EXECUTOR_NIFI_CLIENT_CERT/KEY/CA, S11, P6) and, once an hour, the expiry of the certificates in its
keystore and truststore (keytool, the password passed in the environment) and of the monitor certificate (S27). The
samples go to POST /executor/v1/samples, at most 20 at a time; those the Deployer cannot take wait in memory up to 30
minutes. One NiFi that hangs costs at most 10 seconds of its own sample.

The release holds one file: package.sh puts executor_core's code in place of the import block below (bundle.py).

Standard library only; Python 3.9.
"""
import base64
import glob
import hashlib
import hmac
import http.client
import json
import os
import pathlib
import pwd
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time

# >>> executor_core
# The protocol, registration and self-upgrade every executor shares (executor_core.py, S18). package.sh (bundle.py) puts
# that module's code in place of this block, so a release stays one file that launch.sh runs as it is.
from executor_core import (  # noqa: F401
    FINAL, ID_RE, PROTOCOLS, Failed, ProtocolExecutor, Refused, Restarting, load_env_file, now_iso, write_json)
# <<< executor_core

VERSION = "0.8.0"
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
        # The collector (§9.1, §15.3): how often it samples the NiFi the Deployer watches here (30 to 300 seconds), and
        # the monitor certificate it calls their REST API with (S11, §15.2 P6; files of mode 600). Without the
        # certificate it samples only /proc and the disks. EXECUTOR_NIFI_CA_RELAXED=1 accepts a CA whose Basic
        # Constraints are not marked critical (Python 3.13+ refuses it under VERIFY_X509_STRICT; the lab's toolkit CA).
        "collect_seconds": min(COLLECT_MAX, max(COLLECT_MIN, int(e.get("EXECUTOR_COLLECT_SECONDS", str(COLLECT_DEFAULT))))),
        "nifi_client_cert": e.get("EXECUTOR_NIFI_CLIENT_CERT", "").strip(),
        "nifi_client_key": e.get("EXECUTOR_NIFI_CLIENT_KEY", "").strip(),
        "nifi_ca": e.get("EXECUTOR_NIFI_CA", "").strip(),
        "nifi_ca_relaxed": e.get("EXECUTOR_NIFI_CA_RELAXED", "").strip().lower() in ("1", "true", "yes"),
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


# --- the collector (§9.1, §15.3): a sample of every NiFi the Deployer watches on this machine, every minute ----------

COLLECT_DEFAULT, COLLECT_MIN, COLLECT_MAX = 60, 30, 300
# Per NiFi and round, and per REST request: a NiFi that hangs costs its own sample at most this, never the others'.
NIFI_BUDGET = 10.0
REQUEST_TIMEOUT = 5.0
# The push (POST /executor/v1/samples): at most this many per request; while the Deployer cannot take them they wait in
# memory, the oldest dropped after 30 minutes (and beyond MAX_BACKLOG).
SAMPLES_PER_POST = 20
BACKLOG_SECONDS = 30 * 60
MAX_BACKLOG = 2000
# Certificates (S27) are read once an hour, or when nifi.properties or a store file changes.
CERTS_EVERY = 3600
BULLETINS = 50
MESSAGE_MAX = 2048
REST_MAX = 4 << 20
WATCH_MAX = 64
# nifi.web.https.host values that bind every interface: the collector then connects to localhost.
WILDCARD_HOSTS = ("", "0.0.0.0", "::", "[::]")
DN_NAMES = {"commonName": "CN", "organizationalUnitName": "OU", "organizationName": "O", "countryName": "C", "localityName": "L", "stateOrProvinceName": "ST"}
MONTHS = {m: i for i, m in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}


def ok_path(p):
    return isinstance(p, str) and p.startswith("/") and "\0" not in p and len(p) <= 1024


def watch_entries(value):
    """The watch list of a heartbeat reply (§15.2 P5): what the Deployer registered on this host (service id, member,
    profile, installation and conf directory, HTTPS host and port, log directory). Malformed entries are left out."""
    out = []
    for w in (value if isinstance(value, list) else [])[:WATCH_MAX]:
        if not isinstance(w, dict) or not all(isinstance(w.get(k), str) and w[k] for k in ("service", "member")) or not ok_path(w.get("installDir")):
            continue
        conf, logs = w.get("confDir"), w.get("logDir")
        https = w.get("https") if isinstance(w.get("https"), dict) else {}
        out.append({
            "service": w["service"][:200], "member": w["member"][:1200],
            "profile": w["profile"] if isinstance(w.get("profile"), str) else None,
            "installDir": os.path.normpath(w["installDir"]), "confDir": os.path.normpath(conf) if ok_path(conf) else None,
            "https": {"host": https["host"] if isinstance(https.get("host"), str) else None, "port": as_port(https.get("port"))},
            "nodeAddress": w["nodeAddress"] if isinstance(w.get("nodeAddress"), str) else None,
            "logDir": os.path.normpath(logs) if ok_path(logs) else None,
        })
    return out


def java_date(text):
    """keytool's date ("Wed Nov 04 14:19:17 UTC 2026", run in English and UTC) as ISO 8601; other zones as given."""
    m = re.match(r"^\w{3} (\w{3}) (\d{1,2}) (\d\d):(\d\d):(\d\d) (UTC|GMT) (\d{4})$", text.strip())
    if not m or m.group(1) not in MONTHS:
        return text.strip()
    return f"{m.group(7)}-{MONTHS[m.group(1)]:02d}-{int(m.group(2)):02d}T{m.group(3)}:{m.group(4)}:{m.group(5)}Z"


def parse_keytool(text):
    """The certificates of `keytool -list -v`: per entry its alias, and per certificate (a private key entry has a
    chain: chain 1 is the entry's own) the subject, issuer and validity."""
    certs, alias, chain, cur = [], None, None, None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("Alias name:"):
            alias, chain, cur = s.split(":", 1)[1].strip(), None, None
        elif re.match(r"^Certificate\[\d+\]:$", s):
            chain = int(s[12:-2])
        elif s.startswith("Owner:"):
            cur = {"alias": alias, **({"chain": chain} if chain else {}), "subject": s[6:].strip()}
            certs.append(cur)
        elif s.startswith("Issuer:") and cur is not None and "issuer" not in cur:
            cur["issuer"] = s[7:].strip()
        elif s.startswith("Valid from:") and cur is not None and "notAfter" not in cur:
            m = re.match(r"^Valid from: (.+) until: (.+)$", s)
            if m:
                cur["notBefore"], cur["notAfter"] = java_date(m.group(1)), java_date(m.group(2))
    return certs


def keytool_error(text):
    """What a failed keytool said, in one line."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    said = next((line for line in lines if line.startswith("keytool error:")), lines[0] if lines else "keytool failed")
    return re.sub(r"^keytool error:\s*(java\.[\w.]+Exception:\s*)?", "", said)[:300]


def pem_certificate(path):
    """A PEM certificate's subject, issuer and validity (the monitor certificate), without a library."""
    try:
        decoded = ssl._ssl._test_decode_cert(str(path))  # noqa: SLF001 (the standard library's own PEM reader)
    except (AttributeError, OSError, ssl.SSLError) as e:
        raise Failed(f"cannot read {path}: {getattr(e, 'strerror', None) or e}")

    def dn(rdns):
        # Most specific first, as keytool prints it.
        return ", ".join(f"{DN_NAMES.get(k, k)}={v}" for rdn in reversed(rdns or ()) for k, v in rdn)

    def iso(value):
        return iso_at(ssl.cert_time_to_seconds(value)) if value else None
    return {"subject": dn(decoded.get("subject")), "issuer": dn(decoded.get("issuer")), "notBefore": iso(decoded.get("notBefore")), "notAfter": iso(decoded.get("notAfter"))}


def nifi_context(cfg):
    """The TLS context of the collector's REST calls: the monitor certificate (S11), the CA it trusts, the host name
    checked. (context, None), or (None, why not)."""
    cert, key, ca = cfg.get("nifi_client_cert"), cfg.get("nifi_client_key"), cfg.get("nifi_ca")
    if not cert or not key:
        return None, "no monitor certificate (EXECUTOR_NIFI_CLIENT_CERT and EXECUTOR_NIFI_CLIENT_KEY are not set)"
    try:
        ctx = ssl.create_default_context(cafile=ca or None)
        if cfg.get("nifi_ca_relaxed"):
            ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
        ctx.load_cert_chain(cert, key)
    except (OSError, ssl.SSLError) as e:
        return None, f"cannot load the monitor certificate: {getattr(e, 'strerror', None) or e}"
    return ctx, None


class SniConnection(http.client.HTTPSConnection):
    """HTTPS to one address, with the TLS server name (SNI and the host name checked) set apart: the collector may
    connect to localhost while the NiFi's certificate names nifi.web.https.host."""

    def __init__(self, host, port, sni, context, timeout):
        super().__init__(host, port, timeout=timeout, context=context)
        self.sni, self.tls = sni, context

    def connect(self):
        sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self.tls.wrap_socket(sock, server_hostname=self.sni)


def endpoint(https_host, node_address=None):
    """(where to connect, the TLS name): nifi.web.https.host when it names one; else localhost, checked against the
    node address (or localhost)."""
    host = (https_host or "").strip()
    if host in WILDCARD_HOSTS:
        return "localhost", (node_address or "localhost")
    return host, host


def _num(d, *keys):
    return {k: d[k] for k in keys if isinstance(d.get(k), (int, float)) and not isinstance(d.get(k), bool)}


def _storage(u):
    return {"identifier": u.get("identifier"), **_num(u, "totalSpaceBytes", "usedSpaceBytes", "freeSpaceBytes")}


def trim_snapshot(s):
    """One system-diagnostics snapshot: heap, threads, GC, repositories, versions."""
    s = s if isinstance(s, dict) else {}
    v = s.get("versionInfo") or {}
    return {
        "heap": {"usedBytes": s.get("usedHeapBytes"), "maxBytes": s.get("maxHeapBytes"), "totalBytes": s.get("totalHeapBytes")},
        "nonHeapUsedBytes": s.get("usedNonHeapBytes"),
        **_num(s, "totalThreads", "daemonThreads", "availableProcessors", "processorLoadAverage"),
        "uptime": s.get("uptime"),
        "gc": [{"name": g.get("name"), "count": g.get("collectionCount"), "millis": g.get("collectionMillis")} for g in s.get("garbageCollection") or [] if isinstance(g, dict)],
        "repositories": {
            "flowfile": [_storage(s["flowFileRepositoryStorageUsage"])] if isinstance(s.get("flowFileRepositoryStorageUsage"), dict) else [],
            "content": [_storage(u) for u in s.get("contentRepositoryStorageUsage") or [] if isinstance(u, dict)],
            "provenance": [_storage(u) for u in s.get("provenanceRepositoryStorageUsage") or [] if isinstance(u, dict)],
        },
        "version": v.get("niFiVersion"), "java": v.get("javaVersion"),
    }


def trim_about(d):
    a = (d or {}).get("about") or {}
    return {k: a[k] for k in ("version", "buildTag", "timezone") if k in a}


def trim_diagnostics(d):
    sd = (d or {}).get("systemDiagnostics") or {}
    out = {"aggregate": trim_snapshot(sd.get("aggregateSnapshot"))}
    if isinstance(sd.get("nodeSnapshots"), list):
        out["nodes"] = [{"nodeId": n.get("nodeId"), "address": n.get("address"), "apiPort": n.get("apiPort"), **trim_snapshot(n.get("snapshot"))}
                        for n in sd["nodeSnapshots"] if isinstance(n, dict)]
    return out


def trim_status(d):
    cs = (d or {}).get("controllerStatus") or {}
    return {k: v for k, v in cs.items() if isinstance(v, (int, float, bool)) or k == "connectedNodes"}


def trim_cluster(d):
    nodes = ((d or {}).get("cluster") or {}).get("nodes") or []
    keep = ("nodeId", "address", "apiPort", "status", "roles", "heartbeat", "nodeStartTime", "activeThreadCount", "flowFilesQueued", "bytesQueued")
    return {"nodes": [{**{k: n.get(k) for k in keep if k in n},
                       "events": [{"timestamp": e.get("timestamp"), "category": e.get("category"), "message": str(e.get("message", ""))[:MESSAGE_MAX]}
                                  for e in (n.get("events") or [])[:5] if isinstance(e, dict)]} for n in nodes if isinstance(n, dict)]}


def trim_bulletins(d):
    """The bulletins: id, time (NiFi gives only the time of day, in its own zone), node, level, source, message."""
    out = []
    for b in ((d or {}).get("bulletinBoard") or {}).get("bulletins") or []:
        if not isinstance(b, dict):
            continue
        inner = b.get("bulletin") if isinstance(b.get("bulletin"), dict) else {}
        out.append({"id": b.get("id", inner.get("id")), "timestamp": b.get("timestamp", inner.get("timestamp")), "nodeAddress": b.get("nodeAddress", inner.get("nodeAddress")),
                    **{k: inner.get(k) for k in ("level", "category", "sourceId", "sourceName", "sourceType", "groupId") if inner.get(k) is not None},
                    **({"message": str(inner["message"])[:MESSAGE_MAX]} if inner.get("message") is not None else {})})
    return out


TRIM = {"about": trim_about, "diagnostics": trim_diagnostics, "status": trim_status, "cluster": trim_cluster, "bulletins": trim_bulletins}


class Collector:
    """Samples the watched NiFi (§15.3): process and host from /proc, disks, the REST API with the monitor certificate,
    the certificates' expiry (S27). Only reads; passwords and keys never leave the host. Tests replace fetch and keytool."""

    def __init__(self, cfg, proc="/proc", uid=None, log=lambda text: None):
        self.cfg = cfg
        self.proc = pathlib.Path(proc)
        self.uid = uid
        self.log = log
        self.certs = {}      # member -> {"at": monotonic, "signature": ..., "stores": [...]}
        self.keytools = {}   # member -> the keytool last found for it (a stopped NiFi has no JAVA_HOME to look at)
        self.bulletins = {}  # member -> the bulletin keys of its last sample: only new ones are sent

    # --- host and processes ---

    def host(self):
        out = {"cpus": os.cpu_count()}
        try:
            out["load"] = [float(x) for x in (self.proc / "loadavg").read_text().split()[:3]]
        except (OSError, ValueError):
            pass
        try:
            mem = {k: int(v.split()[0]) * 1024 for k, v in (line.split(":", 1) for line in (self.proc / "meminfo").read_text().splitlines() if ":" in line) if v.split()}
            out["memory"] = {"totalBytes": mem.get("MemTotal"), "availableBytes": mem.get("MemAvailable")}
        except (OSError, ValueError):
            pass
        return out

    def process(self, pid):
        """A process's resident memory and CPU seconds so far (the Deployer works out the rate)."""
        out = {}
        try:
            status = dict(line.split(":", 1) for line in (self.proc / str(pid) / "status").read_text().splitlines() if ":" in line)
            if "VmRSS" in status:
                out["rssBytes"] = int(status["VmRSS"].split()[0]) * 1024
            if "Threads" in status:
                out["threads"] = int(status["Threads"].strip())
        except (OSError, ValueError, IndexError):
            pass
        try:
            fields = (self.proc / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
            out["cpuSeconds"] = round((int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK"), 2)
        except (OSError, ValueError, IndexError):
            pass
        return out

    @staticmethod
    def disks(places):
        """The disks the repositories and logs are on, once per device (st_dev), with what each holds."""
        by_dev = {}
        for name, path in places.items():
            probe = pathlib.Path(path)
            while not probe.exists() and probe != probe.parent:
                probe = probe.parent
            try:
                st, vfs = probe.stat(), os.statvfs(probe)
            except OSError:
                continue
            d = by_dev.setdefault(st.st_dev, {"device": st.st_dev, "path": str(probe), "totalBytes": vfs.f_blocks * vfs.f_frsize,
                                              "freeBytes": vfs.f_bavail * vfs.f_frsize, "usedBytes": (vfs.f_blocks - vfs.f_bfree) * vfs.f_frsize, "holds": []})
            d["holds"].append(name)
        return list(by_dev.values())

    # --- REST ---

    def context(self):
        return nifi_context(self.cfg)

    def fetch(self, ctx, connect, port, sni, path, timeout):
        """GET /nifi-api/<path>: (HTTP status, body). The Host header names the NiFi as it knows itself."""
        conn = SniConnection(connect, port, sni, ctx, timeout)
        try:
            conn.request("GET", f"/nifi-api/{path}", headers={"Host": f"{sni}:{port}", "Accept": "application/json", "User-Agent": f"{PACKAGE}/{VERSION}"})
            r = conn.getresponse()
            return r.status, r.read(REST_MAX)
        finally:
            conn.close()

    def rest(self, w, props, ctx, why_not):
        """What the NiFi's REST API says, within NIFI_BUDGET. state: ok, partial (some calls failed), unreachable,
        no-certificate (only /proc and the disks), no-https."""
        if ctx is None:
            return {"state": "no-certificate", "error": why_not}
        port = w["https"]["port"] or as_port(props.get("nifi.web.https.port"))
        if not port:
            return {"state": "no-https", "error": "nifi.web.https.port is not set: the collector only calls NiFi over HTTPS"}
        connect, sni = endpoint(w["https"]["host"] if w["https"]["host"] is not None else props.get("nifi.web.https.host"),
                                w.get("nodeAddress") or props.get("nifi.cluster.node.address"))
        node = props.get("nifi.cluster.is.node", "false").strip().lower() == "true"
        calls = [("about", "flow/about"), ("diagnostics", "system-diagnostics?nodewise=true" if node else "system-diagnostics"), ("status", "flow/status"),
                 *([("cluster", "controller/cluster")] if node else []), ("bulletins", f"flow/bulletin-board?limit={BULLETINS}")]
        out, errors = {"state": "ok", "url": f"https://{sni}:{port}"}, {}
        deadline = time.monotonic() + NIFI_BUDGET
        for name, path in calls:
            left = deadline - time.monotonic()
            if left < 0.5:
                errors[name] = f"skipped: {NIFI_BUDGET:g} seconds were used up"
                continue
            try:
                status, body = self.fetch(ctx, connect, port, sni, path, min(REQUEST_TIMEOUT, left))
            except (OSError, ssl.SSLError, http.client.HTTPException) as e:
                errors[name] = (str(e) or type(e).__name__)[:300]
                if name == "about":
                    # Not answering at all: the rest would only wait the same way.
                    return {"state": "unreachable", "url": out["url"], "error": errors[name]}
                continue
            if status != 200:
                errors[name] = f"HTTP {status}: {body[:200].decode('utf-8', 'replace').strip()}"
                continue
            try:
                out[name] = TRIM[name](json.loads(body))
            except (ValueError, AttributeError, TypeError) as e:
                errors[name] = f"unexpected answer: {e}"[:300]
        if errors:
            out.update(state="partial", errors=errors)
        return out

    # --- certificates (S27) ---

    def keytool(self, member, proc, boot):
        """keytool of the JDK the NiFi runs on: next to its java, in its JAVA_HOME, next to bootstrap.conf's java=,
        else the PATH's."""
        candidates = []
        if proc and proc.get("java"):
            candidates.append(os.path.join(os.path.dirname(proc["java"]), "keytool"))
        java_home = ((proc or {}).get("environment") or {}).get("JAVA_HOME")
        if java_home:
            candidates.append(os.path.join(java_home, "bin", "keytool"))
        if (boot.get("java") or "").startswith("/"):
            candidates.append(os.path.join(os.path.dirname(boot["java"]), "keytool"))
        found = next((c for c in candidates if os.path.isfile(c) and os.access(c, os.X_OK)), None) or self.keytools.get(member) or shutil.which("keytool")
        if found:
            self.keytools[member] = found
        return found

    def run_keytool(self, keytool, path, store_type, password):
        """keytool -list -v in English and UTC; the password goes in the environment (-storepass:env), never the command line."""
        args = [keytool, "-J-Duser.language=en", "-J-Duser.country=US", "-J-Duser.timezone=UTC", "-list", "-v", "-keystore", path, "-storetype", store_type]
        env = dict(os.environ)
        if password:
            args += ["-storepass:env", "OA_STOREPASS"]
            env["OA_STOREPASS"] = password
        p = subprocess.run(args, env=env, capture_output=True, text=True, timeout=20, input="")
        return p.returncode, p.stdout + p.stderr

    def store_certs(self, member, where, props, boot, proc):
        """The keystore's and truststore's certificates, as nifi.properties names them."""
        out = []
        for store in ("keystore", "truststore"):
            path = (props.get(f"nifi.security.{store}") or "").strip()
            if not path:
                continue
            path = Discovery.resolve(where["installDir"], path)
            given = (props.get(f"nifi.security.{store}Type") or "").strip().upper()
            store_type = given or ("JKS" if path.lower().endswith(".jks") else "PKCS12")
            entry = {"store": store, "path": path, "type": store_type}
            if (props.get(f"nifi.security.{store}Passwd.protected") or "").strip():
                entry["error"] = f"the {store} password is encrypted in nifi.properties (nifi.security.{store}Passwd.protected); the collector cannot read the store"
            elif not os.path.isfile(path):
                entry["error"] = f"{path} does not exist (or is not readable by this executor)"
            else:
                tool = self.keytool(member, proc, boot)
                if not tool:
                    entry["error"] = "keytool not found (next to the NiFi's java, in its JAVA_HOME, or on the PATH)"
                else:
                    try:
                        code, text = self.run_keytool(tool, path, store_type, props.get(f"nifi.security.{store}Passwd") or "")
                    except (OSError, subprocess.SubprocessError) as e:
                        code, text = -1, f"keytool error: {e}"
                    certs = parse_keytool(text) if code == 0 else []
                    if code != 0 or not certs and "contains 0 entries" not in text:
                        entry["error"] = keytool_error(text) if code != 0 else "keytool listed no certificate"
                    entry["certificates"] = certs
            out.append(entry)
        return out

    def monitor_cert(self):
        cert = self.cfg.get("nifi_client_cert")
        if not cert:
            return []
        entry = {"store": "monitor", "path": cert, "type": "PEM"}
        try:
            entry["certificates"] = [pem_certificate(cert)]
        except Failed as e:
            entry["error"] = str(e)
        return [entry]

    def certificates(self, w, where, props, boot, proc):
        """The certificates, read again once an hour or when nifi.properties or a store changed."""
        def stamp(p):
            try:
                return os.stat(p).st_mtime
            except OSError:
                return None
        files = [where["propertiesFile"], self.cfg.get("nifi_client_cert") or ""]
        files += [Discovery.resolve(where["installDir"], (props.get(f"nifi.security.{s}") or "").strip()) for s in ("keystore", "truststore") if (props.get(f"nifi.security.{s}") or "").strip()]
        signature = [(f, stamp(f)) for f in files]
        cached = self.certs.get(w["member"])
        if cached and cached["signature"] == signature and time.monotonic() - cached["at"] < CERTS_EVERY and not cached.get("retry"):
            return cached["value"]
        stores = self.store_certs(w["member"], where, props, boot, proc) + self.monitor_cert()
        value = {"readAt": now_iso(), "stores": stores}
        # A keytool not found while the NiFi is stopped is tried again next round, not in an hour.
        self.certs[w["member"]] = {"at": time.monotonic(), "signature": signature, "value": value,
                                   "retry": any("keytool not found" in (s.get("error") or "") for s in stores)}
        return value

    # --- one round ---

    def running(self):
        try:
            return Discovery(self.proc, uid=self.uid).running()
        except OSError as e:
            self.log(f"collector: cannot read {self.proc}: {e}")
            return {}

    def sample(self, w, procs, host, ctx, why_not):
        """One watched NiFi's sample. Whatever fails is said in it; nothing here stops the other NiFi's."""
        where = Discovery.layout(w["installDir"], conf=w["confDir"])
        out = {"service": w["service"], "member": w["member"], "at": now_iso(), "host": host, "problems": []}
        props, boot = {}, {}
        try:
            props = read_properties(where["propertiesFile"])
        except OSError as e:
            out["problems"].append(f"cannot read {where['propertiesFile']}: {e.strerror or e}")
        try:
            boot = read_properties(where["bootstrapFile"])
        except OSError:
            pass
        proc = procs.get((where["installDir"], where["confDir"]))
        running = bool(proc and proc.get("pid"))
        out["process"] = {"running": running, **({k: proc.get(k) for k in ("pid", "bootstrapPid", "startedAt")} if proc else {}),
                          **(self.process(proc["pid"]) if running else {})}
        places = {k: v["path"] for k, v in Discovery.storage(pathlib.Path(where["installDir"]), props, (proc or {}).get("environment")).items()}
        if w.get("logDir"):
            places["logs"] = w["logDir"]
        out["disks"] = self.disks(places)
        out["nifi"] = self.rest(w, props, ctx, why_not) if running else {"state": "not-running"}
        if "bulletins" in out["nifi"]:
            keys = {(b.get("id"), b.get("timestamp"), b.get("nodeAddress")) for b in out["nifi"]["bulletins"]}
            seen = self.bulletins.get(w["member"], set())
            out["nifi"]["bulletins"] = [b for b in out["nifi"]["bulletins"] if (b.get("id"), b.get("timestamp"), b.get("nodeAddress")) not in seen]
            self.bulletins[w["member"]] = keys
        try:
            out["certs"] = self.certificates(w, where, props, boot, proc)
        except Exception as e:  # never the sample's end
            out["certs"] = {"readAt": now_iso(), "stores": [], "error": str(e)[:300]}
        return out

    def round(self, watch):
        """A sample of each watched NiFi."""
        if not watch:
            return []
        procs, host = self.running(), self.host()
        ctx, why_not = self.context()
        samples = []
        for w in watch:
            try:
                samples.append(self.sample(w, procs, host, ctx, why_not))
            except Exception as e:
                samples.append({"service": w["service"], "member": w["member"], "at": now_iso(), "problems": [f"the collector failed: {e}"[:300]]})
        return samples


class ServiceExecutor(ProtocolExecutor):
    """The service executor: the read channel, and executor-upgrade on the change channel."""

    PACKAGE = PACKAGE
    PACKAGE_FILES = PACKAGE_FILES
    MAIN = "service_executor.py"
    EXECUTOR = "service"
    # Read jobs: kind -> method(job) returning the job's result (a dict).
    READ_JOBS = {"svc-discover": "discover", "svc-read": "read_files"}
    # What the read jobs can do beyond their first form, named "<kind>@<n>" in the heartbeat's kinds (§15.2): the
    # Deployer looks for one before it sends a request that needs it. svc-discover@2: dirs entries {install, conf};
    # svc-read@2: confDir (and bootstrapFile), an installation's conf directory kept apart from it (S25).
    CAPABILITIES = ["svc-discover@2", "svc-read@2"]
    # Where discovery looks (tests point these elsewhere; the directories scanned are the configuration's scan_dirs).
    PROC = "/proc"
    AUTOSTART_DIRS = AUTOSTART_DIRS
    INTERRUPTED = "The service executor stopped while this job ran."

    def __init__(self, cfg, out=sys.stdout, api=None):
        super().__init__(cfg, out=out, api=api)
        self.reads = {}  # job id -> thread, for the reads in flight
        self.reads_lock = threading.Lock()
        # The collector (§15.3): what the Deployer watches here (None until a heartbeat reply said), and the samples
        # not yet taken by the Deployer, as (monotonic time, sample).
        self.watch = None
        self.watch_lock = threading.Lock()
        self.backlog = []
        self.backlog_lock = threading.Lock()
        self.stopping = threading.Event()
        self.collector = None

    # --- the collector (§9.1, §15.3) ---

    def on_beat_reply(self, reply):
        """The watch list comes with every heartbeat reply (§15.2 P5): a takeover or a removal counts from the next beat.
        A Deployer that sends none (older than the collector) has nothing watched here."""
        watch = watch_entries(reply.get("watch")) if "watch" in reply else []
        with self.watch_lock:
            changed = watch != self.watch
            self.watch = watch
        if changed:
            self.say(f"collector: watching {len(watch)} NiFi" + (f" ({', '.join(w['service'] for w in watch)})" if watch else ""))

    def make_collector(self):
        name, root = self.user()
        return Collector(self.cfg, proc=self.PROC, uid=None if root else os.geteuid(), log=self.say)

    def collect_once(self):
        """One round: a sample of each watched NiFi into the backlog, then as much of the backlog as the Deployer takes."""
        with self.watch_lock:
            watch = list(self.watch or [])
        if self.collector is None:
            self.collector = self.make_collector()
        samples = self.collector.round(watch)
        now = time.monotonic()
        with self.backlog_lock:
            self.backlog.extend((now, s) for s in samples)
        self.push_samples()
        return samples

    def push_samples(self):
        """The backlog to POST /executor/v1/samples, SAMPLES_PER_POST at a time; what the Deployer cannot take stays,
        but no longer than BACKLOG_SECONDS (and at most MAX_BACKLOG samples), the oldest dropped first."""
        with self.backlog_lock:
            cutoff = time.monotonic() - BACKLOG_SECONDS
            kept = [(t, s) for t, s in self.backlog if t >= cutoff][-MAX_BACKLOG:]
            dropped = len(self.backlog) - len(kept)
            self.backlog = kept
        if dropped:
            self.say(f"collector: dropped {dropped} sample(s) the Deployer did not take in time")
        while True:
            with self.backlog_lock:
                batch = self.backlog[:SAMPLES_PER_POST]
            if not batch:
                return
            try:
                self.api.post_samples([s for _, s in batch])
            except Exception as e:
                self.say(f"collector: cannot send {len(self.backlog)} sample(s) yet: {e}")
                return
            with self.backlog_lock:
                self.backlog = self.backlog[len(batch):]

    def collect_loop(self):
        while not self.stopping.is_set():
            started = time.monotonic()
            try:
                self.collect_once()
            except Exception as e:  # the collector keeps going; the next round tries again
                self.say(f"collector: {e}")
            self.stopping.wait(max(1.0, self.cfg["collect_seconds"] - (time.monotonic() - started)))

    def serve(self):
        # The collector runs beside the job loop, in its own thread with its own time limits; it waits for the first
        # heartbeat reply to know what to watch.
        threading.Thread(target=self.collect_loop, daemon=True, name="collector").start()
        return super().serve()

    @property
    def version(self):
        # The module's VERSION, read each time: tests play a newer release by changing it.
        return VERSION

    @property
    def KINDS(self):
        return [*self.READ_JOBS, *ProtocolExecutor.KINDS, *self.CAPABILITIES]

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
        with self.watch_lock:
            watching = None if self.watch is None else len(self.watch)
        with self.backlog_lock:
            backlog = len(self.backlog)
        # §15.3: what the collector does (never the certificate's paths).
        body["collector"] = {"seconds": self.cfg.get("collect_seconds", COLLECT_DEFAULT), "watching": watching, "backlog": backlog,
                             "certificate": bool(self.cfg.get("nifi_client_cert") and self.cfg.get("nifi_client_key"))}
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
    p.add_argument("command", choices=["serve", "once", "check", "collect"],
                   help="serve: the systemd loop; once: one pass; check: print the configuration; collect: one heartbeat for the watch list, then one collector round printed (not sent)")
    p.add_argument("--env-file", default=os.environ.get("EXECUTOR_ENV_FILE", "/etc/open-atlas-deployer/service-executor.env"))
    a = p.parse_args(argv)
    cfg = config(a.env_file)
    ex = ServiceExecutor(cfg)
    if a.command == "check":
        name, root = ex.user()
        print(json.dumps({**{k: (str(v) if isinstance(v, pathlib.Path) else v) for k, v in cfg.items()}, "user": name, "root": root}, indent=2))
        return 0
    if a.command == "collect":
        ex.heartbeat()
        with ex.watch_lock:
            watch = list(ex.watch or [])
        print(json.dumps(ex.make_collector().round(watch), indent=2))
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
