"""Unit tests for the service executor (S18): registration without Docker, the read channel, its release.

    python3 -m unittest test_service_executor        (from executor/)
"""
import calendar
import hashlib
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
from unittest import mock

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
        self.assertEqual(beat["kinds"], ["svc-discover", "svc-read", "svc-state", "log-read", "log-tail", "nifi-provenance", "svc-write", "executor-upgrade", "svc-discover@2", "svc-read@2", "nifi-provenance@1", "svc-state@1", "svc-write@1"],
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

    def test_an_executor_upgrade_waits_for_the_reads_in_flight(self):
        self.read("read-job-0001")
        self.ex.run_once()
        self.assertTrue(wait_until(lambda: self.ex.started))
        self.api.queue.append({"protocol": 2, "id": "upgrade-job-0001", "kind": "executor-upgrade", "version": "nonsense"})
        done = threading.Thread(target=self.ex.run_once)
        done.start()
        time.sleep(0.1)
        self.assertNotIn("upgrade-job-0001", self.api.status, "not started while the read runs")
        self.ex.gates["read-job-0001"].set()
        done.join(5)
        self.assertEqual(self.api.status["read-job-0001"]["state"], "succeeded")
        self.assertEqual(self.api.status["upgrade-job-0001"]["state"], "refused", "its version is malformed")

    def test_a_kind_this_executor_does_not_know_is_refused_without_waiting_for_the_reads(self):
        self.read("read-job-0001")
        self.ex.run_once()
        self.assertTrue(wait_until(lambda: self.ex.started))
        self.api.queue.append({"protocol": 2, "id": "other-job-0001", "kind": "no-such-kind"})
        self.ex.run_once()
        self.assertEqual(self.api.status["other-job-0001"]["state"], "refused")
        self.assertEqual(self.api.status["read-job-0001"]["state"], "running")

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


class Changer(Reader):
    """A service executor with a change job for the tests, which it can hold open."""

    CHANGE_JOBS = {"test-change": "test_change"}

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.changed = []

    def test_change(self, req, status):
        self.changed.append(req["id"])
        self.step(status, "change")
        self.log(f"changing for {req['id']}")
        self.gates.setdefault(req["id"], threading.Event()).wait(5)
        if req.get("fail"):
            raise sx.Failed("cannot change it")
        status["result"] = {"answer": req["id"]}
        self.finish(status, "succeeded", "changed")


class ChangeChannelTest(Base):
    def setUp(self):
        super().setUp()
        self.api.read_kinds = ("test-read",)
        self.ex = self.executor(Changer)
        self.addCleanup(self.release_all)

    def release_all(self):
        for job_id in [*self.ex.reads, *self.ex.changed]:
            self.ex.gates.setdefault(job_id, threading.Event()).set()
        self.ex.wait_reads()
        self.ex.wait_change()

    def change(self, job_id, **extra):
        self.api.queue.append({"protocol": 2, "id": job_id, "kind": "test-change", **extra})

    def read(self, job_id):
        self.api.queue.append({"protocol": 2, "id": job_id, "kind": "test-read"})

    def running_change(self, job_id="change-job-0001"):
        self.change(job_id)
        self.assertTrue(self.ex.run_once())
        self.assertTrue(wait_until(lambda: job_id in self.ex.changed))

    def test_the_heartbeat_names_the_change_job(self):
        self.assertIn("test-change", self.ex.KINDS)

    def test_reads_run_beside_a_change_and_a_second_change_stays_queued(self):
        self.running_change()
        self.read("read-job-0001")
        self.change("change-job-0002")
        self.assertTrue(self.ex.run_once(wait=25), "the read behind the second change is taken")
        self.assertEqual(self.api.polls[-1], (sx.CHANGE_POLL_SECONDS, "read"), "a short poll, for the next change to be taken soon after")
        self.assertTrue(wait_until(lambda: self.ex.started == ["read-job-0001"]))
        self.ex.gates["read-job-0001"].set()
        self.assertTrue(wait_until(lambda: self.api.status.get("read-job-0001", {}).get("state") == "succeeded"), "the read ends while the change runs")
        self.assertEqual(self.api.status["change-job-0001"]["state"], "running")
        self.assertFalse(self.ex.run_once(), "nothing but the second change is queued")
        self.assertEqual([j["id"] for j in self.api.queue], ["change-job-0002"], "not taken: lost in a restart here if it were")
        self.assertEqual(self.ex.changed, ["change-job-0001"])

        self.ex.gates["change-job-0001"].set()
        self.ex.wait_change()
        self.assertEqual((self.api.status["change-job-0001"]["state"], self.api.status["change-job-0001"]["result"]), ("succeeded", {"answer": "change-job-0001"}))
        self.assertIn("changing for change-job-0001", self.api.logs["change-job-0001"])
        self.assertTrue(self.ex.run_once())
        self.assertEqual(self.api.polls[-1][1], None, "no change runs: anything may come")
        self.assertTrue(wait_until(lambda: "change-job-0002" in self.ex.changed))

    def test_the_log_of_a_read_stays_out_of_the_changes(self):
        self.running_change()
        self.read("read-job-0001")
        self.ex.run_once()
        self.assertTrue(wait_until(lambda: self.ex.started))
        self.release_all()
        self.assertNotIn("reading for", self.api.logs["change-job-0001"])
        self.assertNotIn("changing for", self.api.logs["read-job-0001"])

    def test_every_heartbeat_says_the_change_while_it_runs(self):
        self.running_change()
        self.ex.heartbeat()
        self.assertEqual(self.api.beats[-1]["busy"], "change-job-0001")
        self.release_all()
        self.ex.heartbeat()
        self.assertIsNone(self.api.beats[-1]["busy"])

    def test_a_failed_change_says_so_and_the_loop_goes_on(self):
        self.change("change-job-0001", fail=True)
        self.ex.run_once()
        self.assertTrue(wait_until(lambda: self.ex.changed))
        self.release_all()
        self.assertEqual((self.api.status["change-job-0001"]["state"], self.api.status["change-job-0001"]["message"]), ("failed", "cannot change it"))
        self.assertFalse(self.ex.changing())
        self.assertFalse(self.ex.current_marker().exists())

    def test_an_executor_upgrade_is_not_taken_beside_a_change(self):
        self.running_change()
        self.api.queue.append({"protocol": 2, "id": "upgrade-job-0001", "kind": "executor-upgrade", "version": "9.9.9"})
        self.assertFalse(self.ex.run_once())
        self.assertEqual([j["id"] for j in self.api.queue], ["upgrade-job-0001"])
        self.assertNotIn("upgrade-job-0001", self.api.status)

    def test_a_deployer_that_ignores_only_read_cannot_start_another_job_beside_a_change(self):
        self.running_change()
        self.api.read_kinds = ("test-read", "test-change", "executor-upgrade")
        self.change("change-job-0002")
        self.api.queue.append({"protocol": 2, "id": "upgrade-job-0001", "kind": "executor-upgrade", "version": "9.9.9"})
        self.ex.run_once()
        self.ex.run_once()
        self.assertEqual(self.ex.changed, ["change-job-0001"])
        self.assertEqual([self.api.status["change-job-0002"]["state"], self.api.status["upgrade-job-0001"]["state"]], ["refused", "refused"])
        self.assertIn("change-job-0001", self.api.status["upgrade-job-0001"]["message"])
        self.assertEqual(json.loads(self.ex.current_marker().read_text())["id"], "change-job-0001", "the running change's marker is its own")
        self.assertEqual(self.api.status["change-job-0001"]["state"], "running")

    def test_a_restart_during_a_change_says_it_was_interrupted_on_the_next_start(self):
        self.running_change()
        again = self.executor(Changer)  # the process is gone; its marker is what is left of the change
        again.recover()
        status = self.api.status["change-job-0001"]
        self.assertEqual((status["state"], status["message"]), ("failed", again.INTERRUPTED))
        self.assertFalse(again.current_marker().exists())
        self.assertFalse(again.changing(), "not run again")

    def test_a_restart_during_a_change_with_the_deployer_down_says_it_once_the_deployer_answers(self):
        self.running_change()
        again = self.executor(Changer)
        self.api.down = True
        again.recover()
        self.assertEqual(self.api.status["change-job-0001"]["state"], "running")
        self.assertFalse(again.current_marker().exists())
        self.api.down = False
        again.deliver_pending()
        self.assertEqual(self.api.status["change-job-0001"]["state"], "failed")

    def test_a_kept_status_of_the_running_change_cannot_overtake_a_newer_one(self):
        self.running_change()
        self.ex.keep_pending({"id": "change-job-0001", "state": "running", "steps": ["old"]})
        self.ex.deliver_pending()
        self.assertNotIn("old", self.api.status["change-job-0001"]["steps"], "left to the change")
        self.ex.gates["change-job-0001"].set()
        self.ex.wait_change()
        self.assertEqual(self.api.status["change-job-0001"]["state"], "succeeded")
        self.assertEqual(list((self.root / "work" / "pending").glob("*.json")), [], "taken with the newer status")

    def test_a_final_status_kept_while_the_deployer_is_down_is_sent_once_the_change_has_ended(self):
        self.running_change()
        self.ex.status_tries = 1
        self.api.down = True
        self.ex.gates["change-job-0001"].set()
        self.ex.wait_change()
        self.assertEqual(self.api.status["change-job-0001"]["state"], "running")
        self.api.down = False
        self.ex.deliver_pending()
        self.assertEqual(self.api.status["change-job-0001"]["state"], "succeeded")
        self.assertIn("changing for change-job-0001", self.api.logs["change-job-0001"])


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

    # --- svc-state (§16.3) ---

    def state_entry(self, w):
        conf = pathlib.Path(w["confDir"])
        return sx.watch_entries([{**w, "files": [{"name": "nifi.properties", "path": str(conf / "nifi.properties")}, {"name": "bootstrap.conf", "path": str(conf / "bootstrap.conf")}]}])[0]

    @staticmethod
    def limits(soft=1024, hard=4096, processes="unlimited"):
        return ("Limit                     Soft Limit           Hard Limit           Units     \n"
                f"Max cpu time              unlimited            unlimited            seconds   \n"
                f"Max processes             {processes}            {processes}            processes \n"
                f"Max open files            {soft}                 {hard}                 files     \n")

    def test_svc_state_of_a_cluster_node_has_its_processes_limits_files_and_the_nodes(self):
        (self.proc.root / "4000" / "limits").write_text(self.limits())
        (self.proc.root / "4001" / "limits").write_text(self.limits(4096, 4096))
        (self.proc.root / "4000" / "stat").write_text("4000 (java) S 1 " + " ".join(["0"] * 17) + " 400 0 0\n")
        (self.proc.root / "4001" / "stat").write_text("4001 (java) S 4000 " + " ".join(["0"] * 17) + " 800 0 0\n")
        os.chmod(self.c250 / "conf" / "nifi.properties", 0o640)
        out = self.collector().state(self.state_entry(self.entry("c250", self.c250, https=18445, node="localhost")))
        tick = os.sysconf("SC_CLK_TCK")
        self.assertEqual(out["process"], {"running": True, "pid": 4001, "startedAt": sx.iso_at(1700000000 + 800 / tick), "bootstrapPid": 4000,
                                          "bootstrapStartedAt": sx.iso_at(1700000000 + 400 / tick), "user": sx.user_name(os.geteuid())})
        self.assertEqual(out["limits"], {"nofile": {"soft": 1024, "hard": 4096}, "nproc": {"soft": "unlimited", "hard": "unlimited"}}, "the bootstrap's")
        rest = out["rest"]
        self.assertEqual((rest["state"], rest["invalidCount"], rest["url"]), ("ok", 0, "https://localhost:18445"))
        self.assertEqual([(n["apiPort"], n["address"], n["status"], n["roles"]) for n in rest["cluster"]["nodes"]],
                         [(18445, "localhost", "CONNECTED", ["Primary Node", "Cluster Coordinator"]), (18446, "localhost", "CONNECTED", [])])
        self.assertEqual(sorted(rest["cluster"]["nodes"][0]), ["address", "apiPort", "nodeId", "roles", "status"])
        self.assertEqual(rest["cluster"]["self"], rest["cluster"]["nodes"][0]["nodeId"], "by address and HTTPS port")
        props = next(f for f in out["files"] if f["name"] == "nifi.properties")
        self.assertEqual(props["sha256"], hashlib.sha256((self.c250 / "conf" / "nifi.properties").read_bytes()).hexdigest())
        self.assertEqual((props["owner"], props["mode"]), (sx.user_name(os.geteuid()), "0640"))
        self.assertIn("group", props)
        self.assertIn("label", props)

    def test_svc_state_of_the_standalones_has_no_nodes(self):
        for name, home, port in (("n112", self.n112, 18443), ("n200", self.n200, 18444)):
            c = self.collector()
            out = c.state(self.state_entry(self.entry(name, home, https=port)))
            self.assertEqual((out["process"]["running"], out["rest"]["state"], out["rest"]["invalidCount"]), (True, "ok", 0), name)
            self.assertNotIn("cluster", out["rest"], name)
            self.assertEqual([call[3] for call in c.calls], ["flow/status"], "only what it needs")

    def test_svc_state_of_a_stopped_nifi_calls_nothing(self):
        c = self.collector()
        out = c.state(self.state_entry(self.entry("c250", self.stopped, https=18446)))
        self.assertEqual(out["process"], {"running": False, "pid": None, "startedAt": None, "bootstrapPid": None, "bootstrapStartedAt": None, "user": None})
        self.assertEqual((out["environment"], out["environmentDropped"], out["limits"], out["rest"]), (None, [], None, {"state": "not-running"}))
        self.assertEqual(c.calls, [])
        self.assertEqual([("sha256" in f, "owner" in f) for f in out["files"]], [(True, True), (True, True)], "the files are still there to compare")
        (self.stopped / "conf" / "bootstrap.conf").unlink()
        self.assertEqual(c.state(self.state_entry(self.entry("c250", self.stopped, https=18446)))["files"][1].get("missing"), True)

    def test_svc_state_when_the_rest_api_does_not_answer_or_answers_with_an_error(self):
        entry = self.state_entry(self.entry("c250", self.c250, https=18445, node="localhost"))
        c = self.collector()
        c.down.add(18445)
        rest = c.state(entry)["rest"]
        self.assertEqual((rest["state"], rest["url"]), ("unreachable", "https://localhost:18445"))
        self.assertTrue(rest["error"])

        c = self.collector()
        c.fetch = lambda ctx, connect, port, sni, path, timeout: (409, b"Cluster is still in the process of voting on the appropriate Data Flow.")
        rest = c.state(entry)["rest"]
        self.assertEqual((rest["state"], rest["invalidCount"]), ("partial", None))
        self.assertTrue(rest["errors"]["cluster"].startswith("HTTP 409: Cluster is still"), "an answer to wait on, not a failure")
        self.assertNotIn("cluster", rest)

        c = self.collector()
        c.context = lambda: (None, "no monitor certificate")
        self.assertEqual(c.state(entry)["rest"], {"state": "no-certificate", "error": "no monitor certificate"})

    def test_svc_state_filters_the_start_environment_as_the_deployer_does(self):
        # The same variables as test/services.test.ts "the start environment keeps what starting NiFi needs".
        env = {"PATH": "/usr/bin", "HOME": "/home/nifi", "JAVA_HOME": "/opt/jdk", "LC_ALL": "C.UTF-8", "NIFI_HOME": "/opt/nifi", "TZ": "Asia/Shanghai",
               "WSL_INTEROP": "/run/WSL/1_interop", "DISPLAY": ":0", "XDG_RUNTIME_DIR": "/run/user/1000", "SSH_AUTH_SOCK": "/tmp/x", "SHLVL": "1",
               "NIFI_SENSITIVE_PROPS_KEY": "abc", "NIFI_TOKEN": "(hidden)", "JAVA_OPTS": "-Djavax.net.ssl.keyStorePassword=s3cret", "NIFI_PID_DIR": "(hidden)"}
        kept, dropped = sx.filter_start_environment(env)
        self.assertEqual(kept, {"PATH": "/usr/bin", "HOME": "/home/nifi", "JAVA_HOME": "/opt/jdk", "LC_ALL": "C.UTF-8", "NIFI_HOME": "/opt/nifi", "TZ": "Asia/Shanghai"})
        self.assertEqual(dropped, ["DISPLAY", "JAVA_OPTS", "NIFI_PID_DIR", "NIFI_SENSITIVE_PROPS_KEY", "NIFI_TOKEN", "SHLVL", "SSH_AUTH_SOCK", "WSL_INTEROP", "XDG_RUNTIME_DIR"])
        self.assertEqual(sx.filter_start_environment(None), (None, []))

        (self.proc.root / "4000" / "environ").write_bytes(b"\0".join(f"{k}={v}".encode() for k, v in env.items()) + b"\0")
        out = self.collector().state(self.state_entry(self.entry("c250", self.c250, https=18445, node="localhost")))
        self.assertEqual((out["environment"], out["environmentDropped"]), (kept, dropped))
        self.assertNotIn("s3cret", json.dumps(out), "its status is kept as it is")

    def test_svc_state_says_the_label_where_there_is_one_and_never_fails_without_one(self):
        path = str(self.c250 / "conf" / "nifi.properties")
        with mock.patch.object(sx.os, "getxattr", return_value=b"system_u:object_r:usr_t:s0\0", create=True) as getxattr:
            self.assertEqual(sx.file_attributes(path)["label"], "system_u:object_r:usr_t:s0")
        getxattr.assert_called_once_with(path, "security.selinux")
        with mock.patch.object(sx.os, "getxattr", side_effect=OSError(61, "No data available"), create=True):
            self.assertIsNone(sx.file_attributes(path)["label"])

    def test_svc_state_as_a_job_on_the_read_channel(self):
        test = self

        class Lab(sx.ServiceExecutor):
            def make_collector(self):
                return test.collector()

        ex = self.executor(Lab)
        self.assertTrue({"svc-state", "svc-state@1"} <= set(ex.KINDS))
        self.api.watch = [self.entry("c250", self.c250, https=18445, node="localhost")]
        ex.heartbeat()
        member = ex.watch[0]["member"]
        self.api.queue += [{"protocol": 2, "id": "svc-state-0001", "kind": "svc-state", "member": member, "change": "change-1", "expiresAt": "2026-11-09T00:00:00Z"},
                           {"protocol": 2, "id": "svc-state-0002", "kind": "svc-state", "member": "local:/somewhere/else"}]
        ex.run_once()
        ex.run_once()
        ex.wait_reads()
        done = self.api.status["svc-state-0001"]
        self.assertEqual((done["state"], done["result"]["member"], done["result"]["process"]["pid"]), ("succeeded", member, 4001))
        self.assertEqual(self.api.status["svc-state-0002"]["state"], "refused")
        self.assertIn("REST: ok", self.api.logs["svc-state-0001"])

    def test_svc_state_when_the_processes_cannot_be_read_fails_rather_than_says_not_running(self):
        c = sx.Collector(cfg(self.root), proc=self.root / "no-proc", uid=os.geteuid())
        with self.assertRaises(OSError):
            c.state(self.state_entry(self.entry("c250", self.c250, https=18445)))

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

    def test_the_sample_carries_each_files_fingerprint_not_its_content(self):
        conf = self.n200 / "conf"
        props = conf / "nifi.properties"
        entry = {**self.entry("n200", self.n200), "files": [
            {"name": "nifi.properties", "path": str(props)}, {"name": "authorizers.xml", "path": str(conf / "authorizers.xml")},
            {"name": "not-ours.txt", "path": str(props)}, {"name": "bootstrap.conf", "path": "relative"}]}
        watch = sx.watch_entries([entry])
        self.assertEqual([f["name"] for f in watch[0]["files"]], ["nifi.properties", "authorizers.xml"], "only known names at absolute paths")
        c = self.collector()
        (conf / "authorizers.xml").unlink(missing_ok=True)
        files = c.round(watch)[0]["files"]
        self.assertEqual(files[0], {"name": "nifi.properties", "path": str(props), "sha256": hashlib.sha256(props.read_bytes()).hexdigest()})
        self.assertEqual(files[1], {"name": "authorizers.xml", "path": str(conf / "authorizers.xml"), "missing": True})
        self.assertNotIn("wrong", json.dumps(files), "no content goes out")
        # A comment at the end shows; putting the file back with its old mtime shows too.
        original, st = props.read_bytes(), props.stat()
        with open(props, "ab") as f:
            f.write(b"# a comment\n")
        changed = c.round(watch)[0]["files"][0]["sha256"]
        self.assertEqual(changed, hashlib.sha256(props.read_bytes()).hexdigest())
        self.assertNotEqual(changed, files[0]["sha256"])
        props.write_bytes(original)
        os.utime(props, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(c.round(watch)[0]["files"][0]["sha256"], files[0]["sha256"])

    def test_a_file_is_hashed_again_only_when_it_changes(self):
        props = self.n200 / "conf" / "nifi.properties"
        c = self.collector()
        f = {"name": "nifi.properties", "path": str(props)}
        first = c.fingerprint(f)
        real, opened = sx.hashlib.sha256, []
        with mock.patch.object(sx.hashlib, "sha256", side_effect=lambda *a: opened.append(1) or real(*a)):
            self.assertEqual(c.fingerprint(f), first)
            self.assertEqual(opened, [], "the same stat: not read again")
            # Same size and mtime, other bytes: ctime tells (it ticks every few milliseconds, so wait out this tick).
            st = props.stat()
            time.sleep(0.05)
            data = props.read_bytes()
            props.write_bytes(data[:-1] + (b"x" if data[-1:] != b"x" else b"y"))
            os.utime(props, ns=(st.st_atime_ns, st.st_mtime_ns))
            self.assertNotEqual(c.fingerprint(f)["sha256"], first["sha256"])

    def test_an_unreadable_file_says_so_and_the_sample_goes_on(self):
        props = self.n200 / "conf" / "nifi.properties"
        c = self.collector()
        with mock.patch("builtins.open", side_effect=PermissionError(13, "Permission denied")):
            out = c.fingerprint({"name": "nifi.properties", "path": str(props)})
        self.assertEqual(out, {"name": "nifi.properties", "path": str(props), "error": "Permission denied"})

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


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FakeXattrs:
    """What the kernel keeps on a file for names a test user cannot set, by inode, as on a machine with SELinux: the
    temporary file's label stays with it when it takes the file's place. The rest goes to the real calls."""

    NAMES = (sx.XATTR_LABEL, sx.XATTR_ACL)

    def __init__(self, test, selinux=True):
        self.values, self.refuse, self.real = {}, set(), (os.getxattr, os.setxattr, os.listxattr)
        marker = test.root / "enforce"
        marker.write_text("1")
        for patch in (mock.patch.object(os, "getxattr", self.getxattr), mock.patch.object(os, "setxattr", self.setxattr),
                      mock.patch.object(os, "listxattr", self.listxattr),
                      mock.patch.object(sx, "SELINUX_ENFORCE", str(marker) if selinux else str(test.root / "no-selinux"))):
            patch.start()
            test.addCleanup(patch.stop)

    @staticmethod
    def inode(target):
        return os.stat(target).st_ino

    def set(self, path, name, value):
        self.values[(self.inode(path), name)] = value

    def get(self, path, name):
        return self.values.get((self.inode(path), name))

    def getxattr(self, target, name, **kw):
        if name not in self.NAMES:
            return self.real[0](target, name, **kw)
        value = self.values.get((self.inode(target), name))
        if value is None:
            raise OSError(61, "No data available")
        return value

    def setxattr(self, target, name, value, *a, **kw):
        if name not in self.NAMES:
            return self.real[1](target, name, value, *a, **kw)
        if name in self.refuse:
            raise PermissionError(13, "Permission denied")
        self.values[(self.inode(target), name)] = value

    def listxattr(self, target=None, **kw):
        return [*self.real[2](target, **kw), *(n for (i, n) in self.values if i == self.inode(target))]


class SvcWriteTest(Base):
    OLD = b"# a comment\nnifi.web.https.port=9443\nnifi.flow.configuration.file=./conf/flow.xml.gz\nnifi.sensitive.props.key=OLD-SECRET-VALUE\n"
    NEW = b"# a comment\nnifi.web.https.port=9443\nnifi.flow.configuration.file=./conf/flow.xml.gz\nnifi.sensitive.props.key=NEW-SECRET-VALUE\n"
    LOGBACK = b"<configuration/>\n"
    LOGBACK_NEW = b"<configuration scan='true'/>\n"
    FLOW = b"\x1f\x8bthe flow\n"

    def setUp(self):
        super().setUp()
        self.out = self.root / "out.txt"
        self.outside = self.root / "outside"
        self.outside.mkdir()
        self.install = self.root / "nifi"
        self.conf = self.install / "conf"
        self.conf.mkdir(parents=True)
        self.props = self.conf / "nifi.properties"
        self.logback = self.conf / "logback.xml"
        self.bootstrap = self.conf / "bootstrap.conf"
        self.flow = self.conf / "flow.xml.gz"
        self.props.write_bytes(self.OLD)
        self.props.chmod(0o604)
        self.logback.write_bytes(self.LOGBACK)
        self.bootstrap.write_bytes(b"java=java\n")
        self.flow.write_bytes(self.FLOW)
        self.watch_entry = {"service": "s1", "member": "local:nifi", "installDir": str(self.install), "confDir": str(self.conf), "files": [
            {"name": "nifi.properties", "path": str(self.props)}, {"name": "logback.xml", "path": str(self.logback)},
            {"name": "bootstrap.conf", "path": str(self.bootstrap)}]}
        self.stream = open(self.out, "w")
        self.addCleanup(self.stream.close)
        self.api = WatchApi()
        self.api.watch = [self.watch_entry]
        self.ex = sx.ServiceExecutor(cfg(self.root), out=self.stream, api=self.api)
        self.ex.sleep = lambda s: None
        self.ex.watch = sx.watch_entries(self.api.watch)
        self.jobs = 0

    def job(self, action, files=None, content=None, change="change-1", member="local:nifi", raw_content=None, **extra):
        self.jobs += 1
        job_id = f"write-job-{self.jobs:04}"
        request = {"protocol": 2, "id": job_id, "kind": "svc-write", "action": action, "change": change, "member": member, **extra}
        if files is not None:
            request["files"] = files
        if content is not None:
            request["content"] = json.dumps({"files": [{"name": k, "base64": sx.base64.b64encode(v).decode()} for k, v in content.items()]})
        if raw_content is not None:
            request["content"] = raw_content
        self.ex.handle(request)
        return self.api.status[job_id]

    def entry(self, path, data, base=None, name=None):
        return {"name": name or path.name, "path": str(path), "baseSha256": sha(base) if base is not None else None, "sha256": sha(data)}

    def apply(self, **extra):
        return self.job("apply", [self.entry(self.props, self.NEW, self.OLD)], {"nifi.properties": self.NEW}, **extra)

    def apply_two(self, **extra):
        files = [self.entry(self.props, self.NEW, self.OLD), self.entry(self.logback, self.LOGBACK_NEW, self.LOGBACK)]
        return self.job("apply", files, {"nifi.properties": self.NEW, "logback.xml": self.LOGBACK_NEW}, **extra)

    def backup_dir(self, change="change-1"):
        return self.root / "work" / "backups" / sha(b"local:nifi")[:16] / change

    def snapshot(self, *dirs):
        """Names, content, inode and mtime of what is in the directories."""
        out = {}
        for d in dirs or (self.conf,):
            for p in sorted(pathlib.Path(d).rglob("*")):
                st = p.lstat()
                out[str(p)] = (p.read_bytes() if p.is_file() and not p.is_symlink() else None, st.st_ino, st.st_mtime_ns, st.st_mode)
        return out

    def assert_no_temp(self, *dirs):
        for d in dirs or (self.conf,):
            self.assertEqual([p.name for p in pathlib.Path(d).iterdir() if p.name.endswith(sx.WRITE_TEMP)], [])

    # --- apply ---

    def test_the_kind_and_its_first_form_are_in_the_heartbeat(self):
        self.assertIn("svc-write", self.ex.KINDS)
        self.assertIn("svc-write@1", self.ex.KINDS)

    def test_apply_replaces_the_file_atomically_and_keeps_its_mode(self):
        inode = self.props.stat().st_ino
        done = self.apply()
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(self.props.read_bytes(), self.NEW)
        self.assertNotEqual(self.props.stat().st_ino, inode, "a new file took its place, nothing was written in place")
        self.assertEqual(oct(self.props.stat().st_mode & 0o7777), "0o604")
        file = done["result"]["files"][0]
        self.assertEqual((file["name"], file["before"], file["after"], file["mode"], file["label"]), ("nifi.properties", sha(self.OLD), sha(self.NEW), "0604", None))
        self.assert_no_temp()

    def test_apply_backs_up_first_in_a_private_directory(self):
        self.apply()
        d = self.backup_dir()
        self.assertEqual(oct(d.stat().st_mode & 0o777), "0o700")
        self.assertEqual((d / "nifi.properties").read_bytes(), self.OLD)
        self.assertEqual(oct((d / "nifi.properties").stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct((d / "manifest.json").stat().st_mode & 0o777), "0o600")
        entry = json.loads((d / "manifest.json").read_text())["entries"][0]
        st = self.props.stat()
        self.assertEqual((entry["path"], entry["sha256"], entry["uid"], entry["gid"], entry["mode"], entry["existed"]),
                         (str(self.props), sha(self.OLD), st.st_uid, st.st_gid, 0o604, True))

    def test_apply_keeps_user_attributes(self):
        try:
            os.setxattr(self.props, "user.owner-note", b"kept")
        except OSError:
            self.skipTest("this file system has no user attributes")
        self.apply()
        self.assertEqual(os.getxattr(self.props, "user.owner-note"), b"kept")

    def test_apply_gives_the_owner_of_the_file(self):
        others = [g for g in os.getgroups() if g != self.props.stat().st_gid]
        if not others:
            self.skipTest("this user has no second group")
        os.chown(self.props, -1, others[0])
        done = self.apply()
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(self.props.stat().st_gid, others[0])
        self.assertEqual(self.props.stat().st_uid, os.getuid())

    def test_an_owner_that_cannot_be_kept_fails_and_leaves_the_file(self):
        with mock.patch.object(os, "fchown", side_effect=PermissionError(1, "Operation not permitted")):
            done = self.apply()
        self.assertEqual(done["state"], "failed")
        self.assertIn("owner", done["message"])
        self.assertEqual(self.props.read_bytes(), self.OLD)
        self.assert_no_temp()

    def test_a_new_file_gets_the_owner_of_nifi_properties_and_0640(self):
        target = self.conf / "state-management.xml"
        done = self.job("apply", [self.entry(target, b"<x/>\n")], {"state-management.xml": b"<x/>\n"})
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(oct(target.stat().st_mode & 0o777), "0o640")
        self.assertEqual(target.stat().st_uid, self.props.stat().st_uid)
        self.assertIsNone(done["result"]["files"][0]["before"])

    def test_several_files_and_a_symbolic_link_replaces_what_it_points_to(self):
        real = self.conf / "kept" / "logback-real.xml"
        real.parent.mkdir()
        self.logback.rename(real)
        self.logback.symlink_to(real)
        self.assertEqual(self.apply_two()["state"], "succeeded")
        self.assertTrue(self.logback.is_symlink(), "the link stays")
        self.assertEqual(real.read_bytes(), self.LOGBACK_NEW)
        self.assertEqual(self.props.read_bytes(), self.NEW)
        self.assert_no_temp(real.parent)

    # --- SELinux (a fake of the kernel's side: no machine here has it, §16.2 P14) ---

    def test_the_label_and_the_acl_stay_with_the_file(self):
        fake = FakeXattrs(self)
        fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:nifi_conf_t:s0\0")
        fake.set(self.props, sx.XATTR_ACL, b"an acl")
        done = self.apply()
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(fake.get(self.props, sx.XATTR_LABEL), b"system_u:object_r:nifi_conf_t:s0\0")
        self.assertEqual(fake.get(self.props, sx.XATTR_ACL), b"an acl")
        self.assertEqual(done["result"]["files"][0]["label"], "system_u:object_r:nifi_conf_t:s0")
        entry = json.loads((self.backup_dir() / "manifest.json").read_text())["entries"][0]
        self.assertEqual(sx.base64.b64decode(entry["xattrs"][sx.XATTR_LABEL]), b"system_u:object_r:nifi_conf_t:s0\0")

    def test_a_new_file_takes_the_label_of_nifi_properties(self):
        fake = FakeXattrs(self)
        fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:nifi_conf_t:s0")
        fake.set(self.props, sx.XATTR_ACL, b"not for a new file")
        target = self.conf / "state-management.xml"
        self.assertEqual(self.job("apply", [self.entry(target, b"<x/>\n")], {"state-management.xml": b"<x/>\n"})["state"], "succeeded")
        self.assertEqual(fake.get(target, sx.XATTR_LABEL), b"system_u:object_r:nifi_conf_t:s0")
        self.assertIsNone(fake.get(target, sx.XATTR_ACL))

    def test_with_selinux_on_a_label_that_cannot_be_set_stops_the_replacement(self):
        fake = FakeXattrs(self)
        fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:nifi_conf_t:s0")
        fake.refuse.add(sx.XATTR_LABEL)
        inode = self.props.stat().st_ino
        done = self.apply()
        self.assertEqual(done["state"], "failed")
        self.assertIn(sx.XATTR_LABEL, done["message"])
        self.assertEqual((self.props.read_bytes(), self.props.stat().st_ino), (self.OLD, inode))
        self.assert_no_temp()

    def test_with_selinux_on_a_file_without_a_label_is_not_replaced(self):
        FakeXattrs(self)
        done = self.apply()
        self.assertEqual(done["state"], "failed")
        self.assertIn("no label", done["message"])
        self.assertEqual(self.props.read_bytes(), self.OLD)

    def test_with_selinux_off_a_leftover_label_does_not_matter(self):
        fake = FakeXattrs(self, selinux=False)
        fake.set(self.props, sx.XATTR_LABEL, b"left:over:t:s0")
        fake.refuse.add(sx.XATTR_LABEL)
        self.assertEqual(self.apply()["state"], "succeeded")
        self.assertEqual(self.props.read_bytes(), self.NEW)

    def test_the_label_read_back_differs_and_the_file_goes_back(self):
        fake = FakeXattrs(self)
        fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:nifi_conf_t:s0")
        real_replace = os.replace
        calls = []

        def relabelled(src, dst, **kw):
            real_replace(src, dst, **kw)
            calls.extend(["replaced"] if "src_dir_fd" in kw else [])
            if len(calls) == 1 and "src_dir_fd" in kw:  # the policy gives the new file another type once it is in place
                fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:etc_t:s0")

        with mock.patch.object(os, "replace", relabelled):
            done = self.apply()
        self.assertEqual(done["state"], "failed")
        self.assertIn("every file is back", done["message"])
        self.assertEqual(self.props.read_bytes(), self.OLD)
        self.assertEqual(fake.get(self.props, sx.XATTR_LABEL), b"system_u:object_r:nifi_conf_t:s0")

    # --- where it may write ---

    def assert_refused(self, done, text=None):
        self.assertEqual(done["state"], "refused", done.get("message"))
        if text:
            self.assertIn(text, done["message"])

    def test_a_path_with_dots_is_refused(self):
        before = self.snapshot(self.conf, self.outside)
        for path in (f"{self.conf}/../../outside/nifi.properties", f"{self.conf}/../conf/nifi.properties", "conf/nifi.properties", f"{self.props}\0"):
            self.assert_refused(self.job("apply", [{**self.entry(self.props, self.NEW, self.OLD), "path": path}], {"nifi.properties": self.NEW}), "plain absolute path")
        self.assertEqual(self.snapshot(self.conf, self.outside), before)

    def test_a_path_that_is_not_where_the_file_is_registered_is_refused(self):
        other = self.outside / "nifi.properties"
        other.write_bytes(self.OLD)
        for path in (other, self.conf / "elsewhere.properties", self.logback):
            self.assert_refused(self.job("apply", [{**self.entry(self.props, self.NEW, self.OLD), "path": str(path)}], {"nifi.properties": self.NEW}), "not where")
        self.assertEqual(other.read_bytes(), self.OLD)

    def test_a_name_outside_the_list_is_refused(self):
        for name in ("flow.xml.gz", "keystore.pkcs12", "../nifi.properties", None, ["nifi.properties"]):
            self.assert_refused(self.job("apply", [{**self.entry(self.props, self.NEW, self.OLD), "name": name}], {"x": self.NEW}), "names among")

    def test_a_symbolic_link_leading_out_is_refused_and_what_it_points_to_stays(self):
        secret = self.outside / "elsewhere"
        secret.write_bytes(self.OLD)
        self.props.unlink()
        self.props.symlink_to(secret)
        self.assert_refused(self.apply(), "leads outside")
        self.assertEqual(secret.read_bytes(), self.OLD)
        self.assertTrue(self.props.is_symlink())

    def test_a_registered_path_through_a_directory_link_leading_out_is_refused(self):
        linked = self.conf / "linked"
        linked.symlink_to(self.outside)
        (self.outside / "logback.xml").write_bytes(self.LOGBACK)
        self.watch_entry["files"][1]["path"] = str(linked / "logback.xml")
        self.assert_refused(self.job("apply", [self.entry(linked / "logback.xml", self.LOGBACK_NEW, self.LOGBACK)], {"logback.xml": self.LOGBACK_NEW}), "leads outside")
        self.assertEqual((self.outside / "logback.xml").read_bytes(), self.LOGBACK)

    def test_a_bootstrap_conf_beside_the_conf_directory_may_be_written_but_not_a_link_out_of_it(self):
        moved = self.root / "deploy" / "conf"
        moved.mkdir(parents=True)
        self.props.rename(moved / "nifi.properties")
        self.watch_entry.update(confDir=str(moved), files=[{"name": "nifi.properties", "path": str(moved / "nifi.properties")}, {"name": "bootstrap.conf", "path": str(self.bootstrap)}])
        new = b"java=java\nrun.as=\n"
        boot = self.entry(self.bootstrap, new, b"java=java\n")
        self.assertEqual(self.job("apply", [boot], {"bootstrap.conf": new})["state"], "succeeded")
        self.assertEqual(self.bootstrap.read_bytes(), new)

        secret = self.outside / "elsewhere.conf"
        secret.write_bytes(new)
        self.bootstrap.unlink()
        self.bootstrap.symlink_to(secret)
        self.assert_refused(self.job("apply", [self.entry(self.bootstrap, b"x\n", new)], {"bootstrap.conf": b"x\n"}, change="change-2"), "leads outside")
        self.assertEqual(secret.read_bytes(), new)

    def test_a_link_put_in_place_after_the_path_was_checked_is_not_followed(self):
        """Another user of the conf directory swaps the file for a link between the check and the job's work."""
        secret = self.outside / "shadow"
        secret.write_bytes(self.OLD)
        writer = sx.ConfigWriter(self.root / "work", self.watch_entry, "change-1")
        t = writer.target("nifi.properties", str(self.props))
        self.props.unlink()
        self.props.symlink_to(secret)
        with self.assertRaises(sx.Refused):
            writer.current(t)

    def test_a_directory_swapped_for_a_link_after_the_path_was_checked_is_not_followed(self):
        writer = sx.ConfigWriter(self.root / "work", self.watch_entry, "change-1")
        t = writer.target("nifi.properties", str(self.props))
        self.conf.rename(self.root / "conf-away")
        self.conf.symlink_to(self.outside)
        with self.assertRaises(OSError):
            writer.current(t)

    def test_what_is_not_a_regular_file_is_refused(self):
        self.props.unlink()
        self.props.mkdir()
        self.assert_refused(self.apply(), "not a regular file")

    def test_a_member_this_executor_does_not_watch_is_refused(self):
        self.assert_refused(self.apply(member="local:other"), "not an installation")
        self.api.watch = None
        self.assert_refused(self.apply(), "not an installation")

    def test_a_change_id_that_is_not_a_plain_name_is_refused(self):
        for change in ("../../etc", "a/b", "", None, "."):
            self.assert_refused(self.apply(change=change), "change")
        self.assertFalse((self.root / "work" / "backups").exists())

    def test_an_unknown_action_is_refused(self):
        self.assert_refused(self.job("replace-everything"), "action")

    def test_two_entries_for_one_file_are_refused(self):
        self.logback.unlink()
        self.logback.symlink_to(self.props)
        files = [self.entry(self.props, self.NEW, self.OLD), self.entry(self.logback, self.NEW, self.OLD)]
        self.assert_refused(self.job("apply", files, {"nifi.properties": self.NEW, "logback.xml": self.NEW}), "twice")

    # --- hashes ---

    def test_a_file_changed_since_the_plan_is_refused_and_not_backed_up(self):
        self.props.write_bytes(b"changed by hand\n")
        done = self.apply()
        self.assert_refused(done, "changed since the plan")
        self.assertIn(sha(b"changed by hand\n"), done["message"])
        self.assertEqual(self.props.read_bytes(), b"changed by hand\n")
        self.assertFalse(self.backup_dir().exists())

    def test_null_base_means_there_was_no_such_file(self):
        self.assert_refused(self.job("apply", [self.entry(self.props, self.NEW)], {"nifi.properties": self.NEW}), "changed since the plan")
        self.assertEqual(self.props.read_bytes(), self.OLD)

    def test_a_file_gone_since_the_plan_is_refused(self):
        self.props.unlink()
        self.assert_refused(self.apply(), "changed since the plan")

    def test_a_base_left_out_is_refused(self):
        entry = self.entry(self.props, self.NEW, self.OLD)
        del entry["baseSha256"]
        self.assert_refused(self.job("apply", [entry], {"nifi.properties": self.NEW}), "baseSha256")

    def test_content_that_does_not_have_its_hash_is_refused(self):
        self.assert_refused(self.job("apply", [self.entry(self.props, self.NEW, self.OLD)], {"nifi.properties": b"something else"}), "does not have its sha256")
        self.assertEqual(self.props.read_bytes(), self.OLD)
        self.assertFalse(self.backup_dir().exists())

    def test_content_that_is_missing_or_malformed_is_refused(self):
        entry = self.entry(self.props, self.NEW, self.OLD)
        self.assert_refused(self.job("apply", [entry]), "content")
        self.assert_refused(self.job("apply", [entry], {}), "exactly")
        self.assert_refused(self.job("apply", [entry], {"nifi.properties": self.NEW, "logback.xml": self.NEW}), "exactly")
        self.assert_refused(self.job("apply", [entry], raw_content="not json"), "content")
        self.assert_refused(self.job("apply", [entry], raw_content=json.dumps({"files": [{"name": "nifi.properties", "base64": "@@"}]})), "content")

    def test_what_reaches_the_disk_is_checked_against_the_hash(self):
        real_write = os.write

        def flipped(fd, data):
            real_write(fd, bytes(data).replace(b"NEW", b"BAD"))
            return len(data)

        with mock.patch.object(os, "write", flipped):
            # The backup's copy goes through the same call, so it fails first unless it holds no NEW.
            done = self.apply()
        self.assertEqual(done["state"], "failed")
        self.assertIn("sha256", done["message"])
        self.assertEqual(self.props.read_bytes(), self.OLD)
        self.assert_no_temp()

    # --- failing halfway ---

    def test_a_failure_while_writing_leaves_no_half_a_file(self):
        real_write = os.write

        def full(fd, data):
            if bytes(data) == self.NEW:
                real_write(fd, bytes(data)[:10])
                raise OSError(28, "No space left on device")
            return real_write(fd, data)

        inode = self.props.stat().st_ino
        with mock.patch.object(os, "write", full):
            done = self.apply()
        self.assertEqual(done["state"], "failed")
        self.assertIn("No space left", done["message"])
        self.assertEqual((self.props.read_bytes(), self.props.stat().st_ino), (self.OLD, inode))
        self.assert_no_temp()
        self.assertTrue(done["result"]["rolledBack"])

    def test_the_second_replacement_failing_puts_the_first_back(self):
        real_replace = os.replace
        replaced = []

        def second_fails(src, dst, **kw):
            if dst == "logback.xml" and not replaced:
                replaced.append(dst)
                raise OSError(5, "Input/output error")
            return real_replace(src, dst, **kw)

        with mock.patch.object(os, "replace", second_fails):
            done = self.apply_two()
        self.assertEqual(done["state"], "failed")
        self.assertIn("Input/output error", done["message"])
        self.assertIn("every file is back", done["message"])
        self.assertEqual(self.props.read_bytes(), self.OLD)
        self.assertEqual(oct(self.props.stat().st_mode & 0o7777), "0o604")
        self.assertEqual(self.logback.read_bytes(), self.LOGBACK)
        self.assert_no_temp()
        self.assertTrue(done["result"]["rolledBack"])
        self.assertEqual({f["name"]: f["after"] for f in done["result"]["files"]}, {"nifi.properties": sha(self.OLD), "logback.xml": sha(self.LOGBACK)})

    def test_putting_back_failing_says_which_file_stays_new(self):
        real_replace = os.replace
        seen = []

        def fails_from_the_second(src, dst, **kw):
            if "src_dir_fd" in kw:  # in the conf directory, not the backup's
                seen.append(dst)
                if len(seen) >= 2:
                    raise OSError(5, "Input/output error")
            return real_replace(src, dst, **kw)

        with mock.patch.object(os, "replace", fails_from_the_second):
            done = self.apply_two()
        self.assertEqual(done["state"], "failed")
        self.assertIn("could not put back", done["message"])
        self.assertIn("nifi.properties", done["message"])
        self.assertEqual(done["result"]["notRestored"], ["nifi.properties"])
        self.assertFalse(done["result"]["rolledBack"])
        self.assertEqual(self.props.read_bytes(), self.NEW, "the state the report gives")
        self.assert_no_temp()

    def test_a_backup_that_fails_writes_nothing(self):
        (self.root / "work").mkdir(exist_ok=True)
        (self.root / "work" / "backups").write_text("not a directory")
        done = self.apply()
        self.assertEqual(done["state"], "failed")
        self.assertEqual(self.props.read_bytes(), self.OLD)

    def test_a_temporary_file_a_killed_process_left_is_swept(self):
        left = self.conf / f".nifi.properties{sx.WRITE_TEMP}"
        left.write_bytes(b"half of it")
        also = self.conf / f".authorizers.xml{sx.WRITE_TEMP}"
        also.write_bytes(b"half of it")
        self.assertEqual(self.apply()["state"], "succeeded")
        self.assert_no_temp()

    # --- retries ---

    def test_a_retry_after_a_killed_job_keeps_the_first_backup_and_finishes(self):
        files = [self.entry(self.props, self.NEW, self.OLD), self.entry(self.logback, self.LOGBACK_NEW, self.LOGBACK)]
        self.assertEqual(self.job("backup", files)["state"], "succeeded")
        self.props.write_bytes(self.NEW)  # killed after the first replacement
        done = self.job("apply", files, {"nifi.properties": self.NEW, "logback.xml": self.LOGBACK_NEW})
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual((self.backup_dir() / "nifi.properties").read_bytes(), self.OLD, "the new file is not taken for the original")
        self.assertEqual(self.logback.read_bytes(), self.LOGBACK_NEW)

    def test_applying_again_changes_nothing_and_keeps_the_backup(self):
        self.assertEqual(self.apply()["state"], "succeeded")
        inode = self.props.stat().st_ino
        done = self.apply()
        self.assertEqual(done["state"], "succeeded")
        self.assertIn("0 file(s) written", done["message"])
        self.assertEqual(self.props.stat().st_ino, inode)
        self.assertEqual((self.backup_dir() / "nifi.properties").read_bytes(), self.OLD)

    def test_a_backup_cut_short_is_written_again(self):
        d = self.backup_dir()
        d.mkdir(parents=True)
        (d / "nifi.properties.part").write_bytes(b"cut")
        (d / "nifi.properties").write_bytes(b"cut")  # the manifest does not name it
        self.assertEqual(self.apply()["state"], "succeeded")
        self.assertEqual((d / "nifi.properties").read_bytes(), self.OLD)

    # --- restore ---

    def test_restore_puts_back_content_mode_and_label_and_removes_a_new_file(self):
        fake = FakeXattrs(self)
        fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:nifi_conf_t:s0")
        fake.set(self.logback, sx.XATTR_LABEL, b"system_u:object_r:nifi_conf_t:s0")
        new_file = self.conf / "state-management.xml"
        files = [self.entry(self.props, self.NEW, self.OLD), self.entry(new_file, b"<x/>\n")]
        self.assertEqual(self.job("apply", files, {"nifi.properties": self.NEW, "state-management.xml": b"<x/>\n"})["state"], "succeeded")
        self.props.chmod(0o600)
        fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:etc_t:s0")
        done = self.job("restore")
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(self.props.read_bytes(), self.OLD)
        self.assertEqual(oct(self.props.stat().st_mode & 0o7777), "0o604")
        self.assertEqual(fake.get(self.props, sx.XATTR_LABEL), b"system_u:object_r:nifi_conf_t:s0")
        self.assertFalse(new_file.exists())
        self.assert_no_temp()
        self.assertEqual({f["name"]: (f["before"], f["after"]) for f in done["result"]["files"]},
                         {"nifi.properties": (sha(self.NEW), sha(self.OLD)), "state-management.xml": (sha(b"<x/>\n"), None)})

    def test_restore_twice_changes_nothing_the_second_time(self):
        self.apply()
        self.assertEqual(self.job("restore")["state"], "succeeded")
        inode = self.props.stat().st_ino
        self.assertEqual(self.job("restore")["state"], "succeeded")
        self.assertEqual(self.props.stat().st_ino, inode)

    def test_restore_without_a_backup_is_refused(self):
        self.assert_refused(self.job("restore"), "no backup")

    def test_a_damaged_backup_is_not_restored_and_nothing_is_replaced(self):
        self.apply_two()
        (self.backup_dir() / "logback.xml").write_bytes(b"damaged")
        done = self.job("restore")
        self.assertEqual(done["state"], "failed")
        self.assertIn("logback.xml", done["message"])
        self.assertEqual(done["result"]["notRestored"], ["logback.xml"])
        self.assertEqual(self.props.read_bytes(), self.NEW, "all prepared, or none replaced")
        self.assertEqual(self.logback.read_bytes(), self.LOGBACK_NEW)
        self.assert_no_temp()

    def test_a_manifest_naming_a_path_out_of_the_registered_ones_is_refused(self):
        self.apply()
        target = self.outside / "nifi.properties"
        target.write_bytes(b"not touched")
        manifest = self.backup_dir() / "manifest.json"
        m = json.loads(manifest.read_text())
        m["entries"][0]["path"] = str(target)
        manifest.write_text(json.dumps(m))
        self.assert_refused(self.job("restore"), "not where")
        self.assertEqual(target.read_bytes(), b"not touched")

    def test_restore_follows_a_link_inside_the_conf_directory(self):
        real = self.conf / "kept.xml"
        self.logback.rename(real)
        self.logback.symlink_to(real)
        self.assertEqual(self.job("apply", [self.entry(self.logback, self.LOGBACK_NEW, self.LOGBACK)], {"logback.xml": self.LOGBACK_NEW})["state"], "succeeded")
        self.assertEqual(self.job("restore")["state"], "succeeded")
        self.assertTrue(self.logback.is_symlink())
        self.assertEqual(real.read_bytes(), self.LOGBACK)

    # --- the flow file ---

    def test_the_flow_file_is_backed_up_never_written_and_comes_back_with_restore(self):
        files = [self.entry(self.props, self.NEW, self.OLD)]
        inode = self.flow.stat().st_ino
        done = self.job("backup", files, flowFile=True)
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(done["result"]["backup"], ["nifi.properties", "flow"])
        self.assertEqual((self.backup_dir() / "flow").read_bytes(), self.FLOW)
        self.assertEqual(self.props.read_bytes(), self.OLD, "backup does not write")
        self.assertEqual(self.job("apply", files, {"nifi.properties": self.NEW}, flowFile=True)["state"], "succeeded")
        self.assertEqual((self.flow.read_bytes(), self.flow.stat().st_ino), (self.FLOW, inode), "apply leaves it")

        self.flow.write_bytes(b"\x1f\x8bwhat the new configuration made of it\n")
        done = self.job("restore", flowFile=True)
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(self.flow.read_bytes(), self.FLOW)
        self.assertEqual(self.props.read_bytes(), self.OLD)
        self.assertEqual(done["result"]["flowFile"]["after"], sha(self.FLOW))
        self.assertEqual([f["name"] for f in done["result"]["files"]], ["nifi.properties"])

    def test_the_flow_files_path_comes_from_nifi_properties_and_not_from_the_request(self):
        other = self.outside / "chosen.gz"
        other.write_bytes(b"not this one")
        self.assert_refused(self.job("backup", [], flowFile=str(other)), "true or false")
        done = self.job("backup", [], flowFile=True, flowPath=str(other), flow=str(other), path=str(other))
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        entry = json.loads((self.backup_dir() / "manifest.json").read_text())["entries"][0]
        self.assertEqual((entry["name"], entry["path"]), ("flow", str(self.flow)), "resolved against the installation")
        self.assertEqual((self.backup_dir() / "flow").read_bytes(), self.FLOW)

    def test_the_flow_file_cannot_be_named_as_a_file_to_write(self):
        self.assert_refused(self.job("apply", [self.entry(self.flow, b"x", self.FLOW, name="flow")], {"flow": b"x"}), "names among")
        self.assertEqual(self.flow.read_bytes(), self.FLOW)

    def test_a_flow_file_that_did_not_exist_is_gone_after_restore(self):
        self.flow.unlink()
        self.assertEqual(self.job("backup", [], flowFile=True)["state"], "succeeded")
        self.flow.write_bytes(self.FLOW)
        self.assertEqual(self.job("restore")["state"], "succeeded")
        self.assertFalse(self.flow.exists())

    def test_nifi_properties_naming_no_flow_file_or_something_else_is_refused(self):
        self.props.write_bytes(b"nifi.web.https.port=9443\n")
        self.assert_refused(self.job("backup", [], flowFile=True), "does not name")
        self.props.write_bytes(f"nifi.flow.configuration.file={self.outside}/passwd\n".encode())
        self.assert_refused(self.job("backup", [], flowFile=True), "not a flow file")
        self.assertFalse(self.backup_dir().exists())

    def test_a_flow_file_of_another_owner_is_refused(self):
        real_stat = os.stat

        def other_owner(path, **kw):
            st = real_stat(path, **kw)
            if str(path).endswith("nifi.properties"):
                return mock.Mock(st_uid=st.st_uid + 1, st_mode=st.st_mode)
            return st

        with mock.patch.object(os, "stat", other_owner):
            self.assert_refused(self.job("backup", [], flowFile=True), "not a flow file")

    def test_an_apply_without_flow_file_does_not_back_it_up(self):
        self.apply()
        self.assertFalse((self.backup_dir() / "flow").exists())

    # --- what stays out of logs and status ---

    def test_no_content_reaches_the_log_the_status_or_the_output(self):
        real_replace = os.replace
        replaced = []

        def second_fails(src, dst, **kw):
            if dst == "logback.xml" and not replaced:
                replaced.append(dst)
                raise OSError(5, "Input/output error")
            return real_replace(src, dst, **kw)

        files = [self.entry(self.props, self.NEW, self.OLD), self.entry(self.logback, self.LOGBACK_NEW, self.LOGBACK)]
        content = {"nifi.properties": self.NEW, "logback.xml": self.LOGBACK_NEW}
        self.job("check", files, content)
        self.job("backup", files, flowFile=True)
        with mock.patch.object(os, "replace", second_fails):
            self.job("apply", files, content, change="change-2")
        self.job("apply", files, content)
        self.job("apply", files, {"nifi.properties": b"wrong OTHER-SECRET-VALUE", "logback.xml": self.LOGBACK_NEW}, change="change-3")
        self.job("apply", files, change="change-4", raw_content="OTHER-SECRET-VALUE is not json")
        self.job("restore")
        self.ex.flush_log()
        self.stream.flush()
        sent = json.dumps(self.api.status) + json.dumps(self.api.logs) + json.dumps(self.api.env) + self.out.read_text()
        self.assertGreaterEqual(len(self.api.status), 7)
        self.assertIn("backed up nifi.properties", sent, "the log is there to look through")
        for needle in ("OLD-SECRET-VALUE", "NEW-SECRET-VALUE", "OTHER-SECRET-VALUE", "nifi.sensitive.props.key", sx.base64.b64encode(self.NEW).decode()[:20]):
            self.assertNotIn(needle, sent)
        marker = self.root / "work"
        for p in marker.rglob("*"):
            if p.is_file() and "backups" not in p.parts:
                self.assertNotIn(b"SECRET-VALUE", p.read_bytes(), str(p))

    # --- check ---

    def test_check_writes_nothing(self):
        before = self.snapshot()
        files = [self.entry(self.props, self.NEW, self.OLD), self.entry(self.logback, self.LOGBACK_NEW, self.LOGBACK), self.entry(self.conf / "state-management.xml", b"<x/>\n")]
        done = self.job("check", files, flowFile=True)
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(self.snapshot(), before, "names, content, inodes, times and modes")
        self.assertFalse((self.root / "work" / "backups").exists(), "not even the backup directory")
        self.assertEqual(done["result"]["flowFile"], {"path": str(self.flow), "exists": True})
        self.assertFalse(done["result"]["selinux"])
        self.assertEqual({f["name"]: (f["before"], f["after"]) for f in done["result"]["files"]}, {
            "nifi.properties": (sha(self.OLD), sha(self.OLD)), "logback.xml": (sha(self.LOGBACK), sha(self.LOGBACK)), "state-management.xml": (None, None)})

    def test_check_tries_the_label_on_a_probe_and_removes_it(self):
        fake = FakeXattrs(self)
        fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:nifi_conf_t:s0")
        created = []
        real_open = os.open

        def opened(path, flags, *a, **kw):
            fd = real_open(path, flags, *a, **kw)
            if flags & os.O_CREAT:
                created.append(path)
            return fd

        with mock.patch.object(os, "open", opened):
            done = self.job("check", [self.entry(self.props, self.NEW, self.OLD)])
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertTrue(done["result"]["selinux"])
        self.assertEqual(done["result"]["files"][0]["label"], "system_u:object_r:nifi_conf_t:s0")
        self.assertEqual(created, [f".nifi.properties{sx.WRITE_TEMP}"])
        self.assert_no_temp()
        self.assertEqual(self.props.read_bytes(), self.OLD)

    def test_check_finds_a_label_that_cannot_be_set(self):
        fake = FakeXattrs(self)
        fake.set(self.props, sx.XATTR_LABEL, b"system_u:object_r:nifi_conf_t:s0")
        fake.refuse.add(sx.XATTR_LABEL)
        done = self.job("check", [self.entry(self.props, self.NEW, self.OLD)])
        self.assertEqual(done["state"], "failed")
        self.assertIn(sx.XATTR_LABEL, done["message"])
        self.assert_no_temp()

    def test_check_refuses_what_changed_since_the_plan_and_paths_out(self):
        self.assert_refused(self.job("check", [self.entry(self.props, self.NEW, b"another base")]), "changed since the plan")
        self.assert_refused(self.job("check", [{**self.entry(self.props, self.NEW, self.OLD), "path": f"{self.conf}/../conf/nifi.properties"}]), "plain absolute")
        self.assert_refused(self.job("check", []), "no files")

    @unittest.skipIf(os.geteuid() == 0, "root writes anywhere")
    def test_check_finds_a_directory_that_cannot_be_written(self):
        self.conf.chmod(0o500)
        self.addCleanup(self.conf.chmod, 0o700)
        self.assertEqual(self.job("check", [self.entry(self.props, self.NEW, self.OLD)])["state"], "failed")
        self.assertEqual(self.props.read_bytes(), self.OLD)

    def test_check_checks_content_when_given(self):
        self.assert_refused(self.job("check", [self.entry(self.props, self.NEW, self.OLD)], {"nifi.properties": b"other"}), "does not have its sha256")

    # --- prune ---

    def test_prune_keeps_the_newest_five_and_always_this_change(self):
        for i in range(7):
            self.props.write_bytes(self.OLD)
            self.assertEqual(self.apply(change=f"c{i}")["state"], "succeeded")
        (self.backup_dir("c9-cut-short")).mkdir()
        other = self.root / "work" / "backups" / "othermember"
        (other / "c0").mkdir(parents=True)
        done = self.job("prune", change="c0")
        self.assertEqual(done["state"], "succeeded", done.get("message"))
        self.assertEqual(sorted(p.name for p in self.backup_dir().parent.iterdir()), ["c0", "c3", "c4", "c5", "c6"])
        self.assertEqual(done["result"], {"pruned": ["c1", "c2", "c9-cut-short"], "kept": 5})
        self.assertTrue((other / "c0").is_dir(), "another member's are not touched")
        self.assertEqual(self.job("prune", change="c9")["result"]["pruned"], [], "five left: nothing goes")

    def test_prune_with_no_backups_is_fine(self):
        self.assertEqual(self.job("prune")["result"], {"pruned": [], "kept": 0})

    # --- on the change channel ---

    def test_it_runs_on_the_change_channel_beside_the_reads(self):
        self.api.queue.append({"protocol": 2, "id": "write-job-chan", "kind": "svc-write", "action": "apply", "change": "change-1", "member": "local:nifi",
                               "files": [self.entry(self.props, self.NEW, self.OLD)],
                               "content": json.dumps({"files": [{"name": "nifi.properties", "base64": sx.base64.b64encode(self.NEW).decode()}]})})
        self.assertTrue(self.ex.run_once())
        self.ex.wait_change()
        self.assertEqual(self.api.status["write-job-chan"]["state"], "succeeded")
        self.assertEqual(self.props.read_bytes(), self.NEW)
        self.assertFalse(self.ex.current_marker().exists())


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
