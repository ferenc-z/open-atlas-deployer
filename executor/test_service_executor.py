"""Unit tests for the service executor (S18): registration without Docker, the read channel, its release.

    python3 -m unittest test_service_executor        (from executor/)
"""
import calendar
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import service_executor as sx  # noqa: E402
from test_deployer_executor import FakeApi, load_module  # noqa: E402

NO_ENV = {"HOME": "/nonexistent"}


def cfg(root, **over):
    c = sx.config(environ={"EXECUTOR_WORK": str(pathlib.Path(root) / "work"), "EXECUTOR_DEPLOYER_URL": "https://deployer.test",
                           "EXECUTOR_TOKEN_FILE": str(pathlib.Path(root) / "token"), "EXECUTOR_READ_SLOTS": "2"})
    c.update(over)
    return c


class Reader(sx.ServiceExecutor):
    """A service executor with read jobs for the tests: each waits for its gate, then answers or fails."""

    READ_JOBS = {"test-read": "test_read"}

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.gates, self.started = {}, []

    def test_read(self, job):
        self.started.append(job.id)
        job.log(f"reading for {job.id}")
        gate = self.gates.setdefault(job.id, threading.Event())
        gate.wait(5)
        if job.request.get("fail"):
            raise sx.Failed("cannot read it")
        if job.request.get("refuse"):
            raise sx.Refused("not a registered path")
        return {"answer": job.id}


def wait_until(check, seconds=5):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.01)
    return False


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "token").write_text("dpe_service\n")
        self.devnull = open(os.devnull, "w")
        self.addCleanup(self.devnull.close)
        self.api = FakeApi()

    def executor(self, cls=sx.ServiceExecutor, **over):
        ex = cls(cfg(self.root, **over), out=self.devnull, api=self.api)
        ex.sleep = lambda s: None
        return ex


class RegistrationTest(Base):
    def test_config_holds_what_the_shared_core_needs(self):
        c = sx.config(environ={})
        for key in ("deployer_url", "executor_token_file", "ca_file", "wait_seconds", "poll_seconds", "work", "base", "upgrade_from", "github_api", "token_file"):
            self.assertIn(key, c)
        self.assertEqual(str(c["base"]), "/opt/open-atlas-deployer/service-executor")
        self.assertEqual(str(c["work"]), "/var/lib/open-atlas-service-executor")

    def test_registers_without_docker_and_says_it_is_the_service_executor(self):
        ex = self.executor()

        def no_commands(*a, **kw):
            raise AssertionError("the service executor runs no command to register (no Docker check)")
        ex.sh = no_commands
        ex.selfcheck()
        beat = self.api.beats[-1]
        self.assertEqual(beat["executor"], "service")
        self.assertEqual(beat["protocols"], [2])
        self.assertEqual(beat["kinds"], ["svc-discover", "svc-read", "log-read", "log-tail", "nifi-provenance", "executor-upgrade", "svc-discover@2", "svc-read@2", "nifi-provenance@1"],
                         "the service jobs and what they can do (§15.2); never the deploy ones")
        name, root = sx.ServiceExecutor.user()
        self.assertEqual((beat["user"], beat["isRoot"]), (name, root))
        self.assertEqual(beat["isRoot"], os.geteuid() == 0)
        self.assertEqual((beat["reading"], beat["readSlots"]), ([], 2))
        self.assertIn("not root" if not root else "service executor", ex.describe())

    def test_deploy_jobs_are_refused(self):
        ex = self.executor()
        for i, kind in enumerate(["build", "deploy", "env", "env-read", "deployer-upgrade", "db-migration"]):
            self.api.queue.append({"protocol": 2, "id": f"{kind}-job-000{i}", "kind": kind, "app": "shop"})
            self.assertTrue(ex.run_once())
            status = self.api.status[f"{kind}-job-000{i}"]
            self.assertEqual(status["state"], "refused")
            self.assertIn(f"unknown job kind {kind}", status["message"])


class ReadChannelTest(Base):
    def setUp(self):
        super().setUp()
        self.ex = self.executor(Reader)
        self.addCleanup(self.release_all)

    def release_all(self):
        for g in self.ex.gates.values():
            g.set()
        for job_id in list(self.ex.reads):
            self.ex.gates.setdefault(job_id, threading.Event()).set()
        self.ex.wait_reads()

    def read(self, job_id, **extra):
        self.api.queue.append({"protocol": 2, "id": job_id, "kind": "test-read", **extra})

    def test_reads_run_side_by_side_up_to_the_slots_and_report_their_results(self):
        for i in range(3):
            self.read(f"read-job-000{i}")
        self.assertTrue(self.ex.run_once())
        self.assertTrue(self.ex.run_once())
        self.assertTrue(wait_until(lambda: len(self.ex.started) == 2), "two reads run at once")
        self.assertEqual(self.api.status["read-job-0000"]["state"], "running")
        self.assertEqual(sorted(self.ex.beat_body(None)["reading"]), ["read-job-0000", "read-job-0001"])
        self.assertFalse(self.ex.run_once(wait=0.1), "both slots taken: the third waits at the Deployer")
        self.assertEqual(len(self.api.queue), 1)
        self.ex.gates["read-job-0000"].set()
        self.assertTrue(self.ex.run_once(wait=2), "a slot came free")
        self.release_all()
        for i in range(3):
            status = self.api.status[f"read-job-000{i}"]
            self.assertEqual((status["state"], status["result"]), ("succeeded", {"answer": f"read-job-000{i}"}))
            self.assertIn(f"reading for read-job-000{i}", self.api.logs[f"read-job-000{i}"])
        self.assertEqual(list((self.root / "work" / "reading").glob("*.json")), [], "no markers left")

    def test_a_read_that_runs_over_its_time_is_reported_failed(self):
        self.read("read-job-slow", timeoutSeconds=0.2)
        self.ex.run_once()
        self.assertTrue(wait_until(lambda: self.api.status.get("read-job-slow", {}).get("state") == "failed"))
        self.assertEqual(self.api.status["read-job-slow"]["message"], "timed out after 0.2 seconds")
        self.ex.gates["read-job-slow"].set()
        time.sleep(0.05)
        self.assertEqual(self.api.status["read-job-slow"]["state"], "failed", "the late result is dropped")

    def test_the_timeout_is_capped_by_the_hosts_setting(self):
        self.ex.cfg["read_timeout"] = 30
        self.assertEqual(self.ex.read_timeout({"timeoutSeconds": 3600}), 30)
        self.assertEqual(self.ex.read_timeout({}), 30)
        self.assertEqual(self.ex.read_timeout({"timeoutSeconds": 5}), 5)

    def test_failed_and_refused_reads(self):
        self.read("read-job-fail", fail=True)
        self.read("read-job-refuse", refuse=True)
        self.ex.run_once()
        self.ex.run_once()
        self.release_all()
        self.assertEqual((self.api.status["read-job-fail"]["state"], self.api.status["read-job-fail"]["message"]), ("failed", "cannot read it"))
        self.assertEqual(self.api.status["read-job-refuse"]["state"], "refused")

    def test_a_change_waits_for_the_reads_in_flight(self):
        self.read("read-job-0001")
        self.ex.run_once()
        self.assertTrue(wait_until(lambda: self.ex.started))
        self.api.queue.append({"protocol": 2, "id": "change-job-0001", "kind": "svc-write"})
        done = threading.Thread(target=self.ex.run_once)
        done.start()
        time.sleep(0.1)
        self.assertNotIn("change-job-0001", self.api.status, "not started while the read runs")
        self.ex.gates["read-job-0001"].set()
        done.join(5)
        self.assertEqual(self.api.status["read-job-0001"]["state"], "succeeded")
        self.assertEqual(self.api.status["change-job-0001"]["state"], "refused", "svc-write is not on this executor yet")

    def test_a_read_left_running_by_a_previous_process_is_marked_interrupted(self):
        sx.write_json(self.ex.read_marker("read-job-gone"), {"protocol": 2, "id": "read-job-gone", "state": "running", "steps": [], "result": {}})
        self.ex.recover()
        self.assertEqual(self.api.status["read-job-gone"]["state"], "failed")
        self.assertIn("stopped while this job ran", self.api.status["read-job-gone"]["message"])
        self.assertFalse(self.ex.read_marker("read-job-gone").exists())

    def test_a_status_the_deployer_cannot_take_is_kept_and_sent_later(self):
        self.read("read-job-down")
        self.ex.run_once()
        self.assertTrue(wait_until(lambda: self.ex.started))
        self.api.down = True
        self.ex.gates["read-job-down"].set()
        self.ex.wait_reads()
        self.assertEqual(self.api.status["read-job-down"]["state"], "running")
        self.api.down = False
        self.ex.deliver_pending()
        self.assertEqual(self.api.status["read-job-down"]["state"], "succeeded")
        self.assertIn("reading for read-job-down", self.api.logs["read-job-down"])


def nifi_home(root, name, version, props, boot=None, two=True):
    """An unpacked NiFi as the lab has them: lib/ with the runtime jar, conf/ with its files, bin/nifi.sh."""
    home = pathlib.Path(root) / name
    (home / "lib" / "bootstrap").mkdir(parents=True)
    (home / "conf").mkdir()
    (home / "bin").mkdir()
    (home / "bin" / "nifi.sh").write_text("#!/bin/sh\n")
    (home / "lib" / f"nifi-runtime-{version}.jar").write_text("")
    # 2.5.0 ships nifi-api 2.2.0: the version comes from the runtime jar, not the API's.
    (home / "lib" / ("nifi-api-2.2.0.jar" if two else f"nifi-api-{version}.jar")).write_text("")
    (home / "conf" / "nifi.properties").write_text("# NiFi\n" + "".join(f"{k}={v}\n" for k, v in props.items()))
    (home / "conf" / "bootstrap.conf").write_text("".join(f"{k}={v}\n" for k, v in (boot or {}).items()))
    (home / "conf" / "logback.xml").write_text("<configuration/>\n")
    return home


class FakeProc:
    """A /proc with the processes the tests need: cmdline, environ, status, stat, cwd/exe links, sockets."""

    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True)
        (self.root / "stat").write_text("cpu  1 2 3\nbtime 1700000000\n")
        (self.root / "self").mkdir()  # not a pid

    def add(self, pid, args, uid=None, ppid=1, env=None, cwd="/", exe="/usr/bin/java", listen=()):
        d = self.root / str(pid)
        (d / "fd").mkdir(parents=True)
        (d / "net").mkdir()
        (d / "cmdline").write_bytes(b"\0".join(a.encode() for a in args) + b"\0")
        (d / "environ").write_bytes(b"\0".join(f"{k}={v}".encode() for k, v in (env or {}).items()) + b"\0")
        uid = os.geteuid() if uid is None else uid
        (d / "status").write_text(f"Name:\tjava\nPPid:\t{ppid}\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n")
        (d / "stat").write_text(f"{pid} (java) S {ppid} " + " ".join(["0"] * 17) + " 250 0 0\n")
        os.symlink(cwd, d / "cwd")
        os.symlink(exe, d / "exe")
        rows = ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"]
        for i, port in enumerate(listen):
            inode = str(9000 + pid % 1000 * 10 + i)
            os.symlink(f"socket:[{inode}]", d / "fd" / str(10 + i))
            rows.append(f"   {i}: 0100007F:{port:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  {uid}        0 {inode} 1")
        # A connection (not listening) and a socket of another process: neither counts.
        rows.append(f"   9: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  {uid}        0 {9000 + pid % 1000 * 10} 1")
        rows.append(f"  10: 0100007F:2222 00000000:0000 0A 00000000:00000000 00:00000000 00000000  {uid}        0 1 1")
        (d / "net" / "tcp").write_text("\n".join(rows) + "\n")
        os.symlink("pipe:[5]", d / "fd" / "1")


def lab_processes(proc, home, two=True, env=None, uid=None, base=4000, listen=()):
    """A NiFi's two processes as nifi.sh leaves them: the bootstrap, and the NiFi JVM it started."""
    boot_main = "org.apache.nifi.bootstrap.BootstrapProcess" if two else "org.apache.nifi.bootstrap.RunNiFi"
    proc.add(base, ["java", "-cp", f"{home}/conf:{home}/lib/bootstrap/*", f"-Dorg.apache.nifi.bootstrap.config.file={home}/conf/bootstrap.conf", boot_main, "start"],
             uid=uid, env=env, cwd=str(home))
    proc.add(base + 1, ["java", "-classpath", f"{home}/./lib/nifi-runtime.jar", f"-Dnifi.properties.file.path={home}/./conf/nifi.properties", "-Xmx1g", "org.apache.nifi.NiFi"],
             uid=uid, ppid=base, env=env, cwd=str(home), exe="/jdk/21/bin/java", listen=listen)


