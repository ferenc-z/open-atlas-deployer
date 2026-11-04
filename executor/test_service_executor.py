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
        self.assertEqual(beat["kinds"], ["executor-upgrade"], "no service job kinds yet; never the deploy ones")
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
