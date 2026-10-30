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
        self.ex = dx.Executor(cfg(self.root), out=open("/dev/null", "w") if pathlib.Path("/dev/null").exists() else sys.stderr)
        self.ran = []
        self.ex.sh = lambda args, **kw: self.ran.append(args) or type("P", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    def tearDown(self):
        self.tmp.cleanup()

    def submit(self, request):
        handoff = self.ex.cfg["handoff"]
        (handoff / "requests").mkdir(parents=True, exist_ok=True)
        dx.write_json(handoff / "requests" / f"{request['id']}.json", request)
        self.assertTrue(self.ex.run_once())
        return json.loads((handoff / "jobs" / request["id"] / "status.json").read_text())

    def test_build_refuses_other_scripts_registries_and_names(self):
        base = {"protocol": 1, "kind": "build", "app": "shop", "version": "1.2.0", "registry": "ghcr.io/acme", "image": "open-atlas-shop",
                "build": {"repo": "acme/shop", "tag": "shop-1.2.0", "script": "build-images.sh", "platform": "linux/amd64"}}
        cases = [({"build": {**base["build"], "script": "rm -rf /"}}, "build-images.sh"),
                 ({"registry": "ghcr.io/evil"}, "not registered"),
                 ({"image": "shop"}, "names the image"),
                 ({"protocol": 9}, "protocol 9")]
        for i, (over, word) in enumerate(cases):
            status = self.submit({**base, **over, "id": f"build-job-{i:04d}"})
            self.assertEqual(status["state"], "refused")
            self.assertIn(word, status["message"])
        self.assertEqual(self.ran[-1][:2], ["docker", "ps"], "only the state report ran")

    def test_deploy_refuses_a_root_for_another_project_or_a_missing_include(self):
        base = {"protocol": 1, "kind": "deploy", "app": "shop", "version": "1.2.0", "services": ["shop"], "fragment": "services: {}",
                "root": 'name: "open-atlas"\ninclude:\n  - path: "shop/compose.yaml"\n'}
        status = self.submit({**base, "id": "deploy-job-0001", "root": 'name: "elsewhere"\n'})
        self.assertIn("not for project", status["message"])
        status = self.submit({**base, "id": "deploy-job-0002", "root": 'name: "open-atlas"\ninclude: []\n'})
        self.assertIn("exactly once", status["message"])
        status = self.submit({**base, "id": "deploy-job-0003", "services": ["Bad Name"]})
        self.assertIn("malformed", status["message"])

    def env_request(self, job_id, content, **over):
        import hashlib
        req = {"protocol": 1, "kind": "env", "id": job_id, "app": "shop", "revision": 3, "file": "shop.env",
               "content": content, "sha256": hashlib.sha256(content.encode()).hexdigest(), "restart": False, "services": []}
        req.update(over)
        return req

    def test_env_write_checks_the_hash_and_drops_the_content_from_the_request(self):
        status = self.submit(self.env_request("env-job-0001", "A=1\n", sha256="0" * 64))
        self.assertEqual(status["state"], "refused")
        self.assertIn("sha256", status["message"])
        kept = json.loads((self.ex.cfg["handoff"] / "jobs" / "env-job-0001" / "request.json").read_text())
        self.assertNotIn("content", kept)
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
        self.assertNotIn("A=1", (self.ex.cfg["handoff"] / "jobs" / "env-job-0003" / "log.txt").read_text())

    def test_env_write_with_restart_needs_a_fragment_from_the_deployer(self):
        status = self.submit(self.env_request("env-job-0004", "A=1\n", restart=True, services=["shop"]))
        self.assertEqual(status["state"], "refused")
        self.assertIn("no compose fragment", status["message"])

    def test_env_read_copies_the_file_for_the_deployer_and_cleans_it_up_later(self):
        import os
        status = self.submit({"protocol": 1, "kind": "env-read", "id": "env-read-0001", "app": "shop", "file": "shop.env"})
        self.assertEqual(status["result"]["env"], {"exists": False})
        (self.root / "shop.env").write_text("SECRET=s3\n")
        status = self.submit({"protocol": 1, "kind": "env-read", "id": "env-read-0002", "app": "shop", "file": "shop.env"})
        copy = self.ex.cfg["handoff"] / "jobs" / "env-read-0002" / "env.content"
        self.assertEqual(copy.read_text(), "SECRET=s3\n")
        self.assertEqual(copy.stat().st_mode & 0o777, 0o600)
        self.assertEqual(status["result"]["env"]["bytes"], 10)
        os.utime(copy, (0, 0))
        self.ex.remove_env_copies()
        self.assertFalse(copy.exists())

    def test_a_job_left_running_is_marked_interrupted(self):
        job = self.ex.cfg["handoff"] / "jobs" / "deploy-job-0009"
        dx.write_json(job / "status.json", {"id": job.name, "state": "running", "steps": []})
        self.ex.recover()
        self.assertEqual(json.loads((job / "status.json").read_text())["state"], "failed")

    def test_heartbeat_names_protocols_and_database_backups(self):
        self.ex.cfg["db"] = dx.config(environ={"EXECUTOR_DB_DUMP_DOSSIER": "docker exec db pg_dump"})["db"]
        self.ex.heartbeat()
        beat = json.loads((self.ex.cfg["handoff"] / "executor.json").read_text())
        self.assertEqual(beat["protocols"], [1])
        self.assertEqual(beat["kinds"], ["build", "deploy", "env", "env-read", "bundle", "db-migration"])
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


class FragmentTest(unittest.TestCase):
    def test_reads_service_names_from_a_generated_fragment(self):
        with tempfile.TemporaryDirectory() as d:
            f = pathlib.Path(d) / "compose.yaml"
            f.write_text('# Generated\nservices:\n  broker:\n    image: "x:1"\n  dossier-proxy:\n    image: "caddy:2"\n    labels:\n      a: "b"\n')
            self.assertEqual(dx.Executor(cfg(d)).fragment_services(f), ["broker", "dossier-proxy"])


if __name__ == "__main__":
    unittest.main()
