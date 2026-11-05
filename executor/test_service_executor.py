"""Unit tests for the service executor (S18): registration without Docker, the read channel, its release.

    python3 -m unittest test_service_executor        (from executor/)
"""
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
        self.assertEqual(beat["kinds"], ["svc-discover", "svc-read", "executor-upgrade"], "the service jobs; never the deploy ones")
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


@unittest.skipUnless(all(shutil.which(c) for c in ("sh", "tar", "sha256sum")) and hasattr(os, "symlink"), "needs sh, tar, sha256sum")
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
