#!/usr/bin/env python3
"""Builds the complex lab flows of spec.yaml on the lab NiFis (designs/open-atlas-deployer-service-ops/complex-lab-flows.md).

build.py              build what is missing (a top-level cx- group that exists is left as it is), wire the root links
                      and the S2S (users, policies, RPGs), then start everything (groups with start: false stay stopped)
build.py --status     per instance: processors in cx- groups, running / invalid, queued, the S2S and heap
build.py --stop       stop every cx- group and its RPGs (the flows stay)
build.py --start      start them again
build.py --delete     stop, empty the queues and delete every cx- group, the cx- root ports on n192 and the root links
build.py --rebuild    --delete, then build
--only n112,c250      limit to some instances

Runs as the lab's operator certificate (initial admin); NiFi 1.9.2, 1.12.1, 2.0.0 and 2.5.0 (cluster).
"""
import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.expanduser("~/nifi-lab")
PEM = f"{LAB}/certs/pem"
PREFIX = "cx-"
CTX = ssl.create_default_context(cafile=f"{PEM}/ca.crt")
CTX.verify_flags &= ~ssl.VERIFY_X509_STRICT  # the toolkit CA does not mark Basic Constraints critical
CTX.load_cert_chain(f"{PEM}/operator.crt", f"{PEM}/operator.key")

# kind -> (candidate processor types, default relationship of an edge out of it, fixed properties)
KINDS = {
    "G": (["GenerateFlowFile"], "success", {"Data Format": "Text", "Unique FlowFiles": "false", "File Size": "0B"}),
    "U": (["UpdateAttribute"], "success", {}),
    "R": (["RouteOnAttribute"], None, {"Routing Strategy": "Route to Property name"}),
    "RC": (["RouteOnContent"], None, {}),
    "T": (["ReplaceText"], "success", {"Replacement Strategy": "Always Replace", "Evaluation Mode": "Entire text"}),
    "J": (["EvaluateJsonPath"], "matched", {"Destination": "flowfile-attribute"}),
    "S": (["SplitText"], "splits", {"Line Split Count": "1", "Header Line Count": "0"}),
    "SJ": (["SplitJson"], "split", {}),
    "M": (["MergeContent"], "merged", {"Merge Strategy": "Bin-Packing Algorithm"}),
    "L": (["LogAttribute"], "success", {"Log Level": "debug", "Log Payload": "false"}),
    "LM": (["LogMessage"], "success", {"log-level": "debug"}),
    "A": (["AttributesToJSON"], "success", {}),
    "C": (["ConvertRecord"], "success", {}),
    "F": (["PutFile"], "success", {"Conflict Resolution Strategy": "replace", "Create Missing Directories": "true"}),
    "GF": (["GetFile"], "success", {"Keep Source File": "false", "Polling Interval": "10 sec"}),
    "LF": (["ListFile"], "success", {}),
    "FF": (["FetchFile"], "success", {}),
    "LH": (["ListenHTTP"], "success", {}),
    "IH": (["InvokeHTTP"], "Response", {}),
    "CR": (["ControlRate"], "success", {}),
    "Z": (["CompressContent"], "success", {"Mode": "compress", "Compression Format": "gzip"}),
    "H": (["CryptographicHashContent", "HashContent"], "success", {}),
    "D": (["DuplicateFlowFile"], "success", {}),
    "MT": (["IdentifyMimeType"], "success", {}),
    "RF": (["RetryFlowFile"], "retry", {}),
}
PORTS = {"in", "out", "rin", "fn", "rpg"}
ALIASES = {"url": ["HTTP URL", "Remote URL"], "HTTP Method": ["HTTP Method"]}
DYNAMIC = {"U", "R", "J", "G", "RC"}
TOKEN = re.compile(r"^(?:(?P<k>[A-Za-z]+):)?(?P<name>.+?)(?:\[(?P<rels>[^\]]+)\])?$")