@unittest.skipUnless(hasattr(os, "geteuid") and hasattr(os, "symlink"), "needs a POSIX system")
class DiscoverTest(Base):
    def setUp(self):
        super().setUp()
        self.proc = FakeProc(self.root / "proc")
        self.lab = self.root / "lab"
        cluster = {"nifi.cluster.is.node": "true", "nifi.cluster.node.address": "node1.lab", "nifi.cluster.node.protocol.port": "11445",
                   "nifi.cluster.load.balance.port": "16345", "nifi.zookeeper.connect.string": "127.0.0.1:12181", "nifi.zookeeper.root.node": "/nifi-lab-c250"}
        self.c250 = nifi_home(self.lab, "c250-1", "2.5.0", {
            "nifi.web.https.host": "localhost", "nifi.web.https.port": "18445", "nifi.web.http.port": "",
            "nifi.sensitive.props.key": "a-real-secret", "nifi.security.keystorePasswd": "kspw", "nifi.security.keystore": "./conf/keystore.p12",
            "nifi.security.truststorePasswd": "", **cluster},
            boot={"java.arg.2": "-Xms1g", "java.arg.3": "-Xmx1g", "management.server.address": "http://127.0.0.1:52445"})
        self.n112 = nifi_home(self.lab, "n112", "1.12.1", {"nifi.web.https.port": "18443", "nifi.cluster.is.node": "false", "nifi.cluster.load.balance.port": "6342"},
                              boot={"java": "java", "java.arg.3": "-Xmx512m"}, two=False)
        self.stopped = nifi_home(self.lab, "n200", "2.0.0", {"nifi.web.https.port": "18444"})
        env = {"JAVA_HOME": "/jdk/21", "PATH": "/jdk/21/bin:/usr/bin", "NIFI_HOME": str(self.c250), "AWS_SECRET_ACCESS_KEY": "abc", "DB_PASSWORD": "x", "EMPTY_TOKEN": ""}
        lab_processes(self.proc, self.c250, env=env, listen=(18445, 11445, 16345))
        lab_processes(self.proc, self.n112, two=False, env={"JAVA_HOME": "/jdk/11"}, base=5000, listen=(18443,))
        # Someone else's NiFi: not looked at when the executor is not root.
        lab_processes(self.proc, self.lab / "other", uid=os.geteuid() + 1, base=6000)
        # Not NiFi at all.
        self.proc.add(7000, ["python3", "-m", "http.server"])

    def discovery(self, **kw):
        return sx.Discovery(self.proc.root, uid=os.geteuid(), common=(), **kw)

    def by_dir(self, result):
        return {pathlib.Path(i["installDir"]).name: i for i in result["instances"]}

    def test_finds_the_running_instances_from_their_processes(self):
        r = self.discovery().run()
        found = self.by_dir(r)
        self.assertEqual(sorted(found), ["c250-1", "n112"])
        c = found["c250-1"]
        self.assertEqual((c["installDir"], c["source"], c["running"], c["version"]), (str(self.c250), "process", True, "2.5.0"))
        self.assertEqual((c["process"]["pid"], c["process"]["bootstrapPid"], c["process"]["java"]), (4001, 4000, "/jdk/21/bin/java"))
        self.assertEqual(c["process"]["listening"], [11445, 16345, 18445])
        self.assertRegex(c["process"]["startedAt"], r"^2023-11-14T22:13:2\dZ$")
        me = sx.user_name(os.geteuid())
        self.assertEqual((c["serviceUser"], c["owner"]), (me, me))
        self.assertEqual(c["ports"], {"https": 18445, "http": None, "clusterProtocol": 11445, "loadBalance": 16345, "remoteInput": None, "management": 52445})
        self.assertEqual(c["webUrl"], "https://localhost:18445/nifi")
        self.assertEqual(c["cluster"], {"isNode": True, "nodeAddress": "node1.lab", "zookeeper": "127.0.0.1:12181", "zookeeperRoot": "/nifi-lab-c250"})
        self.assertEqual((c["heap"], c["javaHome"]), ({"Xms": "1g", "Xmx": "1g"}, "/jdk/21"))
        self.assertEqual(c["problems"], [])
        n = found["n112"]
        self.assertEqual((n["version"], n["ports"]["https"], n["ports"]["loadBalance"], n["cluster"]["isNode"]), ("1.12.1", 18443, None, False),
                         "1.x by RunNiFi; a standalone's cluster ports do not count")
        self.assertEqual(n["heap"], {"Xms": None, "Xmx": "512m"})
        self.assertEqual(r["skipped"], [{"pid": 6000, "user": sx.user_name(os.geteuid() + 1)}, {"pid": 6001, "user": sx.user_name(os.geteuid() + 1)}])

    def test_the_start_environment_and_properties_keep_no_secrets(self):
        c = self.by_dir(self.discovery().run())["c250-1"]
        env = c["startEnvironment"]
        self.assertEqual((env["JAVA_HOME"], env["PATH"], env["NIFI_HOME"]), ("/jdk/21", "/jdk/21/bin:/usr/bin", str(self.c250)))
        self.assertEqual((env["AWS_SECRET_ACCESS_KEY"], env["DB_PASSWORD"], env["EMPTY_TOKEN"]), ("(hidden)", "(hidden)", ""))
        p = c["properties"]
        self.assertEqual((p["nifi.sensitive.props.key"], p["nifi.security.keystorePasswd"]), ("(hidden)", "(hidden)"))
        self.assertEqual(p["nifi.security.truststorePasswd"], "", "an empty secret shows it is empty")
        self.assertEqual(p["nifi.security.keystore"], "./conf/keystore.p12")
        self.assertNotIn("a-real-secret", json.dumps(c))

    def test_fingerprints_the_configuration_files(self):
        c = self.by_dir(self.discovery().run())["c250-1"]
        files = {f["name"]: f for f in c["files"]}
        self.assertEqual(sorted(files), ["bootstrap.conf", "logback.xml", "nifi.properties"])
        import hashlib
        props = self.c250 / "conf" / "nifi.properties"
        self.assertEqual(files["nifi.properties"]["sha256"], hashlib.sha256(props.read_bytes()).hexdigest())
        self.assertEqual((files["nifi.properties"]["path"], files["nifi.properties"]["size"]), (str(props), props.stat().st_size))

    def test_an_installation_not_running_is_read_from_the_directory_asked(self):
        r = self.discovery().run([str(self.stopped), str(self.c250) + "/", str(self.lab), str(self.lab / "missing")])
        s = self.by_dir(r)["n200"]
        self.assertEqual((s["source"], s["running"], s["version"], s["process"], s["startEnvironment"]), ("dir", False, "2.0.0", None, None))
        self.assertEqual((s["ports"]["https"], s["serviceUser"]), (18444, s["owner"]))
        self.assertEqual([(d["found"], d.get("running")) for d in r["dirs"]], [(True, False), (True, True), (False, None), (False, None)])
        self.assertIn("not a NiFi installation", r["dirs"][2]["error"])
        self.assertIn("no such directory", r["dirs"][3]["error"])
        self.assertEqual(len(r["instances"]), 3, "an asked directory that runs is not listed twice")

    def test_common_directories_are_looked_at(self):
        r = sx.Discovery(self.proc.root, uid=os.geteuid(), common=(str(self.lab / "n2*"),)).run()
        self.assertEqual(self.by_dir(r)["n200"]["source"], "common-dir")

    def test_as_root_every_users_processes_count(self):
        found = self.by_dir(sx.Discovery(self.proc.root, uid=None, common=()).run())
        self.assertEqual(sorted(found), ["c250-1", "n112", "other"])
        self.assertEqual(found["other"]["serviceUser"], sx.user_name(os.geteuid() + 1))
        self.assertIn("cannot read", " ".join(found["other"]["problems"]), "the other installation does not exist here")

    def test_the_job_on_the_read_channel(self):
        ex = self.executor()
        ex.PROC, ex.cfg["scan_dirs"] = str(self.proc.root), ()
        self.api.queue.append({"protocol": 2, "id": "svc-discover-0001", "kind": "svc-discover", "dirs": [str(self.stopped)]})
        self.api.queue.append({"protocol": 2, "id": "svc-discover-0002", "kind": "svc-discover", "dirs": ["relative/dir"]})
        ex.run_once()
        ex.run_once()
        ex.wait_reads()
        status = self.api.status["svc-discover-0001"]
        self.assertEqual(status["state"], "succeeded", status.get("message"))
        self.assertEqual(len(status["result"]["instances"]), 3 + (os.geteuid() == 0))
        self.assertEqual((status["result"]["user"], status["result"]["isRoot"]), sx.ServiceExecutor.user())
        self.assertIn("found 3 NiFi", self.api.logs["svc-discover-0001"])
        self.assertEqual(self.api.status["svc-discover-0002"]["state"], "refused")

    def test_properties_files(self):
        f = self.root / "x.properties"
        f.write_text("# c\n! c\na=1\nb = two words \nc:3\nd=\nlong=x\\\n   y\n")
        self.assertEqual(sx.read_properties(f), {"a": "1", "b": "two words", "c": "3", "d": "", "long": "xy"})
        self.assertEqual([sx.as_port(v) for v in ("8443", "http://127.0.0.1:52020", "", "x", "70000")], [8443, 52020, None, None, None])

    def test_secrets_are_fingerprinted_with_the_deployers_key(self):
        key = "k" * 32
        c = self.by_dir(self.discovery(fingerprint_key=key).run())["c250-1"]
        fp = c["fingerprints"]["nifi.properties"]
        self.assertEqual(sorted(fp), ["nifi.security.keystorePasswd", "nifi.sensitive.props.key"], "only the hidden values; an empty one is not")
        self.assertEqual(fp["nifi.sensitive.props.key"], sx.secret_fingerprints({"nifi.sensitive.props.key": "a-real-secret"}, key)["nifi.sensitive.props.key"])
        self.assertNotEqual(fp["nifi.sensitive.props.key"], sx.secret_fingerprints({"nifi.sensitive.props.key": "a-real-secret"}, "x" * 32)["nifi.sensitive.props.key"])
        self.assertNotIn("a-real-secret", json.dumps(c))
        self.assertNotIn("fingerprints", self.by_dir(self.discovery().run())["c250-1"], "no key, no fingerprints")

    def test_storage_and_autostart(self):
        units = self.root / "units"
        units.mkdir()
        (units / "nifi-c250.service").write_text(f"[Service]\nExecStart={self.c250}/bin/nifi.sh start\n")
        (units / "other.service").write_text("[Service]\nExecStart=/bin/true\n")
        found = self.by_dir(self.discovery(autostart=(str(units), str(self.root / "missing"))).run())
        c = found["c250-1"]
        self.assertEqual(c["autostart"], [str(units / "nifi-c250.service")])
        self.assertEqual(found["n112"]["autostart"], [])
        self.assertEqual(c["storage"]["content"]["path"], str(self.c250 / "content_repository"))
        self.assertEqual(c["storage"]["content"]["device"], self.c250.stat().st_dev, "a directory not there yet counts where it would be made")
        self.assertEqual(c["storage"]["logs"]["path"], str(self.c250 / "logs"))

    def test_svc_read_sends_the_files_once_over_the_content_channel(self):
        ex = self.executor()
        self.api.queue.append({"protocol": 2, "id": "svc-read-0001", "kind": "svc-read", "installDir": str(self.c250), "files": ["nifi.properties", "authorizers.xml"]})
        self.api.queue.append({"protocol": 2, "id": "svc-read-0002", "kind": "svc-read", "installDir": str(self.c250)})
        self.api.queue.append({"protocol": 2, "id": "svc-read-0003", "kind": "svc-read", "installDir": str(self.c250), "files": ["../../etc/passwd"]})
        self.api.queue.append({"protocol": 2, "id": "svc-read-0004", "kind": "svc-read", "installDir": str(self.lab)})
        for _ in range(4):
            ex.run_once()
        ex.wait_reads()
        s = self.api.status["svc-read-0001"]
        self.assertEqual(s["state"], "succeeded", s.get("message"))
        self.assertEqual(([f["name"] for f in s["result"]["files"]], s["result"]["missing"]), (["nifi.properties"], ["authorizers.xml"]))
        self.assertNotIn("a-real-secret", json.dumps(s), "the status has no content")
        sent = json.loads(self.api.env["svc-read-0001"])
        import base64
        import hashlib
        body = base64.b64decode(sent["files"][0]["content"])
        self.assertIn(b"nifi.sensitive.props.key=a-real-secret", body)
        self.assertEqual(sent["files"][0]["sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(sorted(f["name"] for f in self.api.status["svc-read-0002"]["result"]["files"]), ["bootstrap.conf", "logback.xml", "nifi.properties"])
        self.assertEqual(self.api.status["svc-read-0003"]["state"], "refused", "only the configuration files by name")
        self.assertEqual(self.api.status["svc-read-0004"]["state"], "refused", "not a NiFi installation")


def split_home(root, install, conf, version, props, conf_dir_value=None, data=None):
    """An installation with its configuration elsewhere, the official way: bootstrap.conf stays in <install>/conf (where
    nifi.sh reads it) and its conf.dir names the conf directory; the repositories go to `data`."""
    home = pathlib.Path(root) / install
    (home / "lib" / "bootstrap").mkdir(parents=True)
    (home / "bin").mkdir()
    (home / "conf").mkdir()
    (home / "bin" / "nifi.sh").write_text("#!/bin/sh\n")
    (home / "lib" / f"nifi-runtime-{version}.jar").write_text("")
    conf = pathlib.Path(root) / conf
    conf.mkdir(parents=True)
    if data:
        props = {**props, "nifi.content.repository.directory.default": f"{data}/content_repository", "nifi.flowfile.repository.directory": f"{data}/flowfile_repository"}
    (conf / "nifi.properties").write_text("".join(f"{k}={v}\n" for k, v in props.items()))
    (conf / "logback.xml").write_text("<configuration/>\n")
    (conf / "authorizers.xml").write_text("<authorizers/>\n")
    lines = "java.arg.3=-Xmx2g\n" + (f"conf.dir={conf_dir_value}\n" if conf_dir_value is not None else "")
    (home / "conf" / "bootstrap.conf").write_text(lines)
    return home, conf


@unittest.skipUnless(hasattr(os, "geteuid") and hasattr(os, "symlink"), "needs a POSIX system")
class SplitLayoutTest(Base):
    """The installation (bin/, lib/), its conf directory and its repositories in three places (/webapp/install,
    /webapp/deploy/nifi/conf, /data): found running and not."""

    def setUp(self):
        super().setUp()
        self.proc = FakeProc(self.root / "proc")
        self.w = self.root / "webapp"
        self.data = self.root / "data"
        self.home, self.conf = split_home(self.w, "install", "deploy/nifi/conf", "2.5.0", {"nifi.web.https.port": "18447"},
                                          conf_dir_value=str(self.w / "deploy/nifi/conf"), data=self.data)

    def discovery(self, common=()):
        return sx.Discovery(self.proc.root, uid=os.geteuid(), common=common)

    def start(self, home, conf, base, cwd=None, jvm_conf=True):
        """nifi.sh's two processes: the bootstrap reads <install>/conf/bootstrap.conf; the JVM gets the conf directory."""
        proc = self.proc
        proc.add(base, ["java", "-cp", f"{home}/conf:{home}/lib/bootstrap/*", f"-Dorg.apache.nifi.bootstrap.config.file={home}/conf/bootstrap.conf",
                        "org.apache.nifi.bootstrap.BootstrapProcess", "start"], cwd=str(cwd or home))
        if jvm_conf:
            proc.add(base + 1, ["java", "--class-path", f"{conf}:{home}/./lib/nifi-runtime-2.5.0.jar:{home}/./lib/nifi-api.jar",
                                f"-Dnifi.properties.file.path={conf}/nifi.properties", "org.apache.nifi.NiFi"], ppid=base, cwd=str(cwd or home), listen=(18447,))

    def test_a_running_instance_with_its_conf_elsewhere(self):
        self.start(self.home, self.conf, 4000, cwd="/")
        r = self.discovery().run()
        self.assertEqual(len(r["instances"]), 1)
        i = r["instances"][0]
        self.assertEqual((i["installDir"], i["confDir"], i["version"], i["running"]), (str(self.home), str(self.conf), "2.5.0", True),
                         "the installation from the class path's lib/, not above nifi.properties or the working directory")
        self.assertEqual((i["process"]["pid"], i["process"]["bootstrapPid"], i["ports"]["https"], i["heap"]["Xmx"]), (4001, 4000, 18447, "2g"))
        files = {f["name"]: f["path"] for f in i["files"]}
        self.assertEqual(files, {"nifi.properties": str(self.conf / "nifi.properties"), "bootstrap.conf": str(self.home / "conf/bootstrap.conf"),
                                 "logback.xml": str(self.conf / "logback.xml"), "authorizers.xml": str(self.conf / "authorizers.xml")})
        self.assertEqual(i["storage"]["content"]["path"], str(self.data / "content_repository"))
        self.assertEqual(i["problems"], [])

    def test_the_bootstrap_alone_reads_conf_dir_and_the_working_directory_comes_second(self):
        # The JVM not up yet: only the bootstrap, whose bootstrap.conf says where the conf directory is.
        self.start(self.home, self.conf, 4000, jvm_conf=False)
        i = self.discovery().run()["instances"][0]
        self.assertEqual((i["installDir"], i["confDir"], i["running"]), (str(self.home), str(self.conf), False))
        d = sx.Discovery(self.proc.root)
        jvm = ["java", f"-Dnifi.properties.file.path={self.conf}/nifi.properties", "org.apache.nifi.NiFi"]
        self.proc.add(4500, jvm, cwd=str(self.home))
        self.assertEqual(d.layout_of({"pid": 4500, "args": jvm}, None)["installDir"], str(self.home), "no class path: the working directory")
        self.assertEqual(d.layout_of({"pid": 99999, "args": jvm}, None)["installDir"], str(self.conf.parent), "last: above the conf directory")
        self.assertEqual(d.install_from_classpath(["java", "-cp", "/var/lib/nifi/conf:/var/lib/nifi/lib/bootstrap/*"]), "/var/lib/nifi",
                         "a conf directory under /var/lib does not count, the jars' lib/ does")

    def test_two_instances_of_one_installation(self):
        _, other = split_home(self.root / "x", "unused", "deploy/b/conf", "2.5.0", {"nifi.web.https.port": "18448"})
        self.start(self.home, self.conf, 4000)
        self.start(self.home, other, 4100)
        r = self.discovery().run()
        self.assertEqual(sorted((i["installDir"], i["confDir"]) for i in r["instances"]), sorted([(str(self.home), str(other)), (str(self.home), str(self.conf))]))

    def test_not_running_found_from_the_installation_asked(self):
        r = self.discovery().run([str(self.home)])
        i = r["instances"][0]
        self.assertEqual((i["installDir"], i["confDir"], i["source"], i["version"], i["ports"]["https"]), (str(self.home), str(self.conf), "dir", "2.5.0", 18447),
                         "conf.dir in <install>/conf/bootstrap.conf says where the conf directory is")
        self.assertEqual(r["dirs"], [{"dir": str(self.home), "found": True, "running": False}])

    def test_conf_dir_relative_to_the_installation(self):
        home, conf = split_home(self.root / "rel", "install", "deploy/c/conf", "1.12.1", {"nifi.web.https.port": "18449"}, conf_dir_value="../deploy/c/conf")
        i = self.discovery().run([str(home)])["instances"][0]
        self.assertEqual((i["confDir"], i["version"]), (str(conf), "1.12.1"))

    def test_the_conf_directory_given_with_the_installation(self):
        home, conf = split_home(self.root / "given", "install", "deploy/d/conf", "2.0.0", {"nifi.web.https.port": "18450"})
        r = self.discovery().run([str(home), {"install": str(home), "conf": str(conf)}, {"install": str(home), "conf": str(self.root / "nowhere")}, str(conf.parent)])
        self.assertEqual(sorted(i["confDir"] for i in r["instances"]), sorted([str(home / "conf"), str(conf)]), "without conf.dir, <install>/conf; given, the one given")
        given = next(i for i in r["instances"] if i["confDir"] == str(conf))
        self.assertEqual((given["ports"]["https"], given["files"][0]["path"]), (18450, str(conf / "nifi.properties")))
        self.assertEqual([d["found"] for d in r["dirs"]], [True, True, False, False])
        self.assertEqual(r["dirs"][1]["conf"], str(conf))
        self.assertIn("no nifi.properties", r["dirs"][2]["error"])
        self.assertIn("give the installation directory", r["dirs"][3]["error"], "the parent of a conf directory is not an installation")

    def test_scanned_directories_follow_conf_dir(self):
        r = self.discovery(common=(str(self.w / "inst*"),)).run()
        self.assertEqual([(i["installDir"], i["confDir"], i["source"]) for i in r["instances"]], [(str(self.home), str(self.conf), "common-dir")])

    def test_the_directories_scanned_are_configurable(self):
        self.assertEqual(cfg(self.root)["scan_dirs"], sx.COMMON_DIRS)
        self.assertEqual(sx.config(environ={"EXECUTOR_SCAN_DIRS": "/webapp/install*, /data/nifi-*  /opt/nifi*"})["scan_dirs"], ("/webapp/install*", "/data/nifi-*", "/opt/nifi*"))
        self.assertEqual(sx.config(environ={"EXECUTOR_SCAN_DIRS": ""})["scan_dirs"], ())
        ex = self.executor(scan_dirs=(str(self.w / "inst*"),))
        ex.PROC = str(self.proc.root)
        self.api.queue.append({"protocol": 2, "id": "svc-discover-0001", "kind": "svc-discover"})
        self.api.queue.append({"protocol": 2, "id": "svc-discover-0002", "kind": "svc-discover", "dirs": [{"install": "relative", "conf": "/x"}]})
        self.api.queue.append({"protocol": 2, "id": "svc-discover-0003", "kind": "svc-discover", "dirs": [{"install": "/x", "other": "/y"}]})
        for _ in range(3):
            ex.run_once()
        ex.wait_reads()
        s = self.api.status["svc-discover-0001"]
        self.assertEqual(s["state"], "succeeded", s.get("message"))
        self.assertEqual([i["confDir"] for i in s["result"]["instances"]], [str(self.conf)])
        self.assertEqual((self.api.status["svc-discover-0002"]["state"], self.api.status["svc-discover-0003"]["state"]), ("refused", "refused"))

    def test_svc_read_reads_where_discovery_fingerprinted(self):
        ex = self.executor()
        boot = str(self.home / "conf/bootstrap.conf")
        self.api.queue.append({"protocol": 2, "id": "svc-read-0001", "kind": "svc-read", "installDir": str(self.home), "confDir": str(self.conf), "bootstrapFile": boot})
        self.api.queue.append({"protocol": 2, "id": "svc-read-0002", "kind": "svc-read", "installDir": str(self.home)})
        self.api.queue.append({"protocol": 2, "id": "svc-read-0003", "kind": "svc-read", "installDir": str(self.home), "confDir": str(self.root)})
        self.api.queue.append({"protocol": 2, "id": "svc-read-0004", "kind": "svc-read", "installDir": str(self.home), "bootstrapFile": "/etc/passwd"})
        for _ in range(4):
            ex.run_once()
        ex.wait_reads()
        found = {f["name"]: f for f in self.discovery().run([str(self.home)])["instances"][0]["files"]}
        for job in ("svc-read-0001", "svc-read-0002"):
            s = self.api.status[job]
            self.assertEqual(s["state"], "succeeded", s.get("message"))
            self.assertEqual(s["result"]["confDir"], str(self.conf))
            self.assertEqual({f["name"]: (f["path"], f["sha256"]) for f in s["result"]["files"]}, {n: (f["path"], f["sha256"]) for n, f in found.items()})
        self.assertEqual(json.loads(self.api.env["svc-read-0001"])["confDir"], str(self.conf))
        self.assertEqual((self.api.status["svc-read-0003"]["state"], self.api.status["svc-read-0004"]["state"]), ("refused", "refused"))


# --- the collector (§15.3) ---------------------------------------------------------------------------------------

# The lab's REST answers and keytool listings, recorded with the monitor certificate (node ids replaced).
NIFI_DATA = HERE / "testdata" / "nifi"
# port -> the version whose recorded answers it gives.
LAB_PORTS = {18443: "1.12.1", 18444: "2.0.0", 18445: "2.5.0-cluster"}
REST_FILES = {"flow/about": "about", "system-diagnostics": "system-diagnostics", "system-diagnostics?nodewise=true": "system-diagnostics-nodewise",
              "flow/status": "flow-status", "controller/cluster": "controller-cluster", f"flow/bulletin-board?limit={sx.BULLETINS}": "bulletin-board",
              "flow/process-groups/root/status?recursive=true": "root-status"}


def recorded(version, path):
    """(HTTP status, body) as the lab answered; a standalone's /controller/cluster is a 404 in text."""
    name = REST_FILES[path]
    for ext, status in (("json", 200), ("txt", 404)):
        f = NIFI_DATA / f"{version}-{name}.{ext}"
        if f.is_file():
            return status, f.read_bytes()
    raise AssertionError(f"nothing recorded for {version} {path}")


class LabCollector(sx.Collector):
    """The collector against the recorded answers: ports not in down answer as a lab NiFi, keytool lists the recordings."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.calls, self.down, self.hang, self.keytool_runs = [], set(), set(), []

    def context(self):
        return "ctx", None

    def fetch(self, ctx, connect, port, sni, path, timeout):
        self.calls.append((connect, port, sni, path, timeout))
        if port in self.down:
            raise ConnectionRefusedError(111, "Connection refused")
        if port in self.hang:
            raise TimeoutError("timed out")
        return recorded(LAB_PORTS[port], path)

    def run_keytool(self, keytool, path, store_type, password):
        self.keytool_runs.append((keytool, path, store_type, password))
        if password == "wrong":
            return 1, (NIFI_DATA / "keytool-wrong-password.txt").read_text()
        name = "1.12.1-keytool-truststore-jks.txt" if store_type == "JKS" else "2.0.0-keytool-keystore-pkcs12.txt"
        return 0, (NIFI_DATA / name).read_text()


class WatchApi(FakeApi):
    """The Deployer's heartbeat reply with a watch list, and the samples it took."""

    def __init__(self):
        super().__init__()
        self.watch, self.samples, self.posts = None, [], []

    def heartbeat(self, beat):
        reply = super().heartbeat(beat)
        return {**reply, **({"watch": self.watch} if self.watch is not None else {})}

    def post_samples(self, samples):
        if self.down:
            raise sx.Failed("cannot reach the Deployer")
        self.posts.append(len(samples))
        self.samples.extend(samples)


class RestTrimTest(unittest.TestCase):
    def test_what_each_version_answers_is_cut_to_what_the_deployer_keeps(self):
        for version, want in (("1.12.1", "1.12.1"), ("2.0.0", "2.0.0"), ("2.5.0-cluster", "2.5.0")):
            about = sx.trim_about(json.loads(recorded(version, "flow/about")[1]))
            self.assertEqual(about["version"], want)
            d = sx.trim_diagnostics(json.loads(recorded(version, "system-diagnostics")[1]))["aggregate"]
            self.assertEqual(d["version"], want)
            self.assertGreater(d["heap"]["usedBytes"], 0)
            self.assertGreater(d["heap"]["maxBytes"], d["heap"]["usedBytes"])
            self.assertGreater(d["totalThreads"], 0)
            self.assertTrue(d["gc"] and all(set(g) == {"name", "count", "millis"} for g in d["gc"]))
            self.assertEqual(sorted(d["repositories"]), ["content", "flowfile", "provenance"])
            self.assertGreater(d["repositories"]["content"][0]["totalSpaceBytes"], 0)
            status = sx.trim_status(json.loads(recorded(version, "flow/status")[1]))
            self.assertEqual((status["flowFilesQueued"], status["bytesQueued"]), (0, 0))
            self.assertNotIn("queued", status, "only numbers")
        nodes = sx.trim_diagnostics(json.loads(recorded("2.5.0-cluster", "system-diagnostics?nodewise=true")[1]))["nodes"]
        self.assertEqual([(n["address"], n["apiPort"]) for n in nodes], [("localhost", 18445), ("localhost", 18446)])
        self.assertTrue(all(n["heap"]["maxBytes"] == 1 << 30 for n in nodes), "each node's own heap, not the sum")
        cluster = sx.trim_cluster(json.loads(recorded("2.5.0-cluster", "controller/cluster")[1]))
        self.assertEqual([(n["apiPort"], n["status"], n["roles"]) for n in cluster["nodes"]],
                         [(18445, "CONNECTED", ["Primary Node", "Cluster Coordinator"]), (18446, "CONNECTED", [])])
        self.assertTrue(cluster["nodes"][0]["events"][0]["message"].startswith("Received first heartbeat"))
        bulletins = sx.trim_bulletins(json.loads(recorded("2.5.0-cluster", f"flow/bulletin-board?limit={sx.BULLETINS}")[1]))
        self.assertEqual([(b["id"], b["level"], b["nodeAddress"]) for b in bulletins], [(0, "INFO", "localhost:18445"), (1, "INFO", "localhost:18445"), (2, "INFO", "localhost:18445")])
        self.assertIn("elected Active Cluster Coordinator", bulletins[0]["message"])
        self.assertEqual(sx.trim_bulletins(json.loads(recorded("1.12.1", f"flow/bulletin-board?limit={sx.BULLETINS}")[1])), [])
        for version in ("1.12.1", "2.0.0", "2.5.0-cluster"):
            self.assertEqual(sx.trim_backpressure(json.loads(recorded(version, "flow/process-groups/root/status?recursive=true")[1])),
                             {"connections": 0, "full": 0, "maxPercent": 0, "top": []}, "the lab's flows are empty")

    def test_back_pressure_of_nested_groups(self):
        conn = lambda i, count, size: {"connectionStatusSnapshot": {"id": i, "name": f"c{i}", "sourceName": "a", "destinationName": "b", "percentUseCount": count, "percentUseBytes": size, "flowFilesQueued": count * 100, "bytesQueued": 1, "queued": "text"}}
        tree = {"processGroupStatus": {"aggregateSnapshot": {"name": "root", "connectionStatusSnapshots": [conn(1, 10, 0)], "processGroupStatusSnapshots": [
            {"processGroupStatusSnapshot": {"name": "ingest", "connectionStatusSnapshots": [conn(2, 100, 5), conn(3, 0, 0)], "processGroupStatusSnapshots": [
                {"processGroupStatusSnapshot": {"name": "deep", "connectionStatusSnapshots": [conn(4, 20, 100)]}}]}}]}}}
        bp = sx.trim_backpressure(tree)
        self.assertEqual((bp["connections"], bp["full"], bp["maxPercent"]), (4, 2, 100))
        self.assertEqual([(c["id"], c["group"]) for c in bp["top"]], [(2, "ingest"), (4, "deep"), (1, "root")], "fullest first, empty ones left out")
        self.assertEqual([c["id"] for c in sx.trim_backpressure(tree, top=2)["top"]], [2, 4], "only the fullest N")
        self.assertEqual(sx.trim_backpressure(tree, top=1)["full"], 2, "the count covers every connection, not only the N")
        self.assertNotIn("queued", bp["top"][0], "only numbers and names")
        self.assertEqual(sx.trim_backpressure({}), {"connections": 0, "full": 0, "maxPercent": 0, "top": []})

    def test_keytool_listings_of_both_store_types(self):
        jks = sx.parse_keytool((NIFI_DATA / "1.12.1-keytool-truststore-jks.txt").read_text())
        self.assertEqual(jks, [{"alias": "nifi-cert", "subject": "CN=localhost, OU=NIFI", "issuer": "CN=localhost, OU=NIFI",
                                "notBefore": "2026-11-04T14:19:17Z", "notAfter": "2029-02-06T14:19:17Z"}])
        p12 = sx.parse_keytool((NIFI_DATA / "2.0.0-keytool-keystore-pkcs12.txt").read_text())
        self.assertEqual([(c["alias"], c["chain"], c["subject"], c["notAfter"]) for c in p12],
                         [("nifi-key", 1, "CN=n200.lab, OU=NIFI", "2029-02-06T14:19:17Z"), ("nifi-key", 2, "CN=localhost, OU=NIFI", "2029-02-06T14:19:17Z")])
        self.assertEqual(sx.keytool_error((NIFI_DATA / "keytool-wrong-password.txt").read_text()), "keystore password was incorrect")
        self.assertEqual(sx.java_date("Tue Feb 06 14:19:17 CST 2029"), "Tue Feb 06 14:19:17 CST 2029", "another zone stays as written")

    def test_where_to_connect_and_the_name_checked(self):
        self.assertEqual(sx.endpoint("nifi1.corp"), ("nifi1.corp", "nifi1.corp"))
        self.assertEqual(sx.endpoint("0.0.0.0", "nifi1.corp"), ("localhost", "nifi1.corp"), "bound everywhere: localhost, checked against the node's name")
        self.assertEqual(sx.endpoint("", None), ("localhost", "localhost"))

    def test_the_monitor_certificate_and_the_relaxed_ca(self):
        self.assertEqual(sx.nifi_context({})[0], None)
        self.assertIn("EXECUTOR_NIFI_CLIENT_CERT", sx.nifi_context({})[1])
        ctx, why = sx.nifi_context({"nifi_client_cert": "/nonexistent.crt", "nifi_client_key": "/nonexistent.key"})
        self.assertIsNone(ctx)
        self.assertIn("cannot load the monitor certificate", why)

        class Ctx:
            verify_flags = getattr(sx.ssl, "VERIFY_X509_STRICT", 0x20) | 0x1

            def load_cert_chain(self, cert, key):
                self.chain = (cert, key)
        made = []
        real = sx.ssl.create_default_context
        sx.ssl.create_default_context = lambda cafile=None: made.append(cafile) or Ctx()
        try:
            strict = sx.nifi_context({"nifi_client_cert": "/m.crt", "nifi_client_key": "/m.key", "nifi_ca": "/ca.crt"})[0]
            relaxed = sx.nifi_context({"nifi_client_cert": "/m.crt", "nifi_client_key": "/m.key", "nifi_ca": "/ca.crt", "nifi_ca_relaxed": True})[0]
        finally:
            sx.ssl.create_default_context = real
        flag = getattr(sx.ssl, "VERIFY_X509_STRICT", 0x20)
        self.assertEqual((strict.verify_flags & flag, relaxed.verify_flags & flag, relaxed.verify_flags & 0x1), (flag, 0, 0x1), "only the strict flag goes")
        self.assertEqual((made, relaxed.chain), (["/ca.crt", "/ca.crt"], ("/m.crt", "/m.key")))
        c = sx.config(environ={"EXECUTOR_COLLECT_SECONDS": "5", "EXECUTOR_NIFI_CA_RELAXED": "1"})
        self.assertEqual((c["collect_seconds"], c["nifi_ca_relaxed"]), (30, True))
        self.assertEqual((sx.config(environ={})["collect_seconds"], sx.config(environ={"EXECUTOR_COLLECT_SECONDS": "900"})["collect_seconds"]), (60, 300))
        # Back pressure (owner 2026-11-07): every 5 minutes and the fullest 5 by default, within 30-3600 s and 1-50.
        self.assertEqual((sx.config(environ={})["backpressure_seconds"], sx.config(environ={})["backpressure_top"]), (300, 5))
        low = sx.config(environ={"EXECUTOR_BACKPRESSURE_SECONDS": "10", "EXECUTOR_BACKPRESSURE_TOP": "0"})
        high = sx.config(environ={"EXECUTOR_BACKPRESSURE_SECONDS": "99999", "EXECUTOR_BACKPRESSURE_TOP": "500"})
        self.assertEqual((low["backpressure_seconds"], low["backpressure_top"], high["backpressure_seconds"], high["backpressure_top"]), (30, 1, 3600, 50))

    @unittest.skipUnless(shutil.which("openssl"), "needs openssl")
    def test_reads_a_pem_certificate(self):
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/OU=ops-lab/CN=monitor", "-days", "30",
                            "-keyout", f"{d}/m.key", "-out", f"{d}/m.crt"], check=True, capture_output=True)
            cert = sx.pem_certificate(f"{d}/m.crt")
        self.assertEqual((cert["subject"], cert["issuer"]), ("CN=monitor, OU=ops-lab", "CN=monitor, OU=ops-lab"))
        left = time.mktime(time.strptime(cert["notAfter"], "%Y-%m-%dT%H:%M:%SZ")) - time.mktime(time.strptime(cert["notBefore"], "%Y-%m-%dT%H:%M:%SZ"))
        self.assertAlmostEqual(left / 86400, 30, delta=1)


