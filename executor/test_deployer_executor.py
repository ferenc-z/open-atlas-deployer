"""Unit tests for the host executor's checks; the full deploy and rollback run against Docker in the e2e check.

    python3 -m unittest executor/test_deployer_executor.py
"""
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import deployer_executor as dx  # noqa: E402


class FakeApi:
    """Plays the Deployer's side of protocol 2: a queue of jobs, and what the executor sent back."""

    def __init__(self):
        self.queue, self.status, self.logs, self.env, self.beats, self.states = [], {}, {}, {}, [], []
        # D16: the Deployer's version as its heartbeat answer says, and whether it is down (restarting).
        self.deployer, self.down = None, False

    def token(self):
        return "dpe_test"

    def heartbeat(self, beat):
        if self.down:
            raise dx.Failed("cannot reach the Deployer")
        self.beats.append(beat)
        return {"ok": True, "deployer": self.deployer}

    def next_job(self, wait):
        return self.queue.pop(0) if self.queue else None

    def put_status(self, job_id, status):
        if self.down:
            raise dx.Failed("cannot reach the Deployer")
        self.status[job_id] = json.loads(json.dumps(status))

    def append_log(self, job_id, text):
        if self.down:
            raise dx.Failed("cannot reach the Deployer")
        self.logs[job_id] = self.logs.get(job_id, "") + text

    def put_env_content(self, job_id, text):
        self.env[job_id] = text

    def report_state(self, containers, files):
        self.states.append((containers, files))