class Nifi:
    def __init__(self, name, cfg):
        self.name, self.cfg, self.base = name, cfg, cfg["api"]
        self.ver = self.version()
        self.v19 = self.ver.startswith("1.9.")  # no allowRemoteAccess: S2S input ports only on root
        self._types = None

    def call(self, method, path, body=None, ok=(200, 201, 202)):
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(6):
            req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, context=CTX, timeout=60) as r:
                    return json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                text = e.read().decode(errors="replace")
                if e.code == 409 and attempt < 5 and ("transitioning" in text or "replicat" in text or "Cluster" in text):
                    time.sleep(2)
                    continue
                raise SystemExit(f"{self.name}: {method} {path}: HTTP {e.code}: {text[:500]}")

    def version(self):
        return self.call("GET", "/flow/about")["about"]["version"]

    def types(self):
        if self._types is None:
            self._types = {}
            for t in self.call("GET", "/flow/processor-types")["processorTypes"]:
                self._types.setdefault(t["type"].rsplit(".", 1)[1], t)
        return self._types

    def root(self):
        return self.call("GET", "/flow/process-groups/root")["processGroupFlow"]

    def flow(self, pg):
        return self.call("GET", f"/flow/process-groups/{pg}")["processGroupFlow"]["flow"]


def nm(e):
    return (e.get("component") or {}).get("name")


# ---------------------------------------------------------------- parse

def parse(gspec):
    """nodes: name -> {kind, props}; edges: (src ref, rels, dst ref); a ref is a node name or 'Sub/port'."""
    nodes, edges = {}, []
    props = gspec.get("props") or {}
    defined, files = set(), set()
    for path in gspec.get("paths") or []:  # first pass: what is defined anywhere (a ref may come before its definition)
        for raw in [t.strip() for t in path.split(" > ")]:
            m = TOKEN.match(raw)
            if m.group("k") in KINDS or m.group("k") in PORTS:
                defined.add(m.group("name").strip())
                if m.group("k") == "F":
                    files.add(m.group("name").strip())
    for path in gspec.get("paths") or []:
        prev = None
        for raw in [t.strip() for t in path.split(" > ")]:
            m = TOKEN.match(raw)
            k, name, rels = m.group("k"), m.group("name").strip(), m.group("rels")
            if k and k not in KINDS and k not in PORTS:
                k, name = None, raw  # a colon inside a name
            if k == "rpg":
                name = f"rpg:{name}"
            chain = []
            if k:
                if name not in nodes:
                    if k == "F":
                        auto = f"Set file name ({name})"
                        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]
                        nodes[auto] = {"kind": "U", "props": {"filename": f"{slug}-${{now():format('mm')}}.dat"}}
                        nodes[name] = {"kind": k, "props": props.get(name) or {}}
                        edges.append((auto, None, name))
                        chain = [auto]
                    else:
                        nodes[name] = {"kind": k, "props": props.get(name) or {}}
                elif k == "F":
                    chain = [f"Set file name ({name})"]
            elif "/" not in name and name not in defined:
                raise SystemExit(f"{gspec['name']}: unknown node {name!r} in {path!r}")
            elif name in files and prev is not None:
                chain = [f"Set file name ({name})"]
            entry = chain[0] if chain else name
            if prev is not None:
                edges.append((prev[0], prev[1], entry))
            prev = (name, [r.strip() for r in rels.split(",")] if rels else None)
    for name in props:
        if name not in nodes and not name.startswith("Set file name ("):
            raise SystemExit(f"{gspec['name']}: props for unknown node {name!r}")
    return nodes, edges


# ---------------------------------------------------------------- build

