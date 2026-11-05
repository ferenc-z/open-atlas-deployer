// Service ops §5.1: a service profile per service type and version line, kept in code. It says which files a
// service has, how it starts and stops, what to probe, which logs to read, and the property catalog: each key's
// type, default, whether a cluster's nodes must agree on it (cluster) or each node has its own (node), whether a
// change needs a restart, whether it is sensitive, and the versions it exists in. Checks, the pages and the AI
// review all go by the catalog. Phase 1 covers the keys taking over needs: grouping into clusters (nifi.cluster.*,
// the ZooKeeper connect string), ports, the version, and what step 5 compares between a cluster's nodes.

export type ServiceType = "nifi";
export type ProfileId = "nifi-1.x" | "nifi-2.x";
export type ConfigFile = "nifi.properties" | "bootstrap.conf";

export interface CatalogEntry {
  key: string;
  file: ConfigFile;
  type: "string" | "boolean" | "integer" | "port" | "path" | "duration" | "host" | "url";
  default: string | null;
  /** cluster: every node must have the same value (a difference is a finding); node: each node has its own. */
  scope: "cluster" | "node";
  restart: boolean;
  sensitive: boolean;
  /** Used to tell which installations form one cluster (§6 step 3, P1). */
  grouping?: boolean;
  /** First version that has the key, and first that no longer has it (exclusive). */
  since?: string;
  until?: string;
  note?: string;
}

export interface ServiceProfile {
  id: ProfileId;
  service: ServiceType;
  /** The major version this profile covers. */
  major: number;
  /** Versions run against the profile (the local lab, §15.1 step 0); others of the line match but are untested. */
  tested: string[];
  java: string[];
  files: { name: string; path: string; format: "properties" | "xml" | "json"; note?: string }[];
  control: { start: string; stop: string; status: string; runAs: "owner" };
  probes: string[];
  logs: string[];
  catalog: CatalogEntry[];
}