@unittest.skipUnless(hasattr(os, "geteuid") and hasattr(os, "symlink"), "needs a POSIX system")
class CollectorTest(Base):
    def setUp(self):
        super().setUp()
        self.api = WatchApi()
        self.proc = FakeProc(self.root / "proc")
        (self.proc.root / "loadavg").write_text("0.50 0.40 0.30 1/200 999\n")
        (self.proc.root / "meminfo").write_text("MemTotal:       16000000 kB\nMemFree:  1000 kB\nMemAvailable:   8000000 kB\n")
        lab = self.root / "lab"
        tls = {"nifi.web.https.host": "localhost", "nifi.security.keystore": "./conf/keystore.pkcs12", "nifi.security.keystoreType": "PKCS12",
               "nifi.security.keystorePasswd": "kspw", "nifi.security.truststore": "./conf/truststore.jks", "nifi.security.truststoreType": "JKS",
               "nifi.security.truststorePasswd": "tspw"}
        self.n112 = nifi_home(lab, "n112", "1.12.1", {**tls, "nifi.web.https.port": "18443"}, two=False)
        self.n200 = nifi_home(lab, "n200", "2.0.0", {**tls, "nifi.web.https.port": "18444", "nifi.security.keystorePasswd": "wrong"})
        self.c250 = nifi_home(lab, "c250-1", "2.5.0", {**tls, "nifi.web.https.port": "18445", "nifi.cluster.is.node": "true", "nifi.cluster.node.address": "node1.lab"})
        self.stopped = nifi_home(lab, "c250-2", "2.5.0", {**tls, "nifi.web.https.port": "18446", "nifi.cluster.is.node": "true"})
        for home in (self.n112, self.n200, self.c250, self.stopped):
            for f in ("keystore.pkcs12", "truststore.jks"):
                (home / "conf" / f).write_bytes(b"store")
        jdk = self.root / "jdk" / "bin"
        jdk.mkdir(parents=True)
        (jdk / "keytool").write_text("#!/bin/sh\n")
        os.chmod(jdk / "keytool", 0o755)
        lab_processes(self.proc, self.n112, two=False, env={"JAVA_HOME": str(self.root / "jdk")}, base=5000)
        lab_processes(self.proc, self.n200, env={"JAVA_HOME": str(self.root / "jdk")}, base=6000)
        lab_processes(self.proc, self.c250, env={"JAVA_HOME": str(self.root / "jdk")}, base=4000)
        (self.proc.root / "4001" / "status").write_text(f"Name:\tjava\nPPid:\t4000\nUid:\t{os.geteuid()}\t0\t0\t0\nVmRSS:\t  204800 kB\nThreads:\t174\n")
        (self.proc.root / "4001" / "stat").write_text("4001 (java) S 4000 " + " ".join(["0"] * 9) + f" {12 * os.sysconf('SC_CLK_TCK')} {3 * os.sysconf('SC_CLK_TCK')} " + " ".join(["0"] * 6) + " 250 0 0\n")
        self.watch = [self.entry("n112", self.n112), self.entry("n200", self.n200), self.entry("c250", self.c250, https=18445, node="node1.lab"),
                      self.entry("c250", self.stopped, https=18446)]

    @staticmethod
    def entry(service, home, https=None, node=None):
        return {"service": service, "member": f"local:{home}", "profile": "nifi-2.x", "installDir": str(home), "confDir": str(home / "conf"),
                "https": {"host": "localhost", "port": https}, "nodeAddress": node, "logDir": str(home / "logs")}

    def collector(self, **cfg_over):
        c = LabCollector(cfg(self.root, **cfg_over), proc=self.proc.root, uid=os.geteuid())
        return c

    def by_service(self, samples):
        return {pathlib.Path(s["member"].split(":", 1)[1]).name: s for s in samples}

    def test_the_watch_list_comes_with_every_heartbeat_reply(self):
        ex = self.executor()
        self.assertIsNone(ex.watch)
        self.assertIsNone(ex.beat_body(None)["collector"]["watching"], "not known before the first reply")
        self.api.watch = [*self.watch, {"service": "x"}, {"service": "y", "member": "m", "installDir": "relative"}, "nonsense"]
        ex.selfcheck()
        self.assertEqual([w["service"] for w in ex.watch], ["n112", "n200", "c250", "c250"], "malformed entries left out")
        self.assertEqual(ex.watch[2]["https"], {"host": "localhost", "port": 18445})
        self.api.watch = [self.watch[0]]
        ex.heartbeat()
        self.assertEqual([w["service"] for w in ex.watch], ["n112"], "a removal counts from the next beat")
        self.assertEqual(ex.beat_body(None)["collector"], {"seconds": 60, "backpressureSeconds": 300, "watching": 1, "backlog": 0, "certificate": False})
        self.api.watch = None
        ex.heartbeat()
        self.assertEqual(ex.watch, [], "a Deployer that sends no list: nothing is watched")
        self.api.down = True
        ex.heartbeat()
        self.assertEqual(ex.watch, [], "a failed beat changes nothing")

    def test_a_round_samples_each_watched_nifi_from_proc_rest_and_its_certificates(self):
        c = self.collector()
        samples = self.by_service(c.round(sx.watch_entries(self.watch)))
        self.assertEqual(sorted(samples), ["c250-1", "c250-2", "n112", "n200"])
        node = samples["c250-1"]
        self.assertEqual((node["service"], node["process"]["running"], node["process"]["pid"], node["process"]["bootstrapPid"]), ("c250", True, 4001, 4000))
        self.assertEqual((node["process"]["rssBytes"], node["process"]["threads"], node["process"]["cpuSeconds"]), (200 << 20, 174, 15.0))
        self.assertEqual(node["host"]["load"], [0.5, 0.4, 0.3])
        self.assertEqual(node["host"]["memory"], {"totalBytes": 16000000 * 1024, "availableBytes": 8000000 * 1024})
        self.assertEqual(len(node["disks"]), 1, "one device for the repositories and the logs")
        self.assertEqual(sorted(node["disks"][0]["holds"]), ["content", "database", "flowfile", "logs", "provenance"])
        n = node["nifi"]
        self.assertEqual((n["state"], n["url"], n["about"]["version"]), ("ok", "https://localhost:18445", "2.5.0"))
        self.assertEqual(len(n["diagnostics"]["nodes"]), 2, "a node asks nodewise")
        self.assertEqual(len(n["cluster"]["nodes"]), 2)
        self.assertEqual(len(n["bulletins"]), 3)
        paths = [call[3] for call in c.calls if call[1] == 18445]
        self.assertEqual(paths, ["flow/about", "system-diagnostics?nodewise=true", "flow/status", "controller/cluster", f"flow/bulletin-board?limit={sx.BULLETINS}",
                                 "flow/process-groups/root/status?recursive=true"])
        self.assertTrue(all(call[0] == call[2] == "localhost" and call[4] <= sx.REQUEST_TIMEOUT for call in c.calls), "connects to nifi.web.https.host, checks that name")

        standalone = samples["n112"]["nifi"]
        self.assertEqual((standalone["state"], standalone["about"]["version"]), ("ok", "1.12.1"))
        self.assertNotIn("cluster", standalone)
        self.assertNotIn("nodes", standalone["diagnostics"], "a standalone asks without nodewise")
        self.assertEqual(samples["c250-2"]["process"], {"running": False})
        self.assertEqual(samples["c250-2"]["nifi"], {"state": "not-running"})
        self.assertNotIn(18446, [call[1] for call in c.calls], "a NiFi that does not run is not called")

        # The certificates (S27): the keystore (PKCS12) and truststore (JKS) of each, keytool of the NiFi's JDK, the password in the environment.
        certs = {s["store"]: s for s in samples["n112"]["certs"]["stores"]}
        self.assertEqual(sorted(certs), ["keystore", "truststore"], "no monitor certificate configured")
        self.assertEqual((certs["keystore"]["type"], certs["keystore"]["path"]), ("PKCS12", str(self.n112 / "conf" / "keystore.pkcs12")))
        self.assertEqual([x["notAfter"] for x in certs["keystore"]["certificates"]], ["2029-02-06T14:19:17Z"] * 2)
        self.assertEqual((certs["truststore"]["type"], certs["truststore"]["certificates"][0]["subject"]), ("JKS", "CN=localhost, OU=NIFI"))
        self.assertTrue(all(run[0] == str(self.root / "jdk" / "bin" / "keytool") for run in c.keytool_runs))
        self.assertIn((str(self.root / "jdk" / "bin" / "keytool"), str(self.n112 / "conf" / "truststore.jks"), "JKS", "tspw"), c.keytool_runs)
        bad = {s["store"]: s for s in samples["n200"]["certs"]["stores"]}
        self.assertEqual((bad["keystore"]["error"], bad["keystore"]["certificates"]), ("keystore password was incorrect", []))
        self.assertEqual(len(bad["truststore"]["certificates"]), 1, "the other store is still read")
        self.assertNotIn("kspw", json.dumps(list(samples.values())), "no password in a sample")

    def test_one_nifi_down_or_hanging_affects_only_its_own_sample(self):
        c = self.collector()
        c.down.add(18444)
        c.hang.add(18443)
        samples = self.by_service(c.round(sx.watch_entries(self.watch)))
        self.assertEqual(samples["n200"]["nifi"]["state"], "unreachable")
        self.assertIn("Connection refused", samples["n200"]["nifi"]["error"])
        self.assertEqual(samples["n112"]["nifi"]["state"], "unreachable")
        self.assertEqual([call[3] for call in c.calls if call[1] in (18443, 18444)], ["flow/about", "flow/about"], "after the first call fails, no more waiting")
        self.assertEqual(samples["c250-1"]["nifi"]["state"], "ok")
        self.assertTrue(samples["n200"]["process"]["running"], "the process is still sampled")

        # A call that fails after the first: the sample is partial, the rest is there.
        orig = c.fetch
        c.fetch = lambda ctx, connect, port, sni, path, timeout: (403, b"no read policy") if path == "controller/cluster" else orig(ctx, connect, port, sni, path, timeout)
        node = self.by_service(c.round(sx.watch_entries(self.watch)))["c250-1"]["nifi"]
        self.assertEqual((node["state"], node["errors"]), ("partial", {"cluster": "HTTP 403: no read policy"}))
        self.assertIn("diagnostics", node)

    def test_redaction_matches_the_deployer(self):
        """The cases the Deployer's redact.ts passes (testdata/redact/cases.json): the two rule sets must agree."""
        cases = json.loads((HERE.parent / "testdata" / "redact" / "cases.json").read_text())
        self.assertTrue(cases["text"])
        for text, want in cases["text"]:
            self.assertEqual(sx.redact(text), want, text)
            self.assertEqual(sx.redact(want), want, "redacting twice changes nothing")
        props = cases["properties"]
        self.assertEqual(sx.NOT_SECRET_PROPERTY, set(props["exempt"]))
        for key in props["hidden"]:
            self.assertEqual(sx.hide_secrets({key: "v"}), {key: sx.HIDDEN}, key)
        for key in props["shown"] + props["exempt"]:
            self.assertEqual(sx.hide_secrets({key: "v"}), {key: "v"}, key)
            self.assertEqual(sx.secret_fingerprints({key: "v"}, "k"), {}, key)

    def test_back_pressure_only_every_interval_and_as_a_summary(self):
        c = self.collector()
        c.cfg = dict(c.cfg, backpressure_seconds=300, backpressure_top=2)
        clock = [5000.0]
        real = sx.time.monotonic
        sx.time.monotonic = lambda: clock[0]
        status = "flow/process-groups/root/status?recursive=true"
        try:
            watch = sx.watch_entries(self.watch[2:3])
            first = self.by_service(c.round(watch))["c250-1"]["nifi"]
            clock[0] += 60
            second = self.by_service(c.round(watch))["c250-1"]["nifi"]
            clock[0] += 220
            third = self.by_service(c.round(watch))["c250-1"]["nifi"]
        finally:
            sx.time.monotonic = real
        self.assertEqual(first["backpressure"]["everySeconds"], 300)
        self.assertIn("at", first["backpressure"])
        self.assertEqual({k: first["backpressure"][k] for k in ("connections", "full", "maxPercent", "top")}, {"connections": 0, "full": 0, "maxPercent": 0, "top": []})
        self.assertEqual(second["state"], "ok", "a round without back pressure is not partial")
        self.assertNotIn("backpressure", second, "not again within the interval")
        self.assertIn("backpressure", third, "again at the round due (half a period early counts: rounds drift)")
        self.assertEqual([call[3] for call in c.calls if call[1] == 18445].count(status), 2)

        # Asked and failed: not asked again before the interval is over either.
        c2 = self.collector()
        orig = c2.fetch
        c2.fetch = lambda ctx, connect, port, sni, path, timeout: (500, b"too big") if path == status else orig(ctx, connect, port, sni, path, timeout)
        failed = self.by_service(c2.round(watch))["c250-1"]["nifi"]
        self.assertEqual((failed["state"], failed["errors"]), ("partial", {"backpressure": "HTTP 500: too big"}))
        again = self.by_service(c2.round(watch))["c250-1"]["nifi"]
        self.assertEqual((again["state"], "backpressure" in again), ("ok", False))

    def test_a_nifi_that_hangs_costs_at_most_its_budget(self):
        c = self.collector()
        clock = [1000.0]
        real = sx.time.monotonic
        sx.time.monotonic = lambda: clock[0]
        # Each answer takes 4 seconds: about, diagnostics and status fit in the 10, the rest is skipped.
        c.fetch = lambda ctx, connect, port, sni, path, timeout: (clock.__setitem__(0, clock[0] + 4), recorded(LAB_PORTS[port], path))[1]
        try:
            node = self.by_service(c.round(sx.watch_entries(self.watch[2:3])))["c250-1"]["nifi"]
        finally:
            sx.time.monotonic = real
        self.assertEqual(node["state"], "partial")
        self.assertEqual(sorted(node["errors"]), ["backpressure", "bulletins", "cluster"])
        self.assertTrue(all(v.startswith("skipped") for v in node["errors"].values()))
        self.assertIn("status", node)

    def test_without_the_monitor_certificate_only_proc_and_the_disks(self):
        c = sx.Collector(cfg(self.root), proc=self.proc.root, uid=os.geteuid())
        c.run_keytool = LabCollector.run_keytool.__get__(c)
        c.keytool_runs = []
        samples = self.by_service(c.round(sx.watch_entries(self.watch)))
        self.assertEqual(samples["c250-1"]["nifi"]["state"], "no-certificate")
        self.assertIn("EXECUTOR_NIFI_CLIENT_CERT", samples["c250-1"]["nifi"]["error"])
        self.assertTrue(samples["c250-1"]["process"]["running"])
        self.assertTrue(samples["c250-1"]["disks"])
        self.assertTrue(samples["c250-1"]["certs"]["stores"], "the certificates are read from the files all the same")

    def test_only_new_bulletins_are_sent(self):
        c = self.collector()
        watch = sx.watch_entries(self.watch[2:3])
        self.assertEqual(len(c.round(watch)[0]["nifi"]["bulletins"]), 3)
        self.assertEqual(c.round(watch)[0]["nifi"]["bulletins"], [], "the same three again")

    def test_certificates_are_read_once_an_hour_or_when_a_file_changes(self):
        c = self.collector()
        watch = sx.watch_entries(self.watch[:1])
        first = c.round(watch)[0]["certs"]
        runs = len(c.keytool_runs)
        self.assertEqual(c.round(watch)[0]["certs"], first)
        self.assertEqual(len(c.keytool_runs), runs, "cached")
        ks = self.n112 / "conf" / "keystore.pkcs12"
        os.utime(ks, (ks.stat().st_mtime + 5, ks.stat().st_mtime + 5))
        c.round(watch)
        self.assertEqual(len(c.keytool_runs), runs * 2, "a store changed: read again")
        c.certs[watch[0]["member"]]["at"] -= sx.CERTS_EVERY
        c.round(watch)
        self.assertEqual(len(c.keytool_runs), runs * 3, "an hour later: read again")

    def test_an_encrypted_password_or_no_keytool_is_said_not_fatal(self):
        props = self.n112 / "conf" / "nifi.properties"
        props.write_text(props.read_text() + "nifi.security.keystorePasswd.protected=aes/gcm/256\n")
        c = self.collector()
        stores = {s["store"]: s for s in c.round(sx.watch_entries(self.watch[:1]))[0]["certs"]["stores"]}
        self.assertIn("encrypted in nifi.properties", stores["keystore"]["error"])
        self.assertTrue(stores["truststore"]["certificates"])
        self.assertNotIn(str(self.n112 / "conf" / "keystore.pkcs12"), [r[1] for r in c.keytool_runs])

        c = self.collector()
        os.unlink(self.root / "jdk" / "bin" / "keytool")
        real = sx.shutil.which
        sx.shutil.which = lambda name: None
        try:
            stores = c.round(sx.watch_entries(self.watch[1:2]))[0]["certs"]["stores"]
        finally:
            sx.shutil.which = real
        self.assertTrue(all("keytool not found" in s["error"] for s in stores))
        self.assertTrue(c.certs[self.watch[1]["member"]]["retry"], "tried again next round")

    def test_samples_go_out_in_batches_and_wait_while_the_deployer_is_down(self):
        ex = self.executor()
        ex.collector = self.collector()
        self.api.watch = self.watch
        ex.heartbeat()
        ex.collect_once()
        self.assertEqual((self.api.posts, len(self.api.samples)), ([4], 4))
        self.api.down = True
        for _ in range(6):
            ex.collect_once()
        self.assertEqual(len(ex.backlog), 24)
        self.assertEqual(ex.beat_body(None)["collector"]["backlog"], 24)
        self.api.down = False
        ex.push_samples()
        self.assertEqual(self.api.posts, [4, 20, 4], f"at most {sx.SAMPLES_PER_POST} per request")
        self.assertEqual(ex.backlog, [])
        # Kept no longer than 30 minutes: the oldest go first.
        self.api.down = True
        ex.collect_once()
        ex.backlog = [(t - sx.BACKLOG_SECONDS - 1, s) for t, s in ex.backlog[:2]] + ex.backlog[2:]
        self.api.down = False
        ex.push_samples()
        self.assertEqual(self.api.posts[-1], 2)
        self.assertEqual(len(self.api.samples), 30)

    def test_a_collector_failure_is_in_the_sample(self):
        c = self.collector()
        c.sample = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
        out = c.round(sx.watch_entries(self.watch[:1]))
        self.assertEqual(out[0]["problems"], ["the collector failed: boom"])
        self.assertEqual(c.round([]), [], "nothing watched: nothing sampled")