def cfg(root, **over):
    c = dx.config(environ={"EXECUTOR_ROOT": str(root), "EXECUTOR_REGISTRIES": "ghcr.io/acme localhost:5000",
                           "EXECUTOR_WORK": str(pathlib.Path(root) / "work")})
    c.update(over)
    return c


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.cfg = cfg(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def service(self, **over):
        s = {"image": "ghcr.io/acme/shop:1.2.0@sha256:abc", "volumes": [{"type": "bind", "source": str(self.root / "shop" / "data"), "target": "/data"}]}
        s.update(over)
        return {"services": {"shop": s}}

    def test_images_come_from_registered_registries_or_are_pinned_public(self):
        regs = ["ghcr.io/acme", "localhost:5000"]
        self.assertTrue(dx.image_allowed("ghcr.io/acme/shop:1.2.0", regs))
        self.assertTrue(dx.image_allowed("localhost:5000/shop:1", regs))
        self.assertFalse(dx.image_allowed("ghcr.io/evil/shop:1.2.0", regs))
        self.assertFalse(dx.image_allowed("ghcr.io/acme-evil/shop:1", regs))
        self.assertTrue(dx.image_allowed("postgres:16.4", regs))
        self.assertTrue(dx.image_allowed("caddy@sha256:abc", regs))
        self.assertFalse(dx.image_allowed("postgres:latest", regs))
        self.assertFalse(dx.image_allowed("postgres", regs))

    def test_an_ordinary_service_passes(self):
        self.assertEqual(dx.policy_findings(self.cfg, "shop", ["shop"], self.service()), [])

    def test_refuses_privileges_host_namespaces_and_foreign_mounts(self):
        bad = self.service(privileged=True, cap_add=["SYS_ADMIN"], network_mode="host", pid="host",
                           security_opt=["seccomp:unconfined"], build={"context": "."},
                           volumes=[{"type": "bind", "source": "/etc", "target": "/host-etc"},
                                    {"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"},
                                    {"type": "bind", "source": str(self.root / "other" / "data"), "target": "/x"},
                                    {"type": "volume", "source": "named", "target": "/v"}])
        found = " | ".join(dx.policy_findings(self.cfg, "shop", ["shop"], bad))
        for word in ("privileged", "cap_add", "network_mode", "pid", "security_opt", "build", "/etc", "Docker socket", "other/data"):
            self.assertIn(word, found)
        self.assertNotIn("named", found)

    def test_bind_roots_allow_overridden_data_paths(self):
        c = cfg(self.root, bind_roots=[pathlib.Path("/srv/legacy")])
        s = self.service(volumes=[{"type": "bind", "source": "/srv/legacy/studio", "target": "/data"}])
        self.assertEqual(dx.policy_findings(c, "shop", ["shop"], s), [])

    def test_ports_taken_by_other_containers(self):
        line = lambda svc, ports, project="open-atlas", state="running": json.dumps({
            "Names": svc, "State": state, "Ports": ports,
            "Labels": f"com.docker.compose.project={project},com.docker.compose.service={svc}"})
        ps = [line("proxy", "127.0.0.1:18100->80/tcp, 127.0.0.1:18143->443/tcp"),
              line("dossier-proxy", "127.0.0.1:18100->80/tcp"),
              line("old", "0.0.0.0:9000->9000/tcp", state="exited"),
              line("x", "0.0.0.0:5432->5432/tcp", project="other")]
        used = dx.ports_in_use(ps, ["dossier-proxy"], "open-atlas")
        self.assertEqual(used, {18100: "proxy", 18143: "proxy", 5432: "x"})
        normalized = {"services": {"dossier-proxy": {"ports": [{"published": "18100", "target": 80}, {"target": 9}]}}}
        self.assertEqual(dx.published_ports(normalized, ["dossier-proxy"]), {18100: "dossier-proxy"})

    def test_reads_unset_variables_from_compose_warnings(self):
        compose5 = 'time="2026-10-30T18:01:59+08:00" level=warning msg="The \\"GREETING\\" variable is not set. Defaulting to a blank string."\n'
        older = 'WARN[0000] The "JWT_SECRET" variable is not set. Defaulting to a blank string.\n'
        self.assertEqual(dx.unset_variables(compose5 + older + compose5), ["GREETING", "JWT_SECRET"])
        self.assertEqual(dx.unset_variables(""), [])

    def test_repository_and_pinning(self):
        self.assertEqual(dx.repository("ghcr.io/acme/shop:1.2.0"), "ghcr.io/acme/shop")
        self.assertEqual(dx.repository("localhost:5000/shop"), "localhost:5000/shop")
        self.assertEqual(dx.repository("postgres:16.4@sha256:x"), "postgres")
        self.assertEqual(dx.pinned("postgres:16.4@sha256:x", "sha256:y"), "postgres:16.4@sha256:y")


class RequestTest(unittest.TestCase):
    """Malformed or disallowed requests are refused before anything runs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.api = FakeApi()
        self.ex = dx.Executor(cfg(self.root), out=open("/dev/null", "w") if pathlib.Path("/dev/null").exists() else sys.stderr, api=self.api)
        self.ran = []
        self.ex.sh = lambda args, **kw: self.ran.append(args) or type("P", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    def tearDown(self):
        self.tmp.cleanup()

    def submit(self, request):
        self.api.queue.append(request)
        self.assertTrue(self.ex.run_once())
        return self.api.status[request["id"]]

    def test_build_refuses_other_scripts_registries_and_names(self):
        base = {"protocol": 2, "kind": "build", "app": "shop", "version": "1.2.0", "registry": "ghcr.io/acme", "image": "open-atlas-shop",
                "build": {"repo": "acme/shop", "tag": "shop-1.2.0", "script": "build-images.sh", "platform": "linux/amd64"}}
        cases = [({"build": {**base["build"], "script": "rm -rf /"}}, "build-images.sh"),
                 ({"registry": "ghcr.io/evil"}, "not registered"),
                 ({"image": "shop"}, "names the image"),
                 ({"protocol": 1}, "protocol 1")]
        for i, (over, word) in enumerate(cases):
            status = self.submit({**base, **over, "id": f"build-job-{i:04d}"})
            self.assertEqual(status["state"], "refused")
            self.assertIn(word, status["message"])
        self.assertEqual(self.ran[-1][:2], ["docker", "ps"], "only the state report ran")

    def test_deploy_refuses_a_root_for_another_project_or_a_missing_include(self):
        base = {"protocol": 2, "kind": "deploy", "app": "shop", "version": "1.2.0", "services": ["shop"], "fragment": "services: {}",
                "root": 'name: "open-atlas"\ninclude:\n  - path: "shop/compose.yaml"\n'}
        status = self.submit({**base, "id": "deploy-job-0001", "root": 'name: "elsewhere"\n'})
        self.assertIn("not for project", status["message"])
        status = self.submit({**base, "id": "deploy-job-0002", "root": 'name: "open-atlas"\ninclude: []\n'})
        self.assertIn("exactly once", status["message"])
        status = self.submit({**base, "id": "deploy-job-0003", "services": ["Bad Name"]})
        self.assertIn("malformed", status["message"])

    def env_request(self, job_id, content, **over):
        import hashlib
        req = {"protocol": 2, "kind": "env", "id": job_id, "app": "shop", "revision": 3, "file": "shop.env",
               "content": content, "sha256": hashlib.sha256(content.encode()).hexdigest(), "restart": False, "services": []}
        req.update(over)
        return req

    def test_env_write_checks_the_hash_and_keeps_the_content_out_of_the_log(self):
        status = self.submit(self.env_request("env-job-0001", "A=1\n", sha256="0" * 64))
        self.assertEqual(status["state"], "refused")
        self.assertIn("sha256", status["message"])
        self.assertNotIn("A=1", self.api.logs.get("env-job-0001", ""))
        self.assertFalse((self.root / "shop.env").exists())
        status = self.submit(self.env_request("env-job-0002", "A=1\n", file="../etc/passwd"))
        self.assertIn("malformed", status["message"])

    def test_env_write_without_restart_writes_the_file_privately_and_keeps_the_previous_one(self):
        (self.root / "shop.env").write_text("A=0\n")
        status = self.submit(self.env_request("env-job-0003", "A=1\nB='x y'\n"))
        self.assertEqual(status["state"], "succeeded", status.get("message"))
        target = self.root / "shop.env"
        self.assertEqual(target.read_text(), "A=1\nB='x y'\n")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / "shop" / ".deployer" / "env.previous").read_text(), "A=0\n")
        self.assertNotIn("A=1", self.api.logs.get("env-job-0003", ""))

    def test_env_write_with_restart_needs_a_fragment_from_the_deployer(self):
        status = self.submit(self.env_request("env-job-0004", "A=1\n", restart=True, services=["shop"]))
        self.assertEqual(status["state"], "refused")
        self.assertIn("no compose fragment", status["message"])

    def test_env_read_sends_the_file_to_the_deployer_and_keeps_no_copy(self):
        status = self.submit({"protocol": 2, "kind": "env-read", "id": "env-read-0001", "app": "shop", "file": "shop.env"})
        self.assertEqual(status["result"]["env"], {"exists": False})
        (self.root / "shop.env").write_text("SECRET=s3\n")
        status = self.submit({"protocol": 2, "kind": "env-read", "id": "env-read-0002", "app": "shop", "file": "shop.env"})
        self.assertEqual(self.api.env["env-read-0002"], "SECRET=s3\n")
        self.assertEqual(status["result"]["env"]["bytes"], 10)
        self.assertNotIn("SECRET", self.api.logs.get("env-read-0002", ""))
        self.assertEqual(sorted(p.name for p in self.root.rglob("*") if p.is_file()), ["shop.env"], "no copy beside the file")

    def test_a_job_left_running_is_marked_interrupted(self):
        dx.write_json(self.ex.current_marker(), {"id": "deploy-job-0009", "state": "running", "steps": []})
        self.ex.recover()
        self.assertEqual(self.api.status["deploy-job-0009"]["state"], "failed")
        self.assertFalse(self.ex.current_marker().exists())

    def test_a_finished_job_leaves_no_marker_and_its_log_reaches_the_deployer(self):
        self.submit({"protocol": 2, "kind": "env-read", "id": "env-read-0003", "app": "shop", "file": "shop.env"})
        self.assertFalse(self.ex.current_marker().exists())
        self.assertIn("--- read running", self.api.logs["env-read-0003"])

    def test_heartbeat_keeps_going_during_a_long_job(self):
        self.ex.beat_seconds = 0.02
        beats = []
        heartbeat = self.ex.heartbeat
        self.ex.heartbeat = lambda busy=None: beats.append(busy) or heartbeat(busy)
        import time
        self.ex.env_read = lambda request, status: time.sleep(0.2) or self.ex.finish(status, "succeeded", "read")
        status = self.submit({"protocol": 2, "kind": "env-read", "app": "shop", "id": "env-job-0001"})
        self.assertEqual(status["state"], "succeeded")
        self.assertGreaterEqual(beats.count("env-job-0001"), 4, "beats while the job runs, not only when it starts")
        self.assertIsNone(self.api.beats[-1]["busy"], "the last beat says idle")

    def test_heartbeat_names_protocols_and_database_backups(self):
        self.ex.cfg["db"] = dx.config(environ={"EXECUTOR_DB_DUMP_DOSSIER": "docker exec db pg_dump"})["db"]
        self.ex.heartbeat()
        beat = self.api.beats[-1]
        self.assertEqual(beat["protocols"], [2])
        self.assertEqual(beat["kinds"], ["build", "deploy", "env", "env-read", "bundle", "db-migration", "executor-upgrade", "deployer-upgrade"])
        self.assertEqual(beat["databaseBackup"], {"dossier": {"dump": True, "restore": False}})


def tar_gz(files, top="book-1.0.0", extra=None):
    import io
    import tarfile
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        if extra:
            tar.addfile(extra)
    return buf.getvalue()


class BundleTest(unittest.TestCase):
    """Phase 5: files from a release asset, and migrations in the database container."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.ex = dx.Executor(cfg(self.root))
        self.urls = []

    def tearDown(self):
        self.tmp.cleanup()

    def serve(self, data):
        def get(url, accept, auth=True):
            self.urls.append(url)
            if "/releases/tags/" in url:
                return json.dumps({"assets": [{"name": "book-1.0.0.tar.gz", "url": "https://api.github.test/assets/1"}]}).encode()
            return data
        self.ex.cfg["github_api"] = "https://api.github.test"
        self.ex.http_get = get

    def test_takes_files_from_the_bundle_it_was_planned_with(self):
        import hashlib
        data = tar_gz({"pkg/db/01.sql": "create table t();", "app/app.json": "{}"})
        self.serve(data)
        bundle = {"repo": "acme/book", "tag": "v1.0.0", "asset": "book-1.0.0.tar.gz", "sha256": hashlib.sha256(data).hexdigest()}
        dest = self.root / "next"
        self.ex.fetch_files({"bundle": bundle, "paths": ["pkg/db"]}, dest)
        self.assertEqual((dest / "pkg" / "db" / "01.sql").read_text(), "create table t();")
        self.assertFalse((dest / "app").exists())
        self.ex.fetch_files({"bundle": bundle, "paths": ["pkg/db"]}, self.root / "again")
        self.assertEqual(len(self.urls), 2, "the second time from the cache")
        with self.assertRaises(dx.Failed) as e:
            self.ex.fetch_files({"bundle": {**bundle, "tag": "v1.0.1", "sha256": "0" * 64}, "paths": ["pkg/db"]}, self.root / "x")
        self.assertIn("the release asset changed", str(e.exception))
        with self.assertRaises(dx.Refused):
            self.ex.fetch_files({"bundle": {**bundle, "asset": "../x"}, "paths": []}, self.root / "y")

    def test_refuses_a_bundle_with_links(self):
        import hashlib
        import tarfile
        link = tarfile.TarInfo("book-1.0.0/pkg/evil")
        link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
        data = tar_gz({"pkg/db/01.sql": "x"}, extra=link)
        self.serve(data)
        with self.assertRaises(dx.Failed) as e:
            self.ex.fetch_files({"bundle": {"repo": "acme/book", "tag": "v1.0.0", "asset": "book-1.0.0.tar.gz", "sha256": hashlib.sha256(data).hexdigest()}, "paths": ["pkg/db"]}, self.root / "z")
        self.assertIn("not a plain file", str(e.exception))

    def test_runs_each_migration_once_with_its_record_in_one_transaction(self):
        app_dir = self.root / "book"
        (app_dir / "files" / "pkg" / "migrations").mkdir(parents=True)
        (app_dir / "files" / "pkg" / "migrations" / "002-b.sql").write_text("alter table t add b int;")
        (app_dir / "files" / "pkg" / "migrations" / "001-a.sql").write_text("alter table t add a int;")
        (app_dir / "files" / "pkg" / "migrations" / "notes.txt").write_text("not sql")
        ran = []

        class P:
            def __init__(self, out=""):
                self.stdout, self.returncode = out, 0

        def compose(*args, check=True, quiet=False, file="compose.yaml", input=None):
            ran.append((args, input))
            if "SELECT name, kind, sha256" in " ".join(args):
                import hashlib
                return P(f"pkg/migrations/001-a.sql|migrations|{hashlib.sha256(b'alter table t add a int;').hexdigest()}\n")
            return P()
        self.ex.compose = compose
        applied = self.ex.migrate(app_dir, [{"component": "migrate", "service": "book-db", "migrations": "pkg/migrations"}])
        self.assertEqual(applied, ["pkg/migrations/002-b.sql"])
        last_args, last_sql = ran[-1]
        self.assertEqual(last_args[:3], ("exec", "-T", "book-db"))
        self.assertIn("--single-transaction", last_args)
        self.assertIn("alter table t add b int;", last_sql)
        self.assertIn("INSERT INTO deployer.migrations (component, name, kind, sha256) VALUES ('migrate', 'pkg/migrations/002-b.sql', 'migrations'", last_sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS deployer.migrations", ran[0][1])

    def test_a_deploy_refuses_migrations_outside_its_services(self):
        req = {"app": "book", "version": "1.0.0", "services": ["book-db"], "fragment": "", "root": "",
               "migrations": [{"component": "migrate", "service": "other-db", "migrations": "pkg/migrations"}]}
        with self.assertRaises(dx.Refused):
            self.ex.deploy(req, {"steps": [], "result": {}})
        req["migrations"] = [{"component": "migrate", "service": "book-db", "migrations": "../../etc"}]
        with self.assertRaises(dx.Refused):
            self.ex.deploy(req, {"steps": [], "result": {}})


class FileHashTest(unittest.TestCase):
    def test_hashes_the_compose_and_env_files_it_manages(self):
        import hashlib
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / "compose.yaml").write_text("name: x\n")
            (root / "shop").mkdir()
            (root / "shop" / "compose.yaml").write_text("services: {}\n")
            (root / "shop.env").write_text("A=1\n")
            (root / "deployer").mkdir()
            (root / "deployer" / "compose.yaml").write_text("not ours")
            (root / "Bad Name.env").write_text("x")
            hashes = dx.Executor(cfg(d)).file_hashes()
            self.assertEqual(sorted(hashes), ["compose.yaml", "shop.env", "shop/compose.yaml"])
            self.assertEqual(hashes["shop.env"], hashlib.sha256(b"A=1\n").hexdigest())


class UpgradeTest(unittest.TestCase):
    """§8.6: a newer release from the host's own source, `current` switched, the result reported by whoever runs next."""

    def setUp(self):
        import hashlib
        import io
        import tarfile
        self.hashlib, self.io, self.tarfile = hashlib, io, tarfile
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.base, self.source = self.root / "base", self.root / "source"
        (self.base / "releases" / dx.VERSION).mkdir(parents=True)
        (self.base / "releases" / dx.VERSION / "deployer_executor.py").write_text("old")
        (self.base / "launch.sh").write_bytes((pathlib.Path(dx.__file__).parent / "launch.sh").read_bytes())
        (self.base / "current").symlink_to(f"releases/{dx.VERSION}")
        self.api = FakeApi()
        self.devnull = open("/dev/null", "w")
        self.addCleanup(self.devnull.close)
        self.ex = dx.Executor(cfg(self.root, base=self.base, upgrade_from=str(self.source)), out=self.devnull, api=self.api)
        self.ex.sleep = lambda s: None
        self.work = self.ex.cfg["work"]
        self.addCleanup(setattr, dx, "VERSION", dx.VERSION)

    def tearDown(self):
        self.tmp.cleanup()

    def release(self, version, files=None, sums=None):
        """Publishes executor-v<version> in the directory source; returns the archive."""
        code = (pathlib.Path(dx.__file__)).read_text().replace(f'VERSION = "{dx.VERSION}"', f'VERSION = "{version}"', 1)
        files = files if files is not None else {"deployer_executor.py": code, "launch.sh": (self.base / "launch.sh").read_text()}
        buf = self.io.BytesIO()
        with self.tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for name, text in files.items():
                data = text.encode()
                info = self.tarfile.TarInfo(name if "/" in name else f"{dx.PACKAGE}-{version}/{name}")
                info.size = len(data)
                tar.addfile(info, self.io.BytesIO(data))
        d = self.source / f"executor-v{version}"
        d.mkdir(parents=True, exist_ok=True)
        name = f"{dx.PACKAGE}-{version}.tar.gz"
        (d / name).write_bytes(buf.getvalue())
        (d / "SHA256SUMS").write_text(sums if sums is not None else f"{self.hashlib.sha256(buf.getvalue()).hexdigest()}  {name}\n")
        return buf.getvalue()

    def upgrade(self, version, job="upgrade-0001"):
        self.api.queue.append({"protocol": 2, "id": job, "kind": "executor-upgrade", "version": version})
        return self.ex.run_once()

    def test_installs_beside_the_running_release_switches_and_exits(self):
        self.release("9.0.0")
        with self.assertRaises(dx.Restarting):
            self.upgrade("9.0.0")
        self.assertEqual(dx.os.readlink(self.base / "current"), "releases/9.0.0")
        self.assertTrue((self.base / "releases" / dx.VERSION / "deployer_executor.py").is_file(), "the running release stays")
        self.assertIn('VERSION = "9.0.0"', (self.base / "releases" / "9.0.0" / "deployer_executor.py").read_text())
        self.assertEqual((self.work / "upgrade-pending").read_text(), dx.VERSION, "launch.sh knows where to go back")
        status = self.api.status["upgrade-0001"]
        self.assertEqual(status["state"], "running")
        self.assertEqual([s["name"] for s in status["steps"]], ["download", "install", "restart"])
        self.assertEqual(status["result"]["to"], "9.0.0")
        self.assertNotIn("note", status["result"], "launch.sh is unchanged")
        self.assertFalse(self.ex.current_marker().exists(), "a restart is not an interrupted job")

        # The new process: it passed its self-check, so it reports success and prunes old releases.
        for old in ("0.1.0", "0.2.0", "0.3.0"):
            (self.base / "releases" / old).mkdir()
        dx.VERSION = "9.0.0"
        self.ex.finish_upgrade()
        status = self.api.status["upgrade-0001"]
        self.assertEqual((status["state"], status["message"]), ("succeeded", f"Executor upgraded from {status['result']['from']} to 9.0.0"))
        self.assertTrue(all(s["state"] == "done" for s in status["steps"]))
        self.assertFalse((self.work / "upgrade-job.json").exists())
        self.assertEqual(sorted(p.name for p in (self.base / "releases").iterdir()), sorted({"0.3.0", status["result"]["previous"], "9.0.0"}))

    def test_after_launch_sh_went_back_the_old_release_reports_the_failure(self):
        self.release("9.0.0")
        with self.assertRaises(dx.Restarting):
            self.upgrade("9.0.0")
        (self.work / "upgrade-failed.json").write_text('{"rolledBackTo": "%s"}' % dx.VERSION)
        self.ex.finish_upgrade()
        status = self.api.status["upgrade-0001"]
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["message"], f"Executor 9.0.0 did not start after three failed starts; back on {dx.VERSION}")
        self.assertFalse((self.work / "upgrade-failed.json").exists())

    def test_refuses_or_fails_without_changing_the_running_release(self):
        cases = [
            ("0.0.1", None, "refused", "is not older"),
            ("9.0.1", None, "failed", "does not hold"),
        ]
        self.release("9.0.2", sums="0" * 64 + f"  {dx.PACKAGE}-9.0.2.tar.gz\n")
        cases.append(("9.0.2", None, "failed", "SHA256SUMS says"))
        self.release("9.0.3", files={"deployer_executor.py": 'VERSION = "9.0.3"\n', "../evil": "x"})
        cases.append(("9.0.3", None, "failed", "not one of the executor's files"))
        self.release("9.0.4", files={"deployer_executor.py": 'VERSION = "9.0.5"\n'})
        cases.append(("9.0.4", None, "failed", "is not version 9.0.4"))
        self.release("9.0.6", files={"deployer_executor.py": 'VERSION = "9.0.6"\ndef broken(:\n'})
        cases.append(("9.0.6", None, "failed", "does not compile"))
        for i, (version, _, state, message) in enumerate(cases):
            self.assertTrue(self.upgrade(version, job=f"upgrade-{i:04d}"))
            status = self.api.status[f"upgrade-{i:04d}"]
            self.assertEqual(status["state"], state, version)
            self.assertIn(message, status["message"])
        self.assertEqual(dx.os.readlink(self.base / "current"), f"releases/{dx.VERSION}")
        self.assertFalse((self.work / "upgrade-pending").exists())
        self.ex.cfg["upgrade_from"] = ""
        self.assertTrue(self.upgrade("9.0.0", job="upgrade-nosource"))
        self.assertIn("EXECUTOR_UPGRADE_FROM is not set", self.api.status["upgrade-nosource"]["message"])
        self.assertEqual(self.api.beats[-1]["upgradeFrom"], None)

    def test_a_github_source_is_the_release_executor_v_version(self):
        archive = self.release("9.0.0")
        sums = (self.source / "executor-v9.0.0" / "SHA256SUMS").read_text().encode()
        urls = []

        def get(url, accept, auth=True):
            urls.append(url)
            if url.endswith("/releases/tags/executor-v9.0.0"):
                return json.dumps({"assets": [{"name": f"{dx.PACKAGE}-9.0.0.tar.gz", "url": "https://api.github.test/a/1"}, {"name": "SHA256SUMS", "url": "https://api.github.test/a/2"}]}).encode()
            return {"https://api.github.test/a/1": archive, "https://api.github.test/a/2": sums}[url]
        self.ex.http_get = get
        self.ex.cfg.update(github_api="https://api.github.test", upgrade_from="acme/open-atlas-deployer")
        self.assertEqual(self.ex.beat_body(None, {})["upgradeFrom"], "github")
        with self.assertRaises(dx.Restarting):
            self.upgrade("9.0.0")
        self.assertEqual(urls[0], "https://api.github.test/repos/acme/open-atlas-deployer/releases/tags/executor-v9.0.0")


