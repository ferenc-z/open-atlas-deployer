#!/usr/bin/env python3
"""S37 step 6: the lab's S2S hand-over n112 (1.12.1) -> c250 (2.5.0 cluster), for the provenance trace.

s2s.py setup      builds it (idempotent, looks components up by name):
                  c250: root input port "from-n112" (remote access) -> UpdateAttribute "c250 load" (success auto-terminated);
                        user CN=n112.lab, OU=NIFI with /site-to-site read and "receive data via site-to-site" on the port.
                  n112: GenerateFlowFile "n112 gen" (300 s) -> UpdateAttribute "n112 rename" (filename orders-<time>.csv)
                        -> remote process group to https://localhost:18445/nifi, port from-n112 (HTTP, transmitting).
s2s.py generate   one FlowFile: starts "n112 gen" and stops it again (1.12 has no "run once").
s2s.py ids        the component ids (also written to s2s.ids.json).
s2s.py port start|stop   the receiving port on c250.
s2s.py hide|show  a component-level "view provenance" policy on c250's port that holds nobody (hide) or its
                  removal (show): the monitor then cannot see the port's events, as if they were gone.
Runs as the operator (initial admin) certificate.
"""
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

LAB = os.path.expanduser("~/nifi-lab")
PEM = f"{LAB}/certs/pem"
N112, C250 = "https://localhost:18443/nifi-api", "https://localhost:18445/nifi-api"
N112_DN = "CN=n112.lab, OU=NIFI"
IDS = f"{LAB}/s2s.ids.json"

ctx = ssl.create_default_context(cafile=f"{PEM}/ca.crt")
ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
ctx.load_cert_chain(f"{PEM}/operator.crt", f"{PEM}/operator.key")


def call(base, method, path, body=None, ok=(200, 201)):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        if e.code in ok:
            return {}
        raise SystemExit(f"{method} {base}{path}: HTTP {e.code}: {text[:400]}")


def flow(base):
    return call(base, "GET", "/flow/process-groups/root")["processGroupFlow"]


def find(items, name):
    return next((x for x in items if (x.get("component") or {}).get("name") == name), None)


def proc(base, root, name, ptype, props, auto=(), period=None):
    got = find(flow(base)["flow"]["processors"], name)
    if got:
        return got["id"]
    config = {"properties": props, "autoTerminatedRelationships": list(auto)}
    if period:
        config["schedulingPeriod"] = period
    return call(base, "POST", f"/process-groups/{root}/processors", {"revision": {"version": 0}, "component": {"type": ptype, "name": name, "position": {"x": 0, "y": 200}, "config": config}})["id"]


def connect(base, root, src, dst, rels):
    for c in flow(base)["flow"]["connections"]:
        cc = c["component"]
        if cc["source"]["id"] == src["id"] and cc["destination"]["id"] == dst["id"]:
            return c["id"]
    return call(base, "POST", f"/process-groups/{root}/connections", {"revision": {"version": 0}, "component": {"source": src, "destination": dst, "selectedRelationships": rels}})["id"]


def run(base, kind, cid, state):
    ent = call(base, "GET", f"/{kind}/{cid}")
    call(base, "PUT", f"/{kind}/{cid}/run-status", {"revision": ent["revision"], "state": state})