@unittest.skipUnless(all(shutil.which(c) for c in ("sh", "tar", "sha256sum")) and hasattr(os, "symlink"), "needs sh, tar, sha256sum")
class LogApi(WatchApi):
    """The Deployer's side of the logs: the content channel and the tail's chunks (answering stop once told to)."""

    def __init__(self):
        super().__init__()
        self.content, self.chunks, self.stop_after = {}, [], None

    def put_content(self, job_id, data):
        self.content[job_id] = bytes(data)

    def post_chunk(self, job_id, chunk):
        self.chunks.append(json.loads(json.dumps(chunk)))
        return {"ok": True, "stop": self.stop_after is not None and len(self.chunks) >= self.stop_after}


def log_line(stamp, level, logger, message):
    return f"2026-11-06 {stamp},123 {level} [Timer-Driven Process Thread-3] {logger} {message}\n"


class LogsTest(Base):
    def setUp(self):
        super().setUp()
        # The log's local times read as UTC here, whatever zone the machine running the tests is in.
        old = os.environ.get("TZ")
        os.environ["TZ"] = "UTC"
        time.tzset()

        def back():
            if old is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old
            time.tzset()
        self.addCleanup(back)
        self.api = LogApi()
        self.logs = self.root / "nifi" / "logs"
        self.logs.mkdir(parents=True)
        self.app = self.logs / "nifi-app.log"
        self.app.write_text(log_line("10:00:00", "INFO", "o.a.n.NiFi", "Started"))
        self.member = "local:/opt/nifi"
        self.watch = [{"service": "n1", "member": self.member, "installDir": str(self.root / "nifi"), "confDir": None, "https": {}, "logDir": str(self.logs)}]

    def ex(self):
        e = self.executor()
        e.watch = sx.watch_entries(self.watch)
        return e

    def read(self, ex, request, kind="log-read", timeout=10):
        job = sx.ReadJob({"id": "log-read-0001", "kind": kind, **request}, timeout)
        result = getattr(ex, ex.READ_JOBS[kind])(job)
        return result, json.loads(self.api.content.pop(job.id)) if job.id in self.api.content and request.get("mode") != "download" else self.api.content.pop(job.id, None)

    def test_the_heartbeat_names_the_log_jobs(self):
        self.assertTrue({"log-read", "log-tail"} <= set(self.executor().KINDS))

    def test_the_summary_counts_warn_and_error_by_pattern_and_hides_secrets(self):
        s = sx.LogSummary(self.root / "work")
        first = s.read(self.member, str(self.logs))
        self.assertEqual((first["patterns"], first["lines"]), ([], 0), "the first look starts at the end")
        with self.app.open("a") as f:
            f.write(log_line("10:00:01", "WARN", "o.a.n.c.NodeClusterCoordinator", "Problem encountered issuing reconnection request to node localhost:18446"))
            f.write(log_line("10:00:06", "WARN", "o.a.n.c.NodeClusterCoordinator", "Problem encountered issuing reconnection request to node localhost:18447"))
            f.write(log_line("10:00:07", "ERROR", "o.a.c.f.i.CuratorFrameworkImpl", "Background exception was not retry-able for 4f6a7c1e-1111-2222-3333-444455556666 password=hunter2"))
            f.write("org.apache.zookeeper.KeeperException$ConnectionLossException: KeeperErrorCode = ConnectionLoss\n\tat org.apache.zookeeper.KeeperException.create(KeeperException.java:102)\n")
            f.write(log_line("10:00:08", "INFO", "o.a.n.NiFi", "ignored"))
            f.write("2026-11-06 10:00:09,000 WARN [half a line")
        got = s.read(self.member, str(self.logs))
        by = {p["level"]: p for p in got["patterns"]}
        self.assertEqual(len(got["patterns"]), 2)
        warn = by["WARN"]
        self.assertEqual((warn["count"], warn["template"]), (2, "Problem encountered issuing reconnection request to node localhost:<n>"))
        self.assertEqual((warn["firstAt"], warn["lastAt"]), ("2026-11-06T10:00:01.123Z", "2026-11-06T10:00:06.123Z"))
        self.assertIn("18446", warn["first"])
        self.assertIn("18447", warn["last"])
        err = by["ERROR"]
        self.assertEqual(err["exception"], "org.apache.zookeeper.KeeperException$ConnectionLossException")
        self.assertEqual(err["template"], "Background exception was not retry-able for <uuid> password=[hidden]")
        self.assertNotIn("hunter2", err["first"])
        self.assertIn("password=[hidden]", err["first"])
        self.assertIn("ConnectionLoss", err["first"], "the stack trace is part of the sample")
        # The half line waits for its end; a new executor (a restart) carries on from the kept offset.
        with self.app.open("a") as f:
            f.write("] o.a.n.c.X second half\n" + log_line("10:00:10", "ERROR", "o.a.n.c.X", "x" * 5000))
        again = sx.LogSummary(self.root / "work").read(self.member, str(self.logs))
        self.assertEqual(sorted((p["level"], p["count"]) for p in again["patterns"]), [("ERROR", 1), ("WARN", 1)])
        self.assertTrue(all(len(p["first"]) <= 2048 for p in again["patterns"]), "samples cut at 2 KiB")

    def test_the_summary_follows_a_rollover_by_inode(self):
        s = sx.LogSummary(self.root / "work")
        s.read(self.member, str(self.logs))
        with self.app.open("a") as f:
            f.write(log_line("10:01:00", "ERROR", "o.a.n.A", "before the rollover"))
        os.rename(self.app, self.logs / "nifi-app_2026-11-06_10.0.log")
        self.app.write_text(log_line("10:02:00", "ERROR", "o.a.n.B", "after the rollover"))
        got = s.read(self.member, str(self.logs))
        self.assertEqual(sorted(p["logger"] for p in got["patterns"]), ["o.a.n.A", "o.a.n.B"])
        self.assertEqual(got["inode"], os.stat(self.app).st_ino)

    def test_paths_outside_the_log_directory_are_refused(self):
        ex = self.ex()
        files = ex.log_files()
        (self.root / "secret.txt").write_text("no")
        os.symlink(self.root / "secret.txt", self.logs / "escape.log")
        os.symlink(self.app, self.logs / "inside.log")
        for name in ("../secret.txt", str(self.root / "secret.txt"), "escape.log", "/etc/passwd", "nothere.log"):
            with self.assertRaises(sx.Refused, msg=name):
                files.resolve(self.member, name)
        self.assertEqual(files.resolve(self.member, "inside.log"), os.path.realpath(self.app), "a link inside the directory is fine")
        with self.assertRaises(sx.Refused):
            files.resolve("local:/elsewhere", "nifi-app.log")
        names = [f["name"] for f in files.listing(self.member)["files"]]
        self.assertEqual(names[0], "nifi-app.log")
        self.assertNotIn("escape.log", names, "a link out of the directory is not listed")
        with self.assertRaises(sx.Refused):
            self.read(ex, {"member": self.member, "mode": "lines", "file": "../../secret.txt"})

    def test_search_reads_rolled_and_gz_files_by_time_level_and_text(self):
        import gzip
        old = self.logs / "nifi-app_2026-11-06_09.0.log.gz"
        with gzip.open(old, "wt") as f:
            f.write(log_line("09:10:00", "ERROR", "o.a.n.Old", "ZooKeeper connection lost") + "java.net.ConnectException: refused\n\tat x.y(Z.java:1)\n")
            f.write(log_line("09:20:00", "WARN", "o.a.n.Old", "something else"))
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        with self.app.open("a") as f:
            f.write(log_line("10:30:00", "ERROR", "o.a.n.New", "ZooKeeper connection lost again"))
            f.write(log_line("10:31:00", "INFO", "o.a.n.New", "ZooKeeper info line"))
        ex = self.ex()
        result, body = self.read(ex, {"member": self.member, "mode": "search", "query": "zookeeper", "levels": ["WARN", "ERROR"]})
        self.assertEqual([(e["file"], e["at"], e["level"]) for e in body["entries"]],
                         [("nifi-app_2026-11-06_09.0.log.gz", "2026-11-06T09:10:00.123Z", "ERROR"), ("nifi-app.log", "2026-11-06T10:30:00.123Z", "ERROR")])
        self.assertIn("ConnectException", body["entries"][0]["text"], "an entry keeps its stack trace")
        self.assertEqual((result["entries"], result["truncated"]), (2, None))
        self.assertNotIn("text", json.dumps(result), "the status carries only counts")
        _, body = self.read(ex, {"member": self.member, "mode": "search", "query": r"conn\w+ lost again$", "regex": True, "from": "2026-11-06T10:00:00Z", "to": "2026-11-06T11:00:00Z"})
        self.assertEqual([e["logger"] for e in body["entries"]], ["o.a.n.New"])
        result, body = self.read(ex, {"member": self.member, "mode": "search", "limit": 2})
        self.assertEqual([e["at"][11:19] for e in body["entries"]], ["10:30:00", "10:31:00"], "over the limit: the newest kept")
        self.assertTrue(result["truncated"])
        for bad in ({"mode": "search", "query": "(", "regex": True}, {"mode": "search", "limit": 9999}, {"mode": "search", "levels": ["LOUD"]}, {"mode": "nope"}):
            with self.assertRaises(sx.Refused, msg=bad):
                self.read(ex, {"member": self.member, **bad})

    def test_lines_and_the_listing(self):
        with self.app.open("a") as f:
            for i in range(50):
                f.write(log_line("10:00:%02d" % i, "INFO", "o.a.n.X", f"line {i}"))
        ex = self.ex()
        result, body = self.read(ex, {"member": self.member, "mode": "lines", "lines": 3})
        self.assertEqual([x.rsplit(" ", 1)[1] for x in body["lines"]], ["47", "48", "49"])
        self.assertEqual((result["lines"], body["inode"]), (3, os.stat(self.app).st_ino))
        result, body = self.read(ex, {"member": self.member, "mode": "list"})
        self.assertEqual((body["dir"], [f["name"] for f in body["files"]]), (str(self.logs), ["nifi-app.log"]))

    def test_download_packs_the_files_as_a_tar_gz_within_the_limit(self):
        import tarfile
        (self.logs / "nifi-bootstrap.log").write_text("bootstrap\n")
        ex = self.ex()
        job = sx.ReadJob({"id": "log-read-0002", "kind": "log-read", "member": self.member, "mode": "download", "files": ["nifi-app.log", "nifi-bootstrap.log"]}, 10)
        result = ex.log_read(job)
        data = self.api.content[job.id]
        self.assertEqual((result["bytes"], result["files"]), (len(data), ["nifi-app.log", "nifi-bootstrap.log"]))
        with tarfile.open(fileobj=__import__("io").BytesIO(data), mode="r:gz") as tar:
            self.assertEqual(sorted(tar.getnames()), ["nifi-app.log", "nifi-bootstrap.log"])
            self.assertEqual(tar.extractfile("nifi-bootstrap.log").read(), b"bootstrap\n")
        (self.logs / "big.log").write_bytes(os.urandom(200_000))
        result = ex.log_read(sx.ReadJob({"id": "log-read-0003", "kind": "log-read", "member": self.member, "mode": "download", "files": ["big.log", "nifi-bootstrap.log"], "maxBytes": 30_000}, 10))
        self.assertEqual((result["files"], result["skipped"]), (["nifi-bootstrap.log"], ["big.log"]))
        with self.assertRaises(sx.Refused):
            ex.log_read(sx.ReadJob({"id": "log-read-0004", "kind": "log-read", "member": self.member, "mode": "download", "files": ["../x"]}, 10))

    def test_tail_follows_by_inode_across_a_rollover_and_carries_on_from_its_cursor(self):
        ex = self.ex()
        old_every = sx.TAIL_EVERY
        sx.TAIL_EVERY = 0.1
        self.addCleanup(setattr, sx, "TAIL_EVERY", old_every)
        out = {}
        job = sx.ReadJob({"id": "log-tail-0001", "kind": "log-tail", "member": self.member, "seconds": 3, "lines": 5}, 30)
        t = threading.Thread(target=lambda: out.update(result=ex.log_tail(job)))
        t.start()
        self.assertTrue(wait_until(lambda: self.api.chunks))
        self.assertTrue(self.api.chunks[0]["first"])
        self.assertIn("Started", self.api.chunks[0]["text"], "it starts with the last lines")
        with self.app.open("a") as f:
            f.write(log_line("10:00:01", "INFO", "o.a.n.X", "one"))
        self.assertTrue(wait_until(lambda: "one" in "".join(c["text"] for c in self.api.chunks)))
        with self.app.open("a") as f:
            f.write(log_line("10:00:02", "INFO", "o.a.n.X", "last of the old file"))
        os.rename(self.app, self.logs / "nifi-app_2026-11-06_10.0.log")
        self.app.write_text(log_line("10:00:03", "INFO", "o.a.n.X", "first of the new file"))
        t.join(10)
        text = "".join(c["text"] for c in self.api.chunks)
        self.assertLess(text.index("last of the old file"), text.index("first of the new file"))
        self.assertTrue(any(c.get("rotated") == "nifi-app_2026-11-06_10.0.log" for c in self.api.chunks))
        result = out["result"]
        self.assertEqual((result["inode"], result["offset"], result["rotated"]), (os.stat(self.app).st_ino, os.path.getsize(self.app), 1))
        # The next tail carries on from the cursor: nothing again, only what came since.
        with self.app.open("a") as f:
            f.write(log_line("10:00:04", "INFO", "o.a.n.X", "while nobody followed"))
        self.api.chunks.clear()
        self.api.stop_after = 1
        again = ex.log_tail(sx.ReadJob({"id": "log-tail-0002", "kind": "log-tail", "member": self.member, "seconds": 5, "cursor": {"inode": result["inode"], "offset": result["offset"]}}, 30))
        self.assertEqual("".join(c["text"] for c in self.api.chunks), log_line("10:00:04", "INFO", "o.a.n.X", "while nobody followed"))
        self.assertTrue(again["stopped"], "nobody follows any more: it ends early")
        with self.assertRaises(sx.Refused):
            ex.log_tail(sx.ReadJob({"id": "log-tail-0003", "kind": "log-tail", "member": self.member, "file": "../x.log"}, 5))
        with self.assertRaises(sx.Refused):
            ex.log_tail(sx.ReadJob({"id": "log-tail-0004", "kind": "log-tail", "member": self.member, "seconds": 600}, 5))

    def test_the_sample_carries_the_summary(self):
        c = sx.Collector(cfg(self.root), proc=self.root / "noproc", uid=os.geteuid())
        w = sx.watch_entries(self.watch)[0]
        s = c.sample(w, {}, {}, None, "no certificate")
        self.assertEqual((s["logs"]["file"], s["logs"]["patterns"]), (str(self.app), []))


