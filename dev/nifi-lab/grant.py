#!/usr/bin/env python3
"""Grant the lab's access policies through the NiFi REST API.

grant.py BASE_URL CERT_PEM KEY_PEM CA_PEM 'resource|action|identity' ...

Runs as the operator (initial admin) certificate. For every triple it makes
sure the global policy exists and contains that user; the user must already
exist (they are seeded as "Initial User Identity" in authorizers.xml). A resource
may name the root process group as @root (e.g. /provenance-data/process-groups/@root,
"view provenance" on the whole flow): it is looked up on each instance.
Works on NiFi 1.x and 2.x; on a cluster any node replicates the change.
"""
import json
import ssl
import sys
import time
import urllib.error
import urllib.request


def main():
    base, cert, key, ca, *grants = sys.argv[1:]
    ctx = ssl.create_default_context(cafile=ca)
    # The tls-toolkit CA does not mark Basic Constraints critical; Python 3.13+
    # rejects that under its default VERIFY_X509_STRICT.
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    ctx.load_cert_chain(cert, key)

    def call(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")

    # A fresh cluster answers 409/500 until flow election finishes and nodes connect.
    for _ in range(36):
        status, users = call("GET", "/tenants/users")
        if status == 200 or status in (401, 403):
            break
        time.sleep(5)
    if status != 200:
        sys.exit(f"list users failed: {status} {users}")
    ids = {u["component"]["identity"]: u["id"] for u in users["users"]}
    root = None
    if any("@root" in g for g in grants):
        status, flow = call("GET", "/flow/process-groups/root")
        if status != 200:
            sys.exit(f"root process group: {status} {flow}")
        root = flow["processGroupFlow"]["id"]

    for g in grants:
        resource, action, identity = g.split("|", 2)
        resource = resource.replace("@root", root or "@root")
        uid = ids.get(identity)
        if uid is None:
            sys.exit(f"user not found: {identity}")
        status, pol = call("GET", f"/policies/{action}{resource}")
        if status == 200 and pol["component"]["resource"] == resource:
            users_now = [u["id"] for u in pol["component"].get("users", [])]
            if uid in users_now:
                print(f"ok      {action:5} {resource:24} {identity}")
                continue
            comp = pol["component"]
            comp["users"] = [{"id": i} for i in users_now + [uid]]
            status, res = call("PUT", f"/policies/{pol['id']}",
                               {"revision": pol["revision"], "component": comp})
        else:
            # 404, or the closest inherited policy came back: create one.
            status, res = call("POST", "/policies", {
                "revision": {"version": 0},
                "component": {"resource": resource, "action": action,
                              "users": [{"id": uid}], "userGroups": []}})
        if status not in (200, 201):
            sys.exit(f"grant {g} failed: {status} {res}")
        print(f"granted {action:5} {resource:24} {identity}")


if __name__ == "__main__":
    main()