def setup():
    ids = {}
    # c250
    f = flow(C250)
    root = f["id"]
    port = find(f["flow"]["inputPorts"], "from-n112")
    if not port:
        port = call(C250, "POST", f"/process-groups/{root}/input-ports", {"revision": {"version": 0}, "component": {"name": "from-n112", "position": {"x": 0, "y": 0}, "allowRemoteAccess": True}})
    ids["c250Port"] = port["id"]
    ids["c250Load"] = proc(C250, root, "c250 load", "org.apache.nifi.processors.attributes.UpdateAttribute", {"loaded": "yes"}, auto=["success"])
    connect(C250, root, {"id": ids["c250Port"], "groupId": root, "type": "INPUT_PORT"}, {"id": ids["c250Load"], "groupId": root, "type": "PROCESSOR"}, [])
    users = call(C250, "GET", "/tenants/users")["users"]
    if not any(u["component"]["identity"] == N112_DN for u in users):
        call(C250, "POST", "/tenants/users", {"revision": {"version": 0}, "component": {"identity": N112_DN}})
    subprocess.run(["python3", "-I", f"{LAB}/grant.py", C250, f"{PEM}/operator.crt", f"{PEM}/operator.key", f"{PEM}/ca.crt",
                    f"/site-to-site|read|{N112_DN}", f"/data-transfer/input-ports/{ids['c250Port']}|write|{N112_DN}"], check=True)
    for kind, cid in (("input-ports", ids["c250Port"]), ("processors", ids["c250Load"])):
        run(C250, kind, cid, "RUNNING")
    # n112
    f = flow(N112)
    root = f["id"]
    ids["n112Gen"] = proc(N112, root, "n112 gen", "org.apache.nifi.processors.standard.GenerateFlowFile", {"File Size": "100B", "Data Format": "Text"}, period="300 sec")
    ids["n112Rename"] = proc(N112, root, "n112 rename", "org.apache.nifi.processors.attributes.UpdateAttribute", {"filename": "orders-${now():format('yyyyMMdd-HHmmss')}.csv"})
    connect(N112, root, {"id": ids["n112Gen"], "groupId": root, "type": "PROCESSOR"}, {"id": ids["n112Rename"], "groupId": root, "type": "PROCESSOR"}, ["success"])
    rpg = find(flow(N112)["flow"]["remoteProcessGroups"], "to-c250")
    if not rpg:
        rpg = call(N112, "POST", f"/process-groups/{root}/remote-process-groups", {"revision": {"version": 0}, "component": {"name": "to-c250", "targetUris": "https://localhost:18445/nifi", "transportProtocol": "HTTP", "position": {"x": 400, "y": 200}}})
    ids["n112Rpg"] = rpg["id"]
    remote = None
    for _ in range(40):
        ent = call(N112, "GET", f"/remote-process-groups/{ids['n112Rpg']}")
        ports = ((ent["component"].get("contents") or {}).get("inputPorts")) or []
        remote = next((p for p in ports if p["name"] == "from-n112"), None)
        if remote:
            break
        time.sleep(3)
    if not remote:
        raise SystemExit(f"the RPG does not see c250's port from-n112 yet: {ent['component'].get('authorizationIssues') or ent['component'].get('validationErrors')}")
    ids["n112RemotePort"] = remote["id"]
    connect(N112, root, {"id": ids["n112Rename"], "groupId": root, "type": "PROCESSOR"}, {"id": remote["id"], "groupId": ids["n112Rpg"], "type": "REMOTE_INPUT_PORT"}, ["success"])
    ent = call(N112, "GET", f"/remote-process-groups/{ids['n112Rpg']}")
    call(N112, "PUT", f"/remote-process-groups/{ids['n112Rpg']}/run-status", {"revision": ent["revision"], "state": "TRANSMITTING"})
    run(N112, "processors", ids["n112Rename"], "RUNNING")
    json.dump(ids, open(IDS, "w"), indent=1)
    print(json.dumps(ids, indent=1))


def ids():
    return json.load(open(IDS))


def hide(on):
    pid = ids()["c250Port"]
    res = f"/provenance-data/input-ports/{pid}"
    pol = call(C250, "GET", f"/policies/read{res}")
    mine = pol.get("component", {}).get("resource") == res
    if on and not mine:
        call(C250, "POST", "/policies", {"revision": {"version": 0}, "component": {"action": "read", "resource": res, "users": [], "userGroups": []}})
    if not on and mine:
        call(C250, "DELETE", f"/policies/{pol['id']}?version={pol['revision']['version']}")
    print("hidden" if on else "shown")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "ids"
    if cmd == "setup":
        setup()
    elif cmd == "generate":
        gid = ids()["n112Gen"]
        run(N112, "processors", gid, "RUNNING")
        time.sleep(2)
        run(N112, "processors", gid, "STOPPED")
        print("one FlowFile generated at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    elif cmd == "port":
        run(C250, "input-ports", ids()["c250Port"], "RUNNING" if sys.argv[2] == "start" else "STOPPED")
    elif cmd in ("hide", "show"):
        hide(cmd == "hide")
    else:
        print(json.dumps(ids(), indent=1))