class FakeNifi:
    """NiFi's provenance API as 1.12.1 and 2.x answer it (shapes recorded from the lab, ids made up): search options,
    about, queries that finish on the second look, lineage, events. On a cluster the dates a query runs with are moved
    by `shift` hours (the zone name read back as another zone on replication) and echoed moved twice."""

    OFFSET = 8 * 3600_000  # the lab's NiFi run in China Standard Time

    def __init__(self, version="2.5.0", cluster=False, shift=0, events=(), status=None, never_finish=False, poll_fails=False, big=False):
        self.version, self.cluster, self.shift, self.events = version, cluster, shift, list(events)
        self.status, self.never_finish, self.poll_fails, self.big = status, never_finish, poll_fails, big
        self.calls, self.bodies, self.jobs, self.n = [], [], {}, 0
        self.old = sx.old_terms(version)  # what this NiFi really takes, whatever the executor thinks

    @staticmethod
    def local(ms, millis=True):
        t = time.gmtime((ms + FakeNifi.OFFSET) / 1000)
        return time.strftime("%m/%d/%Y %H:%M:%S", t) + (f".{ms % 1000:03d}" if millis else "") + " CST"

    @staticmethod
    def parse(text):
        if text.endswith(" UTC"):
            return calendar.timegm(time.strptime(text[:-4], "%m/%d/%Y %H:%M:%S")) * 1000
        return calendar.timegm(time.strptime(text[:-4], "%m/%d/%Y %H:%M:%S")) * 1000 - FakeNifi.OFFSET

    def event(self, e, full=False):
        out = {"id": f"{e.get('node', '')}{e['eventId']}", "eventId": e["eventId"], "eventTime": self.local(e["ms"]), "eventType": e["type"], "flowFileUuid": e["uuid"],
               "fileSize": "1,024 bytes", "fileSizeBytes": 1024, "groupId": "g-1", "componentId": e.get("component", "c-gen"), "componentType": e.get("ctype", "GenerateFlowFile"),
               "componentName": e.get("name", "Generate"), "parentUuids": [], "childUuids": [], "replayAvailable": False,
               "inputContentClaimIdentifier": "claim-1", "outputContentClaimSection": "1"}
        if e.get("relationship"):
            out["relationship"] = e["relationship"]
        if self.cluster:
            out.update(clusterNodeId=e["node"], clusterNodeAddress=f"localhost:{18445 if e['node'] == 'node-1' else 18446}")
        if full and e.get("attributes") is not None:
            out["attributes"] = e["attributes"]
        return out

    def __call__(self, method, path, body, timeout):
        self.calls.append(f"{method} {path}")
        if body is not None:
            self.bodies.append(json.loads(json.dumps(body)))
        if self.status:
            return self.status, b"Unable to view provenance. Contact the system administrator."
        bare, _, query = path.partition("?")
        node = query.split("=", 1)[1] if query else None
        if bare == "provenance/search-options":
            fields = [{"id": i, "field": f, "label": lab, "type": "STRING"} for i, f, lab in (("EventType", "eventType", "Event Type"), ("FlowFileUUID", "uuid", "FlowFile UUID"),
                                                                                         ("Filename", "filename", "Filename"), ("ProcessorID", "processorId", "Component ID"))]
            return 200, json.dumps({"provenanceOptions": {"searchableFields": fields}}).encode()
        if bare == "flow/about":
            return 200, json.dumps({"about": {"title": "NiFi", "version": self.version, "timezone": "CST"}}).encode()
        if method == "POST" and bare == "provenance":
            req = body["provenance"]["request"]
            term = next(iter(req["searchTerms"].values()))
            if self.old and isinstance(term, dict):
                return 400, b"Cannot deserialize instance of `java.lang.String` out of START_OBJECT token"
            if not self.old and not isinstance(term, dict):
                return 400, b"Cannot deserialize value of type `ProvenanceSearchValueDTO` from String"
            self.n += 1
            qid = f"q{self.n:04d}-01a1-1000"
            moved = self.shift * 3600_000 if self.cluster else 0
            start, end = self.parse(req["startDate"]) + moved, self.parse(req["endDate"]) + moved
            value = term["value"] if isinstance(term, dict) else term
            field = next(iter(req["searchTerms"]))
            hits = [e for e in self.events if start <= e["ms"] <= end and (field != "FlowFileUUID" or e["uuid"] == value) and (field != "EventType" or e["type"] == value)
                    and (not req.get("clusterNodeId") or e.get("node") == req["clusterNodeId"])]
            hits.sort(key=lambda e: -e["ms"])
            echo = {**req, "startDate": self.local(start + moved, millis=False), "endDate": self.local(end + moved, millis=False)}
            self.jobs[qid] = {"id": qid, "finished": False, "percentCompleted": 0, "request": echo,
                              "results": {"provenanceEvents": [self.event(e) for e in hits[:req["maxResults"]]], "totalCount": len(hits), "total": str(len(hits)), "timeOffset": self.OFFSET}}
            return 201, json.dumps({"provenance": {k: v for k, v in self.jobs[qid].items() if k != "results"}}).encode()
        if method == "POST" and bare == "provenance/lineage":
            req = body["lineage"]["request"]
            if self.cluster and not req.get("clusterNodeId"):
                return 400, b"The cluster node identifier must be specified."
            self.n += 1
            qid = f"l{self.n:04d}-01a1-1000"
            mine = [e for e in self.events if e["uuid"] == req.get("uuid") and (not self.cluster or e.get("node") == req.get("clusterNodeId"))]
            nodes = [{"id": req.get("uuid"), "flowFileUuid": req.get("uuid"), "type": "FLOWFILE", "millis": mine[0]["ms"] if mine else 0, "timestamp": "x"}]
            nodes += [{"id": str(e["eventId"]), "flowFileUuid": e["uuid"], "parentUuids": [], "childUuids": [], "type": "EVENT", "eventType": e["type"], "millis": e["ms"], "timestamp": "x",
                       **({"clusterNodeIdentifier": e["node"]} if self.cluster else {})} for e in mine]
            links = [{"sourceId": str(e["eventId"]), "targetId": req.get("uuid"), "flowFileUuid": e["uuid"], "millis": e["ms"], "timestamp": "x"} for e in mine]
            self.jobs[qid] = {"id": qid, "finished": False, "request": req, "results": {"nodes": nodes, "links": links}}
            return 201, json.dumps({"lineage": {"id": qid, "finished": False}}).encode()
        for prefix, key in (("provenance/lineage/", "lineage"), ("provenance/", "provenance")):
            if bare.startswith(prefix) and "/" not in bare[len(prefix):]:
                qid = bare[len(prefix):]
                if method == "DELETE":
                    self.jobs.pop(qid, None)
                    return 200, b"{}"
                if self.poll_fails:
                    return 500, b"the node went away"
                job = self.jobs[qid]
                if not self.never_finish:
                    job["finished"], job["percentCompleted"] = True, 100
                answer = dict(job) if job["finished"] else {k: v for k, v in job.items() if k != "results"}
                data = json.dumps({key: answer}).encode()
                return 200, (data + b" " * (sx.PROV_BYTES + 1) if self.big else data)
        if bare.startswith("provenance-events/"):
            if self.cluster and not node:
                return 400, b"The cluster node identifier must be specified."
            eid = int(bare.split("/")[1])
            e = next((x for x in self.events if x["eventId"] == eid and (not self.cluster or x.get("node") == node)), None)
            if e is None:
                return 404, b"Unable to find the specified provenance event."
            return 200, json.dumps({"provenanceEvent": self.event(e, full=True)}).encode()
        return 404, b"not found"