const p = (key: string, type: CatalogEntry["type"], def: string | null, scope: CatalogEntry["scope"], more: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({ key, file: "nifi.properties", type, default: def, scope, restart: true, sensitive: false, ...more });
const b = (key: string, type: CatalogEntry["type"], def: string | null, scope: CatalogEntry["scope"], more: Partial<CatalogEntry> = {}): CatalogEntry =>
  p(key, type, def, scope, { file: "bootstrap.conf", ...more });

/** Keys both lines have. Defaults are what NiFi ships (checked against conf/ of the 1.12.1, 2.0.0 and 2.5.0 archives,
 *  2026-11-05); a key the shipped file leaves out has its built-in value or null. A line's own defaults: defaults(). */
const COMMON: CatalogEntry[] = [
  p("nifi.cluster.is.node", "boolean", "false", "cluster", { grouping: true }),
  p("nifi.cluster.protocol.is.secure", "boolean", "false", "cluster", { note: "Shipped false in both lines; with HTTPS NiFi secures the cluster protocol anyway." }),
  p("nifi.cluster.node.address", "host", "", "node"),
  p("nifi.cluster.node.protocol.port", "port", "", "node"),
  p("nifi.cluster.load.balance.host", "host", "", "node"),
  p("nifi.cluster.load.balance.port", "port", "6342", "node"),
  p("nifi.cluster.flow.election.max.wait.time", "duration", "5 mins", "cluster"),
  p("nifi.cluster.flow.election.max.candidates", "integer", "", "cluster"),
  p("nifi.cluster.node.connection.timeout", "duration", "5 sec", "cluster"),
  p("nifi.cluster.node.read.timeout", "duration", "5 sec", "cluster"),
  p("nifi.cluster.load.balance.comms.timeout", "duration", "30 sec", "cluster"),
  p("nifi.zookeeper.connect.string", "string", "", "cluster", { grouping: true, note: "An external dependency, not managed (S22)." }),
  p("nifi.zookeeper.root.node", "string", "/nifi", "cluster", { grouping: true }),
  p("nifi.zookeeper.connect.timeout", "duration", "10 secs", "cluster"),
  p("nifi.zookeeper.session.timeout", "duration", "10 secs", "cluster"),
  p("nifi.state.management.provider.cluster", "string", "zk-provider", "cluster"),
  p("nifi.web.http.host", "host", "", "node"),
  p("nifi.web.http.port", "port", "", "node"),
  p("nifi.web.https.host", "host", "", "node"),
  p("nifi.web.https.port", "port", "", "node"),
  p("nifi.remote.input.host", "host", "", "node"),
  p("nifi.remote.input.socket.port", "port", "", "node"),
  p("nifi.remote.input.secure", "boolean", "true", "cluster"),
  p("nifi.sensitive.props.key", "string", "", "cluster", { sensitive: true, note: "Nodes with different keys cannot read each other's flow." }),
  p("nifi.sensitive.props.algorithm", "string", null, "cluster"),
  p("nifi.security.keystore", "path", "", "node"),
  p("nifi.security.keystoreType", "string", "", "node"),
  p("nifi.security.keystorePasswd", "string", "", "node", { sensitive: true }),
  p("nifi.security.keyPasswd", "string", "", "node", { sensitive: true }),
  p("nifi.security.truststore", "path", "", "node"),
  p("nifi.security.truststoreType", "string", "", "node"),
  p("nifi.security.truststorePasswd", "string", "", "node", { sensitive: true }),
  p("nifi.flowfile.repository.directory", "path", "./flowfile_repository", "node"),
  p("nifi.content.repository.directory.default", "path", "./content_repository", "node"),
  p("nifi.provenance.repository.directory.default", "path", "./provenance_repository", "node"),
  p("nifi.database.directory", "path", "./database_repository", "node"),
  b("run.as", "string", "", "node"),
  b("java.arg.2", "string", "-Xms512m", "cluster", { note: "Initial heap (-Xms)." }),
  b("java.arg.3", "string", "-Xmx512m", "cluster", { note: "Maximum heap (-Xmx)." }),
];

/** COMMON with one line's shipped defaults in place of the shared ones. */
const defaults = (values: Record<string, string | null>, file: ConfigFile = "nifi.properties") =>
  COMMON.map((e) => (e.file === file && e.key in values ? { ...e, default: values[e.key]! } : e));

const NIFI_1: ServiceProfile = {
  id: "nifi-1.x", service: "nifi", major: 1, tested: ["1.12.1"], java: ["8", "11"],
  files: [
    { name: "nifi.properties", path: "conf/nifi.properties", format: "properties" },
    { name: "bootstrap.conf", path: "conf/bootstrap.conf", format: "properties", note: "JVM arguments split into fields." },
    { name: "state-management.xml", path: "conf/state-management.xml", format: "xml" },
    { name: "authorizers.xml", path: "conf/authorizers.xml", format: "xml" },
    { name: "login-identity-providers.xml", path: "conf/login-identity-providers.xml", format: "xml" },
    { name: "logback.xml", path: "conf/logback.xml", format: "xml", note: "With scan on, changes apply without a restart." },
  ],
  control: { start: "bin/nifi.sh start", stop: "bin/nifi.sh stop", status: "bin/nifi.sh status", runAs: "owner" },
  probes: ["/nifi-api/system-diagnostics", "/nifi-api/flow/status", "/nifi-api/controller/cluster", "/nifi-api/flow/bulletin-board"],
  logs: ["logs/nifi-app.log", "logs/nifi-user.log", "logs/nifi-bootstrap.log"],
  catalog: [
    ...defaults({ "nifi.web.http.port": "8080", "nifi.remote.input.secure": "false", "nifi.sensitive.props.algorithm": "PBEWITHMD5AND256BITAES-CBC-OPENSSL" }),
    b("java", "path", "java", "node", { note: "The java command; nodes may differ in path, not in major version. 2.x has no such key (JAVA_HOME)." }),
    p("nifi.flow.configuration.file", "path", "./conf/flow.xml.gz", "node"),
    p("nifi.flow.configuration.json.file", "path", "./conf/flow.json.gz", "node", { since: "1.16.0" }),
    p("nifi.templates.directory", "path", "./conf/templates", "node"),
    p("nifi.variable.registry.properties", "string", "", "cluster"),
  ],
};

const NIFI_2: ServiceProfile = {
  id: "nifi-2.x", service: "nifi", major: 2, tested: ["2.0.0", "2.5.0"], java: ["21"],
  files: NIFI_1.files,
  control: NIFI_1.control,
  probes: NIFI_1.probes,
  logs: NIFI_1.logs,
  catalog: [
    ...defaults({
      "nifi.web.https.host": "localhost", "nifi.web.https.port": "8443", "nifi.sensitive.props.algorithm": "NIFI_PBKDF2_AES_GCM_256",
      "nifi.security.keystore": "./conf/keystore.p12", "nifi.security.keystoreType": "PKCS12", "nifi.security.truststore": "./conf/truststore.p12", "nifi.security.truststoreType": "PKCS12",
    }).map((e) => (e.file === "bootstrap.conf" && (e.key === "java.arg.2" || e.key === "java.arg.3") ? { ...e, default: e.key === "java.arg.2" ? "-Xms1g" : "-Xmx1g" } : e)),
    p("nifi.flow.configuration.file", "path", "./conf/flow.json.gz", "node", { note: "2.x keeps the flow only as JSON." }),
    p("nifi.python.command", "string", null, "cluster", { note: "Shipped commented out (Python processors off); an empty value fails the start, so leave the line out." }),
    p("nifi.python.framework.source.directory", "path", "./python/framework", "node"),
    p("nifi.python.extensions.source.directory.default", "path", "./python/extensions", "node"),
    b("management.server.address", "url", "http://127.0.0.1:52020", "node", { note: "Not in the shipped file; NiFi listens here when it is absent. Two 2.x on one host must use different ports." }),
  ],
};

export const PROFILES: readonly ServiceProfile[] = [NIFI_1, NIFI_2];

const major = (version: string) => {
  const m = /^(\d+)\.\d+\.\d+(?:[-.+].*)?$/.exec(version.trim());
  return m ? Number(m[1]) : undefined;
};

/** The profile covering a service version (by its major version, so 2.0.0-M4 is 2.x), and whether it was tested. */
export function profileFor(service: string, version: string): { profile: ServiceProfile; tested: boolean } | undefined {
  const m = major(version);
  const profile = PROFILES.find((x) => x.service === service && x.major === m);
  return profile && { profile, tested: profile.tested.includes(version.trim()) };
}

export function profile(id: string): ServiceProfile | undefined {
  return PROFILES.find((x) => x.id === id);
}

const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1, 4).map(Number);
const before = (a: string, b: string) => {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

/** The catalog entries a given version has (since/until). */
export function catalogFor(profile: ServiceProfile, version: string): CatalogEntry[] {
  return profile.catalog.filter((e) => !(e.since && before(version, e.since)) && !(e.until && !before(version, e.until)));
}

export function catalogEntry(profile: ServiceProfile, key: string, file: ConfigFile = "nifi.properties"): CatalogEntry | undefined {
  return profile.catalog.find((e) => e.key === key && e.file === file);
}