class Builder:
    def __init__(self, spec, nifis):
        self.spec, self.n = spec, nifis
        self.out = os.path.expanduser(spec["dirs"]["out"])
        self.mq = os.path.expanduser(spec["dirs"]["mq"])
        # (inst, pg id, source endpoint, rels, target "inst#port"): the S2S connections still to make, kept on disk so a
        # run that stops half-way (or --only without the target) picks them up next time
        self.state = f"{LAB}/cx/pending-s2s.json"
        self.pending = json.load(open(self.state)) if os.path.exists(self.state) else []
        self.pos = {}

    def place(self, pg):
        i = self.pos[pg] = self.pos.get(pg, -1) + 1
        return {"x": (i % 6) * 420.0, "y": (i // 6) * 260.0}

    def create_proc(self, nf, pg, name, kind, props, cluster):
        types, default_rel, fixed = KINDS[kind]
        t = next((nf.types()[c] for c in types if c in nf.types()), None)
        if not t:
            raise SystemExit(f"{nf.name}: no processor type for {kind} ({types})")
        ent = nf.call("POST", f"/process-groups/{pg}/processors", {"revision": {"version": 0}, "component": {
            "type": t["type"], "bundle": t["bundle"], "name": name, "position": self.place(pg)}})
        return ent

    def resolve_props(self, nf, kind, name, props, ent, inst, cs):
        desc = ent["component"]["config"]["descriptors"]
        by = {}
        for d in desc.values():
            by[d["name"].lower()] = d["name"]
            by[(d.get("displayName") or d["name"]).lower()] = d["name"]
        out, conf = {}, {}

        def put(key, value):
            for cand in [key] + ALIASES.get(key, []):
                if cand.lower() in by:
                    out[by[cand.lower()]] = str(value)
                    return
            if kind in DYNAMIC:
                out[key] = str(value)
            else:
                raise SystemExit(f"{nf.name}: {name}: no property {key!r} on {ent['component']['type']}")

        for k, v in KINDS[kind][2].items():
            if k.lower() in by:
                put(k, v)
        for k, v in props.items():
            if k == "period":
                conf["schedulingPeriod"] = v
            elif k == "text" and kind == "G":
                put("Custom Text", v)
            elif k == "text" and kind == "T":
                put("Replacement Value", v)
            elif k == "dir" and kind == "F":
                put("Directory", os.path.normpath(f"{self.out}/{inst}/{v}"))
            elif k == "dir" and kind in ("GF", "LF"):
                put("Input Directory", os.path.normpath(f"{self.mq}/{v}"))
            elif k == "port":
                put("Listening Port", v)
            elif k == "path":
                put("Base Path", v)
            elif k == "entries":
                put("Minimum Number of Entries", v)
                put("Maximum Number of Entries", max(int(v), 1) * 2)
            elif k == "age":
                put("Max Bin Age", v)
            elif k == "retries":
                put("Maximum Retries", v)
            else:
                put(k, v)
        if kind == "G" and "schedulingPeriod" not in conf:
            conf["schedulingPeriod"] = "60 sec"
        if kind == "D" and "Number of Copies" not in props:
            put("Number of Copies", 1)
        if kind == "C":
            put("Record Reader", cs["reader"])
            put("Record Writer", cs["writer"])
        if kind == "IH" and "HTTP Method" not in props:
            put("HTTP Method", "POST")
        return out, conf

    def services(self, nf, pg):
        got = {}
        for key, typ in (("reader", "org.apache.nifi.csv.CSVReader"), ("writer", "org.apache.nifi.json.JsonRecordSetWriter")):
            ent = nf.call("POST", f"/process-groups/{pg}/controller-services", {"revision": {"version": 0}, "component": {
                "type": typ, "name": f"cx {'CSV reader' if key == 'reader' else 'JSON writer'}"}})
            got[key] = ent["id"]
        return got

    def build_group(self, inst, nf, parent, gspec, top):
        cluster = bool(self.spec["instances"][inst].get("cluster"))
        if gspec["name"] == "(root)":
            pg = parent
        else:
            pos = self.place(parent) if not top else {"x": (top - 1) % 5 * 520.0, "y": 1800.0 + (top - 1) // 5 * 300.0}
            pg = nf.call("POST", f"/process-groups/{parent}/process-groups", {"revision": {"version": 0}, "component": {
                "name": gspec["name"], "position": pos, "comments": gspec.get("trap") or gspec.get("note") or ""}})["id"]
        children = {s["name"]: self.build_group(inst, nf, pg, s, 0) for s in gspec.get("sub") or []}
        nodes, edges = parse(gspec)
        cs = self.services(nf, pg) if any(n["kind"] == "C" for n in nodes.values()) else None
        used = {}
        for s, rels, d in edges:
            if s in nodes and nodes[s]["kind"] in KINDS:
                r = rels or [KINDS[nodes[s]["kind"]][1]]
                if None in r:
                    raise SystemExit(f"{gspec['name']}: edge {s} > {d} needs [relationships]")
                used.setdefault(s, set()).update(r)
        ep = {}
        for name, n in nodes.items():
            k = n["kind"]
            if k in ("in", "rin"):
                comp = {"name": name, "position": self.place(pg)}
                if k == "rin" and not nf.v19 and gspec["name"] != "(root)":
                    comp["allowRemoteAccess"] = True
                e = nf.call("POST", f"/process-groups/{pg}/input-ports", {"revision": {"version": 0}, "component": comp})
                ep[name] = {"id": e["id"], "groupId": pg, "type": "INPUT_PORT"}
            elif k == "out":
                e = nf.call("POST", f"/process-groups/{pg}/output-ports", {"revision": {"version": 0}, "component": {"name": name, "position": self.place(pg)}})
                ep[name] = {"id": e["id"], "groupId": pg, "type": "OUTPUT_PORT"}
            elif k == "fn":
                e = nf.call("POST", f"/process-groups/{pg}/funnels", {"revision": {"version": 0}, "component": {"position": self.place(pg)}})
                ep[name] = {"id": e["id"], "groupId": pg, "type": "FUNNEL"}
            elif k == "rpg":
                continue
            else:
                ent = self.create_proc(nf, pg, name, k, n["props"], cluster)
                props, conf = self.resolve_props(nf, k, name, n["props"], ent, inst, cs)
                conf["properties"] = props
                if cluster and k in ("G", "GF", "LF"):
                    conf["executionNode"] = "PRIMARY"
                # dynamic relationships (RouteOnAttribute routes) exist once the properties are set
                ent = nf.call("PUT", f"/processors/{ent['id']}", {"revision": ent["revision"], "component": {"id": ent["id"], "config": conf}})
                rels = [r["name"] for r in ent["component"].get("relationships") or []]
                bad = used.get(name, set()) - set(rels)
                if bad:
                    raise SystemExit(f"{nf.name}: {gspec['name']}/{name}: no relationship {sorted(bad)} (has {rels})")
                auto = [r for r in rels if r not in used.get(name, set())]
                if auto:
                    nf.call("PUT", f"/processors/{ent['id']}", {"revision": ent["revision"], "component": {"id": ent["id"], "config": {"autoTerminatedRelationships": auto}}})
                ep[name] = {"id": ent["id"], "groupId": pg, "type": "PROCESSOR"}

        def endpoint(ref):
            if ref in ep:
                return ep[ref]
            sub, port = ref.split("/", 1)
            return children[sub]["ports"][port]

        for s, rels, d in edges:
            src = endpoint(s)
            r = rels or ([KINDS[nodes[s]["kind"]][1]] if s in nodes and nodes[s]["kind"] in KINDS else [])
            if d.startswith("rpg:"):
                self.pending.append((inst, pg, src, r, d[4:]))
                continue
            nf.call("POST", f"/process-groups/{pg}/connections", {"revision": {"version": 0}, "component": {
                "source": src, "destination": endpoint(d), "selectedRelationships": r}})
        return {"pg": pg, "ports": {k: v for k, v in ep.items() if v["type"] in ("INPUT_PORT", "OUTPUT_PORT")}}

    def build(self, only):
        for inst, nf in self.n.items():
            if inst not in only:
                continue
            root = nf.root()
            have = {nm(g) for g in root["flow"]["processGroups"]}
            root_ports = {nm(p) for p in root["flow"]["inputPorts"]}
            mine = [g for g in self.spec["groups"] if g["instance"] == inst]
            for i, g in enumerate(mine, 1):
                if g["name"] in have:
                    print(f"{inst}: {g['name']} exists, left as it is")
                    continue
                if g["name"] == "(root)":
                    g = {**g, "paths": [p for p in g["paths"] if p.split(":", 1)[1] not in root_ports]}
                    if not g["paths"]:
                        continue
                self.build_group(inst, nf, root["id"], g, i)
                self.save()
                print(f"{inst}: built {g['name']}")
            self.links(inst, nf)
        self.s2s(only)
        self.start(only, True)

    def top_ports(self, nf):
        """(group name, port name) -> endpoint for the cx- groups' top-level ports and root's cx- ports."""
        root = nf.root()
        got = {}
        for p in root["flow"]["inputPorts"]:
            if nm(p).startswith(PREFIX):
                got[("(root)", nm(p))] = {"id": p["id"], "groupId": root["id"], "type": "INPUT_PORT", "remote": True}
        for g in root["flow"]["processGroups"]:
            if not nm(g).startswith(PREFIX):
                continue
            f = nf.flow(g["id"])
            for p in f["inputPorts"]:
                remote = (p.get("component") or {}).get("allowRemoteAccess")
                got[(nm(g), nm(p))] = {"id": p["id"], "groupId": g["id"], "type": "INPUT_PORT", "remote": bool(remote)}
            for p in f["outputPorts"]:
                got[(nm(g), nm(p))] = {"id": p["id"], "groupId": g["id"], "type": "OUTPUT_PORT"}
        return root, got

    def links(self, inst, nf):
        root, ports = self.top_ports(nf)
        have = {(c["component"]["source"]["id"], c["component"]["destination"]["id"]) for c in root["flow"]["connections"]}
        for line in (self.spec.get("links") or {}).get(inst, []):
            a, b = [x.strip().rsplit(".", 1) for x in line.split(" > ")]
            src, dst = ports[tuple(a)], ports[tuple(b)]
            if (src["id"], dst["id"]) in have:
                continue
            strip = lambda e: {k: e[k] for k in ("id", "groupId", "type")}
            nf.call("POST", f"/process-groups/{root['id']}/connections", {"revision": {"version": 0}, "component": {
                "source": strip(src), "destination": strip(dst), "selectedRelationships": []}})
        print(f"{inst}: root links ok")

    # ------------------------------------------------------------ S2S

    def remote_port(self, inst, port):
        _, ports = self.top_ports(self.n[inst])
        got = [v for (g, p), v in ports.items() if p == port and v["type"] == "INPUT_PORT" and (v.get("remote") or g == "(root)")]
        if len(got) != 1:
            raise SystemExit(f"{inst}: remote input port {port}: found {len(got)}")
        return got[0]

    def grant(self, nf, resource, action, identities):
        users = {u["component"]["identity"]: u["id"] for u in nf.call("GET", "/tenants/users")["users"]}
        for dn in identities:
            if dn not in users:
                users[dn] = nf.call("POST", "/tenants/users", {"revision": {"version": 0}, "component": {"identity": dn}})["id"]
        want = [users[d] for d in identities]
        try:
            pol = nf.call("GET", f"/policies/{action}{resource}")
        except SystemExit:
            pol = {}
        if pol.get("component", {}).get("resource") == resource:
            now = [u["id"] for u in pol["component"].get("users") or []]
            if all(w in now for w in want):
                return
            comp = pol["component"]
            comp["users"] = [{"id": i} for i in sorted(set(now) | set(want))]
            nf.call("PUT", f"/policies/{pol['id']}", {"revision": pol["revision"], "component": comp})
        else:
            nf.call("POST", "/policies", {"revision": {"version": 0}, "component": {
                "resource": resource, "action": action, "users": [{"id": i} for i in want], "userGroups": []}})

    def save(self):
        os.makedirs(os.path.dirname(self.state), exist_ok=True)
        json.dump(self.pending, open(self.state, "w"), indent=1)

    def s2s(self, only):
        for item in list(self.pending):
            inst, pg, src, rels, target = item
            tinst, port = target.split("#")
            if inst not in self.n or tinst not in self.n:
                print(f"{inst}: S2S -> {target} waits (instance not in this run)")
                continue
            tnf, nf = self.n[tinst], self.n[inst]
            rp = self.remote_port(tinst, port)
            senders = self.spec["instances"][inst]["dn"]
            self.grant(tnf, "/site-to-site", "read", senders)
            self.grant(tnf, f"/data-transfer/input-ports/{rp['id']}", "write", senders)
            uri = self.spec["instances"][tinst]["s2s"]
            f = nf.flow(pg)
            rpg = next((r for r in f["remoteProcessGroups"] if (r.get("component") or {}).get("targetUris", r.get("component", {}).get("targetUri")) == uri), None)
            if not rpg:
                rpg = nf.call("POST", f"/process-groups/{pg}/remote-process-groups", {"revision": {"version": 0}, "component": {
                    "name": f"to {tinst}", "targetUris": uri, "transportProtocol": "HTTP", "position": self.place(pg)}})
            remote = None
            for _ in range(60):
                ent = nf.call("GET", f"/remote-process-groups/{rpg['id']}")
                ports = ((ent["component"].get("contents") or {}).get("inputPorts")) or []
                remote = next((p for p in ports if p["name"] == port), None)
                if remote:
                    break
                if _ % 10 == 9:  # ask NiFi to refresh the remote's contents
                    nf.call("PUT", f"/remote-process-groups/{rpg['id']}", {"revision": ent["revision"], "component": {"id": rpg["id"], "targetUris": uri}})
                time.sleep(3)
            if not remote:
                raise SystemExit(f"{inst}: RPG to {tinst} does not see port {port}: {ent['component'].get('authorizationIssues') or ent['component'].get('validationErrors')}")
            nf.call("POST", f"/process-groups/{pg}/connections", {"revision": {"version": 0}, "component": {
                "source": src, "destination": {"id": remote["id"], "groupId": rpg["id"], "type": "REMOTE_INPUT_PORT"}, "selectedRelationships": rels}})
            self.pending.remove(item)
            self.save()
            print(f"{inst}: S2S -> {tinst}#{port} ok")

    # ------------------------------------------------------------ run state

    def cx_groups(self, nf):
        root = nf.root()
        return root, [g for g in root["flow"]["processGroups"] if nm(g).startswith(PREFIX)]

    def walk(self, nf, pg):
        f = nf.flow(pg)
        yield pg, f
        for g in f["processGroups"]:
            yield from self.walk(nf, g["id"])

    def start(self, only, on):
        nostart = {(g["instance"], g["name"]) for g in self.spec["groups"] if g.get("start") is False}
        for inst, nf in self.n.items():
            if inst not in only:
                continue
            root, groups = self.cx_groups(nf)
            for g in groups:
                if on and (inst, nm(g)) in nostart:
                    continue
                if on:
                    for pg, _ in self.walk(nf, g["id"]):
                        if self.has_cs(nf, pg):
                            nf.call("PUT", f"/flow/process-groups/{pg}/controller-services", {"id": pg, "state": "ENABLED"})
                            time.sleep(1)
                nf.call("PUT", f"/flow/process-groups/{g['id']}", {"id": g["id"], "state": "RUNNING" if on else "STOPPED"})
                for pg, f in self.walk(nf, g["id"]):
                    for r in f["remoteProcessGroups"]:
                        ent = nf.call("GET", f"/remote-process-groups/{r['id']}")
                        nf.call("PUT", f"/remote-process-groups/{r['id']}/run-status", {"revision": ent["revision"], "state": "TRANSMITTING" if on else "STOPPED"})
            for p in root["flow"]["inputPorts"]:
                if nm(p).startswith(PREFIX):
                    ent = nf.call("GET", f"/input-ports/{p['id']}")
                    nf.call("PUT", f"/input-ports/{p['id']}/run-status", {"revision": ent["revision"], "state": "RUNNING" if on else "STOPPED"})
            print(f"{inst}: {'started' if on else 'stopped'} {len(groups)} cx- groups")

    def has_cs(self, nf, pg):
        got = nf.call("GET", f"/flow/process-groups/{pg}/controller-services?includeAncestorGroups=false&includeDescendantGroups=false")
        return any(c["component"].get("parentGroupId") == pg for c in got.get("controllerServices") or [])

    def delete(self, only):
        self.start(only, False)
        self.pending = [p for p in self.pending if p[0] not in only]
        self.save()
        for inst, nf in self.n.items():
            if inst not in only:
                continue
            root, groups = self.cx_groups(nf)
            ids = {g["id"] for g in groups}
            cx_root_ports = {p["id"] for p in root["flow"]["inputPorts"] if nm(p).startswith(PREFIX)}
            for c in root["flow"]["connections"]:
                cc = c["component"]
                if cc["source"]["groupId"] in ids or cc["destination"]["groupId"] in ids or cc["source"]["id"] in cx_root_ports:
                    self.drop(nf, c["id"])
                    ent = nf.call("GET", f"/connections/{c['id']}")
                    nf.call("DELETE", f"/connections/{c['id']}?version={ent['revision']['version']}")
            for g in groups:
                for pg, f in self.walk(nf, g["id"]):
                    for c in f["connections"]:
                        self.drop(nf, c["id"])
                    if self.has_cs(nf, pg):
                        nf.call("PUT", f"/flow/process-groups/{pg}/controller-services", {"id": pg, "state": "DISABLED"})
                for _ in range(20):
                    ent = nf.call("GET", f"/process-groups/{g['id']}")
                    req = urllib.request.Request(nf.base + f"/process-groups/{g['id']}?version={ent['revision']['version']}", method="DELETE")
                    try:
                        urllib.request.urlopen(req, context=CTX, timeout=60)
                        break
                    except urllib.error.HTTPError as e:
                        msg = e.read().decode(errors="replace")
                        time.sleep(3)
                else:
                    raise SystemExit(f"{inst}: cannot delete {nm(g)}: {msg[:300]}")
                print(f"{inst}: deleted {nm(g)}")
            for pid in cx_root_ports:
                ent = nf.call("GET", f"/input-ports/{pid}")
                nf.call("DELETE", f"/input-ports/{pid}?version={ent['revision']['version']}")

    def drop(self, nf, cid):
        st = nf.call("GET", f"/flow/connections/{cid}/status")
        snap = st["connectionStatus"]["aggregateSnapshot"]
        if not snap.get("flowFilesQueued"):
            return
        req = nf.call("POST", f"/flowfile-queues/{cid}/drop-requests")
        rid = req["dropRequest"]["id"]
        for _ in range(30):
            if nf.call("GET", f"/flowfile-queues/{cid}/drop-requests/{rid}")["dropRequest"]["finished"]:
                break
            time.sleep(1)
        nf.call("DELETE", f"/flowfile-queues/{cid}/drop-requests/{rid}")

    def status(self, only):
        for inst, nf in self.n.items():
            if inst not in only:
                continue
            _, groups = self.cx_groups(nf)
            procs = running = invalid = queued = 0
            s2s_sent = 0
            bad = []
            for g in groups:
                for pg, f in self.walk(nf, g["id"]):
                    for p in f["processors"]:
                        procs += 1
                        st = p["component"]["state"]
                        running += st == "RUNNING"
                        if p["component"].get("validationStatus") == "INVALID" or st == "INVALID" or p["component"].get("validationErrors"):
                            invalid += 1
                            bad.append(f"{nm(g)}/{nm(p)}: {(p['component'].get('validationErrors') or [''])[0][:120]}")
                    for c in f["connections"]:
                        queued += int((c.get("status") or {}).get("aggregateSnapshot", {}).get("flowFilesQueued", 0) or 0)
                    for r in f["remoteProcessGroups"]:
                        s2s_sent += int((r.get("status") or {}).get("aggregateSnapshot", {}).get("flowFilesSent", 0) or 0)
            heap = nf.call("GET", "/system-diagnostics")["systemDiagnostics"]["aggregateSnapshot"]["heapUtilization"]
            print(f"{inst} ({nf.ver}):{len(groups)} cx- groups, {procs} processors, {running} running, {invalid} invalid, queued {queued}, S2S sent (5 min) {s2s_sent}, heap {heap}")
            for b in bad[:10]:
                print("   invalid:", b)


def main():
    ap = argparse.ArgumentParser()
    for f in ("status", "stop", "start", "delete", "rebuild"):
        ap.add_argument(f"--{f}", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--spec", default=f"{HERE}/spec.yaml")
    ap.add_argument("--plan", action="store_true", help="parse the spec and count processors, no NiFi calls")
    a = ap.parse_args()
    spec = yaml.safe_load(open(a.spec))
    if a.plan:
        def count(g):
            nodes, _ = parse(g)
            return sum(1 for n in nodes.values() if n["kind"] in KINDS) + sum(count(s) for s in g.get("sub") or [])
        for inst in spec["instances"]:
            gs = [g for g in spec["groups"] if g["instance"] == inst]
            print(inst, sum(count(g) for g in gs), "processors in", len(gs), "groups")
        return
    only = set(a.only.split(",")) if a.only else set(spec["instances"])
    nifis = {k: Nifi(k, v) for k, v in spec["instances"].items()}  # all: S2S targets may sit outside --only
    b = Builder(spec, nifis)
    if a.status:
        b.status(only)
    elif a.stop:
        b.start(only, False)
    elif a.start:
        b.start(only, True)
    elif a.delete:
        b.delete(only)
    else:
        if a.rebuild:
            b.delete(only)
        b.build(only)
        b.status(only)


if __name__ == "__main__":
    main()