AT = calendar.timegm((2026, 11, 6, 15, 20, 0, 0, 0, 0)) * 1000
UUID_A, UUID_B = "11111111-2222-4333-8444-555555555555", "66666666-7777-4888-8999-aaaaaaaaaaaa"


class ProvenanceTest(Base):
    def query(self, nifi, request, cluster=False, seconds=30, offset=None):
        q = sx.ProvenanceQuery(nifi, time.monotonic() + seconds, cluster, offset_ms=offset, sleep=lambda s: time.sleep(0.01))
        return q.run(request)

    def window(self, minutes=60):
        return {"from": sx.iso_ms(AT - 30 * 60_000), "to": sx.iso_ms(AT - 30 * 60_000 + minutes * 60_000)}

    def test_the_heartbeat_names_the_job_and_its_form(self):
        self.assertTrue({"nifi-provenance", "nifi-provenance@1"} <= set(self.executor().KINDS))

    def test_by_uuid_on_1_12_plain_terms_utc_dates_events_in_order_and_the_query_deleted(self):
        events = [{"eventId": 0, "uuid": UUID_A, "type": "CREATE", "ms": AT}, {"eventId": 3, "uuid": UUID_A, "type": "DROP", "ms": AT + 5000, "name": "Log", "ctype": "LogAttribute", "relationship": "success"},
                  {"eventId": 1, "uuid": UUID_B, "type": "CREATE", "ms": AT + 1000}, {"eventId": 9, "uuid": UUID_A, "type": "DROP", "ms": AT + 7200_000}]
        nifi = FakeNifi("1.12.1", events=events)
        out = self.query(nifi, {"op": "provenance", "uuid": UUID_A, **self.window()})
        req = nifi.bodies[0]["provenance"]["request"]
        self.assertEqual(req["searchTerms"], {"FlowFileUUID": UUID_A}, "1.12 takes plain strings")
        self.assertEqual([req["startDate"], req["endDate"]], ["11/06/2026 14:50:00 UTC", "11/06/2026 15:50:00 UTC"])
        self.assertEqual(req["maxResults"], 100)
        self.assertEqual([(e["eventId"], e["eventType"], e["at"]) for e in out["events"]], [(0, "CREATE", "2026-11-06T15:20:00.000Z"), (3, "DROP", "2026-11-06T15:20:05.000Z")])
        self.assertEqual(out["events"][1]["relationship"], "success")
        self.assertFalse(any("ContentClaim" in k or "contentClaim" in k for e in out["events"] for k in e), "nothing of the content")
        self.assertEqual([out["scope"], out["timeOffset"], out["total"], out["limitReached"], out["nifiVersion"]], ["standalone", 8 * 3600_000, 2, False, "1.12.1"])
        self.assertEqual(nifi.calls[-1], f"DELETE provenance/{out['query']}")
        self.assertEqual(nifi.jobs, {}, "nothing left on NiFi")

    def test_on_a_2x_cluster_the_whole_cluster_through_one_node_and_dates_read_back_wrong_are_corrected(self):
        events = [{"eventId": 1, "uuid": UUID_A, "type": "CREATE", "ms": AT, "node": "node-1"}, {"eventId": 1, "uuid": UUID_B, "type": "CREATE", "ms": AT + 30, "node": "node-2"}]
        nifi = FakeNifi("2.5.0", cluster=True, shift=14, events=events)
        out = self.query(nifi, {"op": "provenance", "field": "EventType", "value": "CREATE", **self.window()}, cluster=True)
        self.assertEqual(nifi.bodies[0]["provenance"]["request"]["searchTerms"], {"EventType": {"value": "CREATE", "inverse": False}})
        self.assertNotIn("clusterNodeId", nifi.bodies[0]["provenance"]["request"], "the cluster as a whole")
        self.assertEqual([(e["clusterNodeId"], e["clusterNodeAddress"]) for e in out["events"]], [("node-1", "localhost:18445"), ("node-2", "localhost:18446")])
        self.assertEqual([out["scope"], out["shiftedHours"]], ["cluster", 14])
        self.assertEqual(nifi.bodies[1]["provenance"]["request"]["startDate"], "11/06/2026 00:50:00 UTC", "asked again 14 h earlier")
        self.assertIn("28 h off", out["notes"][0])
        self.assertEqual([c for c in nifi.calls if c.startswith("DELETE")], [f"DELETE provenance/q0001-01a1-1000", f"DELETE provenance/q0002-01a1-1000"])
        # One node only: its events.
        nifi = FakeNifi("2.5.0", cluster=True, events=events)
        out = self.query(nifi, {"op": "provenance", "field": "EventType", "value": "CREATE", "node": "node-2", **self.window()}, cluster=True)
        self.assertEqual([e["flowFileUuid"] for e in out["events"]], [UUID_B])
        self.assertEqual([out["scope"], nifi.calls[-1]], ["node node-2", "DELETE provenance/q0001-01a1-1000?clusterNodeId=node-2"])

    def test_a_version_whose_term_form_is_not_known_gets_the_other_one(self):
        nifi = FakeNifi("1.12.1", events=[{"eventId": 0, "uuid": UUID_A, "type": "CREATE", "ms": AT}])
        real = sx.old_terms
        try:
            sx.old_terms = lambda v: False  # as if this executor thought 1.12 took {value, inverse}
            out = self.query(nifi, {"op": "provenance", "uuid": UUID_A, **self.window()})
        finally:
            sx.old_terms = real
        self.assertEqual(len(out["events"]), 1)
        self.assertIn("plain", out["notes"][0])

    def test_refusals_before_nifi_is_asked(self):
        nifi = FakeNifi()
        for request, said in [({"op": "replay"}, "op is one of"), ({"op": "provenance", "uuid": UUID_A}, "from and to are required"),
                              ({"op": "provenance", "uuid": UUID_A, "from": "2026-11-06T16:00:00Z", "to": "2026-11-06T15:00:00Z"}, "from before to"),
                              ({"op": "provenance", "uuid": "nope", **self.window()}, "FlowFile UUID"), ({"op": "provenance", **self.window()}, "give uuid, or field"),
                              ({"op": "provenance", "uuid": UUID_A, "maxResults": 101, **self.window()}, "maxResults is 1 to 100"),
                              ({"op": "provenance", "uuid": UUID_A, "node": "../x", **self.window()}, "node is a cluster node id"),
                              ({"op": "provenance", "uuid": UUID_A, "node": "node-1", **self.window()}, "only for a cluster"),
                              ({"op": "lineage", "eventId": 3, "direction": "SIDEWAYS"}, "direction is")]:
            with self.subTest(said):
                with self.assertRaisesRegex(sx.Refused, said):
                    self.query(nifi, request)
        with self.assertRaisesRegex(sx.Refused, "is not searchable"):
            self.query(nifi, {"op": "provenance", "field": "Details", "value": "x", **self.window()})
        for request in ({"op": "lineage", "uuid": UUID_A}, {"op": "event", "eventId": 1}):
            with self.assertRaisesRegex(sx.Refused, "node .* is required"):
                self.query(FakeNifi(cluster=True), request, cluster=True)
        self.assertFalse(any(c.startswith("POST") for c in nifi.calls), "nothing submitted")

    def test_polled_until_finished_and_deleted_whatever_happens(self):
        nifi = FakeNifi(events=[{"eventId": 0, "uuid": UUID_A, "type": "CREATE", "ms": AT}])
        self.query(nifi, {"op": "provenance", "uuid": UUID_A, **self.window()})
        self.assertEqual([c for c in nifi.calls if "q0001" in c], ["GET provenance/q0001-01a1-1000", "DELETE provenance/q0001-01a1-1000"])
        for kw, said in [({"never_finish": True}, "did not finish within"), ({"poll_fails": True}, "HTTP 500"), ({"big": True}, "larger than 4 MiB")]:
            with self.subTest(said):
                nifi = FakeNifi(**kw)
                with self.assertRaisesRegex(Exception, said):
                    self.query(nifi, {"op": "provenance", "uuid": UUID_A, **self.window()}, seconds=1.0)
                self.assertEqual(nifi.calls[-1], "DELETE provenance/q0001-01a1-1000")
                self.assertEqual(nifi.jobs, {})

    def test_refused_certificate_says_which_policies(self):
        with self.assertRaisesRegex(sx.Failed, "query provenance.*view provenance"):
            self.query(FakeNifi(status=403), {"op": "search-options"})

    def test_lineage_its_components_and_the_node_on_a_cluster(self):
        events = [{"eventId": 1, "uuid": UUID_A, "type": "CREATE", "ms": AT, "node": "node-1"},
                  {"eventId": 2, "uuid": UUID_A, "type": "DROP", "ms": AT + 900, "node": "node-1", "name": "Log", "ctype": "LogAttribute", "component": "c-log", "relationship": "success"}]
        nifi = FakeNifi(cluster=True, events=events)
        out = self.query(nifi, {"op": "lineage", "uuid": UUID_A, "node": "node-1"}, cluster=True)
        self.assertEqual(nifi.bodies[0], {"lineage": {"request": {"lineageRequestType": "FLOWFILE", "uuid": UUID_A, "clusterNodeId": "node-1"}}})
        self.assertEqual([(n["type"], n.get("componentName"), n["at"]) for n in out["nodes"]],
                         [("FLOWFILE", None, "2026-11-06T15:20:00.000Z"), ("EVENT", "Generate", "2026-11-06T15:20:00.000Z"), ("EVENT", "Log", "2026-11-06T15:20:00.900Z")])
        self.assertEqual(out["nodes"][2]["relationship"], "success")
        self.assertEqual([out["enriched"], len(out["links"]), out["node"]], [2, 2, "node-1"])
        self.assertIn("DELETE provenance/lineage/l0001-01a1-1000?clusterNodeId=node-1", nifi.calls)
        self.assertEqual(nifi.jobs, {})
        # An event's parents or children.
        self.query(nifi, {"op": "lineage", "eventId": 2, "direction": "PARENTS", "node": "node-1"}, cluster=True)
        self.assertEqual(nifi.bodies[-1]["lineage"]["request"], {"lineageRequestType": "PARENTS", "eventId": 2, "clusterNodeId": "node-1"})

    def test_an_event_with_its_attributes_when_nifi_shows_them_never_content(self):
        attrs = [{"name": "filename", "value": "a.csv", "previousValue": "a.csv"}, {"name": "big", "value": "x" * 10_000}]
        nifi = FakeNifi("1.12.1", events=[{"eventId": 7, "uuid": UUID_A, "type": "ATTRIBUTES_MODIFIED", "ms": AT, "attributes": attrs}, {"eventId": 8, "uuid": UUID_A, "type": "DROP", "ms": AT}])
        out = self.query(nifi, {"op": "event", "eventId": 7}, offset=8 * 3600_000)
        e = out["event"]
        self.assertEqual([e["eventId"], e["at"], e["attributes"][0]], [7, "2026-11-06T15:20:00.000Z", {"name": "filename", "value": "a.csv", "previousValue": "a.csv"}])
        self.assertEqual(len(e["attributes"][1]["value"]), sx.PROV_VALUE_MAX)
        self.assertNotIn("inputContentClaimIdentifier", e)
        self.assertTrue(self.query(nifi, {"op": "event", "eventId": 8})["event"]["attributesHidden"], "no view-the-data policy: no attributes")
        with self.assertRaisesRegex(sx.Refused, "no provenance event 99"):
            self.query(nifi, {"op": "event", "eventId": 99})

    def test_the_job_reads_the_watched_nifi_and_sends_the_answer_over_the_content_channel(self):
        api = LogApi()
        self.api = api
        ex = self.executor()
        home = self.root / "nifi"
        (home / "conf").mkdir(parents=True)
        (home / "conf" / "nifi.properties").write_text("nifi.web.https.port=18443\nnifi.web.https.host=localhost\n")
        ex.watch = sx.watch_entries([{"service": "n1", "member": "local:/opt/nifi", "installDir": str(home), "confDir": str(home / "conf"), "https": {}}])
        job = sx.ReadJob({"id": "nifi-provenance-0001", "kind": "nifi-provenance", "member": "nope", "op": "search-options"}, 30)
        with self.assertRaisesRegex(sx.Refused, "not an installation this executor watches"):
            ex.nifi_provenance(job)
        with self.assertRaisesRegex(sx.Failed, "monitor certificate"):
            ex.nifi_provenance(sx.ReadJob({**job.request, "member": "local:/opt/nifi"}, 30))
        nifi = FakeNifi()
        ex.nifi_call = lambda w, props: (nifi, props.get("nifi.cluster.is.node") == "true")
        result = ex.nifi_provenance(sx.ReadJob({**job.request, "member": "local:/opt/nifi"}, 30))
        self.assertEqual(result, {"op": "search-options", "fields": 4})
        self.assertEqual(len(json.loads(api.content[job.id])["fields"]), 4)