class DeployerUpgradeTest(unittest.TestCase):
    """D16: the Deployer's image switched on its host, its state backed up first and put back when the new one fails."""

    def setUp(self):
        import subprocess
        self.subprocess = subprocess
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.dir = self.root / "deployer"
        (self.dir / "data").mkdir(parents=True)
        (self.dir / "data" / "deployer.db").write_text("state v1")
        (self.dir / "compose.yaml").write_text('services:\n  deployer:\n    image: "${DEPLOYER_IMAGE}"\n')
        (self.dir / ".env").write_text("DEPLOYER_IMAGE=localhost:5000/open-atlas-deployer:0.1.0@sha256:old\nCOMPOSE_FILE_NOTE=kept\n")
        self.api = FakeApi()
        self.devnull = open("/dev/null", "w")
        self.addCleanup(self.devnull.close)
        self.ex = dx.Executor(cfg(self.root, deployer_dir=self.dir, deployer_image="localhost:5000/open-atlas-deployer", health_seconds=0),
                              out=self.devnull, api=self.api)
        self.ex.sleep = lambda s: None
        self.ran, self.labels, self.healthy, self.new_answers = [], {"org.open-atlas.version": "0.2.0", "org.open-atlas.executor-protocols": "2"}, True, True
        self.ex.sh = self.sh

    def tearDown(self):
        self.tmp.cleanup()

    def sh(self, args, **kw):
        self.ran.append(args)
        out = ""
        if args[0] == "tar":
            p = self.subprocess.run(args, capture_output=True, text=True)
            assert p.returncode == 0, p.stderr
        elif args[:3] == ["docker", "image", "inspect"]:
            out = json.dumps(["localhost:5000/open-atlas-deployer@sha256:new"]) if "RepoDigests" in args[4] else json.dumps(self.labels)
        elif "ps" in args:
            out = "cid1"
        elif args[:2] == ["docker", "inspect"]:
            out = "running|healthy|0|img" if self.healthy else "running|unhealthy|0|img"
        elif args[-2:] == ["up", "-d"]:
            # The new version starts on the state: it changes it, and answers as itself when it works.
            env = (self.dir / ".env").read_text()
            if "sha256:new" in env:
                (self.dir / "data" / "deployer.db").write_text("state v2")
                self.api.deployer = "0.2.0" if self.new_answers else "0.1.0"
            else:
                self.api.deployer = "0.1.0"
        return type("P", (), {"returncode": 0, "stdout": out, "stderr": ""})()

    def upgrade(self, version="0.2.0", job="deployer-upgrade-0001"):
        self.api.queue.append({"protocol": 2, "id": job, "kind": "deployer-upgrade", "version": version})
        self.assertTrue(self.ex.run_once())
        return self.api.status[job]

    def test_switches_the_image_after_backing_up_the_state_with_the_deployer_stopped(self):
        status = self.upgrade()
        self.assertEqual(status["state"], "succeeded", status.get("message"))
        self.assertEqual([x["name"] for x in status["steps"]], ["pull", "backup", "switch", "verify"])
        self.assertEqual((self.dir / ".env").read_text(), "COMPOSE_FILE_NOTE=kept\nDEPLOYER_IMAGE=localhost:5000/open-atlas-deployer:0.2.0@sha256:new\n")
        self.assertIn("sha256:old", (self.dir / ".env.previous").read_text())
        compose = [a[6:] for a in self.ran if a[:2] == ["docker", "compose"] and "ps" not in a]
        self.assertEqual(compose, [["stop"], ["up", "-d"]])
        pull = self.ran.index(["docker", "pull", "--quiet", "localhost:5000/open-atlas-deployer:0.2.0"])
        stop, tar = self.ran.index(["docker", "compose", "-p", "open-atlas-deployer", "-f", "compose.yaml", "stop"]), next(i for i, a in enumerate(self.ran) if a[:2] == ["tar", "czf"])
        self.assertLess(pull, stop, "pulled before anything stops")
        self.assertLess(stop, tar, "the state is copied with the Deployer stopped")
        backups = list((self.ex.cfg["backups"] / "deployer").glob("deployer-data-before-0.2.0-*.tar.gz"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(self.api.beats[-1]["deployer"], {"image": "localhost:5000/open-atlas-deployer"})

    def test_a_new_version_that_does_not_answer_goes_back_with_the_state_from_before(self):
        self.new_answers = False
        status = self.upgrade()
        self.assertEqual(status["state"], "rolled-back", status.get("message"))
        self.assertIn("did not come up (it answers as 0.1.0)", status["message"])
        self.assertEqual([(x["name"], x["state"]) for x in status["steps"]][-2:], [("verify", "failed"), ("rollback", "done")])
        self.assertIn("sha256:old", (self.dir / ".env").read_text())
        self.assertEqual((self.dir / "data" / "deployer.db").read_text(), "state v1", "the state from before the upgrade")
        failed = pathlib.Path(status["result"]["failedData"])
        self.assertEqual((failed / "deployer.db").read_text(), "state v2", "what the new version left is kept aside")

    def test_refuses_before_touching_anything(self):
        cases = []
        self.labels = {"org.open-atlas.version": "0.3.0"}
        cases.append(("0.2.0", "says it is version 0.3.0"))
        for i, (version, message) in enumerate(cases):
            status = self.upgrade(version, job=f"deployer-upgrade-{i:04d}")
            self.assertEqual(status["state"], "refused")
            self.assertIn(message, status["message"])
        self.labels = {"org.open-atlas.version": "0.2.0", "org.open-atlas.executor-protocols": "3"}
        self.assertIn("upgrade the executors first", self.upgrade(job="deployer-upgrade-proto")["message"])
        self.ex.cfg["deployer_image"] = "docker.io/someone/deployer"
        self.assertIn("not a repository in a registered registry", self.upgrade(job="deployer-upgrade-reg")["message"])
        self.ex.cfg["deployer_dir"] = None
        self.assertIn("does not run the Deployer", self.upgrade(job="deployer-upgrade-none")["message"])
        self.assertFalse(any(a[:2] == ["docker", "compose"] and "ps" not in a for a in self.ran), "nothing was stopped or started")
        self.assertIn("sha256:old", (self.dir / ".env").read_text())

    def test_refuses_when_the_compose_file_names_another_project(self):
        (self.dir / "compose.yaml").write_text('name: open-atlas-deployer-prod\nservices:\n  deployer:\n    image: "${DEPLOYER_IMAGE}"\n')
        status = self.upgrade()
        self.assertEqual(status["state"], "refused")
        self.assertIn("names project open-atlas-deployer-prod", status["message"])
        self.assertFalse(any(a[:2] == ["docker", "compose"] for a in self.ran), "no project was stopped")
        (self.dir / "compose.yaml").write_text('name: "open-atlas-deployer"\nservices:\n  deployer:\n    image: "${DEPLOYER_IMAGE}"\n')
        self.assertEqual(self.upgrade(job="deployer-upgrade-same")["state"], "succeeded")

    def test_compose_failing_to_start_the_new_version_goes_back_too(self):
        real = self.sh

        def refusing(args, **kw):
            if args[-2:] == ["up", "-d"] and "sha256:new" in (self.dir / ".env").read_text():
                self.ran.append(args)
                raise dx.Failed("docker compose -p failed (exit 1): container name already in use")
            return real(args, **kw)
        self.ex.sh = refusing
        status = self.upgrade()
        self.assertEqual(status["state"], "rolled-back", status.get("message"))
        self.assertIn("docker compose up failed", status["message"])
        self.assertIn("sha256:old", (self.dir / ".env").read_text(), "the previous image is back in .env")
        self.assertEqual((self.dir / "data" / "deployer.db").read_text(), "state v1")
        ups = [a for a in self.ran if a[-2:] == ["up", "-d"]]
        self.assertEqual(len(ups), 2, "the new version was tried, then the previous one started again")

    def test_statuses_the_deployer_could_not_take_are_sent_once_it_answers(self):
        real = self.sh

        def going_down(args, **kw):
            if args[-1:] == ["stop"]:
                self.api.down = True
            if args[-2:] == ["up", "-d"]:
                self.api.down = False
            return real(args, **kw)
        self.ex.sh = going_down
        self.api.queue.append({"protocol": 2, "id": "deployer-upgrade-0009", "kind": "deployer-upgrade", "version": "0.2.0"})
        self.api.down = False
        self.ex.run_once()
        self.assertEqual(self.api.status["deployer-upgrade-0009"]["state"], "succeeded")
        # While it was down, a status was kept; once delivered nothing is left.
        self.api.down = True
        self.ex.write_status({"id": "deployer-upgrade-0010", "state": "succeeded", "steps": [], "result": {}})
        self.assertTrue((self.ex.pending_dir() / "deployer-upgrade-0010.json").is_file())
        self.api.down = False
        self.ex.deliver_pending()
        self.assertEqual(self.api.status["deployer-upgrade-0010"]["state"], "succeeded")
        self.assertFalse(list(self.ex.pending_dir().glob("*.json")))


class FragmentTest(unittest.TestCase):
    def test_reads_service_names_from_a_generated_fragment(self):
        with tempfile.TemporaryDirectory() as d:
            f = pathlib.Path(d) / "compose.yaml"
            f.write_text('# Generated\nservices:\n  broker:\n    image: "x:1"\n  dossier-proxy:\n    image: "caddy:2"\n    labels:\n      a: "b"\n')
            self.assertEqual(dx.Executor(cfg(d)).fragment_services(f), ["broker", "dossier-proxy"])


if __name__ == "__main__":
    unittest.main()