class ReleaseTest(Base):
    """The release: its own archive beside the deploy executor's, installed without root and upgraded like it."""

    def package(self, version, out):
        src = self.root / f"src-{version}"
        (src / "service").mkdir(parents=True)
        for f in ("service_executor.py", "executor_core.py", "bundle.py", "package.sh"):
            shutil.copy2(HERE / f, src / f)
        for f in (HERE / "service").iterdir():
            shutil.copy2(f, src / "service" / f.name)
        for f in ("deployer_executor.py", "launch.sh", "switch", "install.sh", "open-atlas-deployer-executor.service", "executor.env.example"):
            shutil.copy2(HERE / f, src / f)
        for name in ("service_executor.py", "deployer_executor.py"):
            code = (src / name).read_text()
            (src / name).write_text(code.replace(f'VERSION = "{sx.VERSION}"', f'VERSION = "{version}"', 1))
        env = dict(os.environ, PYTHON=sys.executable)
        subprocess.run(["sh", str(src / "package.sh"), str(out)], check=True, capture_output=True, env=env)
        subprocess.run(["sh", str(src / "service" / "package.sh"), str(out)], check=True, capture_output=True, env=env)
        return src

    def test_package_install_without_root_and_upgrade(self):
        import tarfile
        source = self.root / "releases-source"
        src = self.package("0.8.0", source / "executor-v0.8.0")
        out = source / "executor-v0.8.0"
        archive = out / "open-atlas-service-executor-0.8.0.tar.gz"
        with tarfile.open(archive) as tar:
            names = sorted(m.name for m in tar.getmembers() if m.isfile())
        self.assertEqual(names, sorted(f"open-atlas-service-executor-0.8.0/{f}" for f in sx.PACKAGE_FILES))
        sums = (out / "SHA256SUMS").read_text()
        self.assertIn("open-atlas-service-executor-0.8.0.tar.gz", sums)
        self.assertIn("open-atlas-deployer-executor-0.8.0.tar.gz", sums, "one release, both executors")

        # A first installation from 0.7.9 as an ordinary user (no root, no systemd, no Docker).
        old_src = self.package("0.7.9", self.root / "old-out")
        base, env_file = self.root / "base", self.root / "etc" / "service-executor.env"
        p = subprocess.run(["sh", str(old_src / "service" / "install.sh")], capture_output=True, text=True,
                           env=dict(os.environ, EXECUTOR_BASE=str(base), EXECUTOR_ENV_FILE=str(env_file), PATH=os.environ["PATH"]))
        if os.geteuid() == 0:
            self.skipTest("runs as root here: install.sh would install the systemd unit")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("not root", p.stdout)
        self.assertEqual(os.readlink(base / "current"), "releases/0.7.9")
        self.assertEqual(sorted(f.name for f in (base / "releases" / "0.7.9").iterdir()), sorted(sx.PACKAGE_FILES))
        self.assertEqual(oct(env_file.stat().st_mode & 0o777), "0o600")
        env_file.write_text("\n".join([
            "EXECUTOR_DEPLOYER_URL=https://deployer.test", f"EXECUTOR_TOKEN_FILE={self.root / 'token'}",
            f"EXECUTOR_WORK={self.root / 'work'}", f"EXECUTOR_BASE={base}", f"EXECUTOR_UPGRADE_FROM={source}", ""]))
        check = subprocess.run([sys.executable, "-I", "-B", str(base / "current" / "service_executor.py"), "check", "--env-file", str(env_file)],
                               capture_output=True, text=True, cwd=str(self.root), env={"PATH": os.environ.get("PATH", "")})
        self.assertEqual(check.returncode, 0, check.stderr)
        self.assertEqual(json.loads(check.stdout)["deployer_url"], "https://deployer.test")

        # 0.7.9 takes 0.8.0 from the same release directory; 0.8.0 starts, passes its self-check and reports success.
        old = load_module(base / "current" / "service_executor.py", "service_executor_0_7_9")
        old_ex = old.ServiceExecutor(old.config(env_file, environ=NO_ENV), out=self.devnull, api=self.api)
        self.api.queue.append({"protocol": 2, "id": "upgrade-0001", "kind": "executor-upgrade", "version": "0.8.0"})
        with self.assertRaises(old.Restarting):
            old_ex.run_once()
        self.assertEqual(os.readlink(base / "current"), "releases/0.8.0")
        new = load_module(base / "current" / "service_executor.py", "service_executor_0_8_0")
        new_ex = new.ServiceExecutor(new.config(env_file, environ=NO_ENV), out=self.devnull, api=self.api)
        new_ex.sleep = lambda s: None
        new_ex.selfcheck()
        new_ex.finish_upgrade()
        status = self.api.status["upgrade-0001"]
        self.assertEqual((status["state"], status["message"]), ("succeeded", "Executor upgraded from 0.7.9 to 0.8.0"))
        self.assertEqual((self.api.beats[-1]["executor"], self.api.beats[-1]["version"]), ("service", "0.8.0"))
        self.assertTrue(src.is_dir())


if __name__ == "__main__":
    unittest.main()
