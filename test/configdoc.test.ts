// Service ops §16.3: configuration files as documents (services/configdoc.ts) and how they are sealed (services/config.ts).
// testdata/nifi-conf holds the lab's 1.12.1 and 2.5.0 files with the secret values replaced.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { SecretBox } from "../src/server/secretbox.ts";
import { importFile, openFile, sealedText, sealFile, withoutSealed, type ConfigFileRecord } from "../src/server/services/config.ts";
import { ConfigDocError, decodeText, editProperties, editXml, isSecretKey, NOT_SECRET_KEYS, parsePropertyEntries, redactProperties, redactXml, restoreXmlSecrets, xmlProblem } from "../src/server/services/configdoc.ts";
import { parseProperties } from "../src/server/services/configview.ts";

const CONF = new URL("../testdata/nifi-conf/", import.meta.url);
const SAMPLES = readdirSync(CONF).flatMap((version) => readdirSync(new URL(`${version}/`, CONF)).map((name) => ({ version, name, bytes: readFileSync(new URL(`${version}/${name}`, CONF)) })));
const PROPERTIES = SAMPLES.filter((s) => /\.(properties|conf)$/.test(s.name));
const XML = SAMPLES.filter((s) => s.name.endsWith(".xml"));
const box = new SecretBox(randomBytes(32).toString("base64"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const refused = (code: string) => (e: unknown) => e instanceof ConfigDocError && e.code === code;
const edit = (text: string, ...changes: Parameters<typeof editProperties>[1]) => editProperties(Buffer.from(text, "latin1"), changes).toString("latin1");

test("the samples are there, both versions", () => {
  assert.deepEqual([...new Set(SAMPLES.map((s) => s.version))].sort(), ["1.12.1", "2.5.0"]);
  assert.ok(PROPERTIES.length >= 5 && XML.length >= 7);
});

test("no change gives the same bytes: LF, CRLF and ISO-8859-1 versions of the lab's files", () => {
  for (const s of PROPERTIES) {
    const crlf = Buffer.from(s.bytes.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
    const latin1 = Buffer.concat([Buffer.from("# caf\xe9 \xfc\n", "latin1"), s.bytes]);
    for (const bytes of [s.bytes, crlf, latin1]) {
      assert.ok(editProperties(bytes, []).equals(bytes), s.name);
      // Setting every key to what it already has changes nothing either.
      const same = parsePropertyEntries(bytes.toString("latin1")).filter((e) => !/[^\x20-\x7e]/.test(e.value) && !/^\s/.test(e.value) && !/\\$/.test(e.value)).map((e) => ({ key: e.name, value: e.value }));
      assert.ok(same.length > 0 || s.name === "zookeeper.properties");
      assert.ok(editProperties(bytes, same.filter((c) => /^[\x21-\x7e]+$/.test(c.key))).equals(bytes), `${s.version} ${s.name}`);
    }
  }
});

test("a change touches only that key's line, in the lab's files too", () => {
  const nifi = PROPERTIES.find((s) => s.version === "2.5.0" && s.name === "nifi.properties")!;
  for (const eol of ["\n", "\r\n"]) {
    const before = nifi.bytes.toString("latin1").replace(/\n/g, eol);
    const after = edit(before, { key: "nifi.ui.banner.text", value: "lab" });
    const a = before.split(eol), b = after.split(eol);
    assert.equal(a.length, b.length);
    const changed = a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]]]));
    assert.deepEqual(changed, [["nifi.ui.banner.text=", "nifi.ui.banner.text=lab"]]);
  }
});

test("properties edits: separators, comments, repeats, new keys, removals", () => {
  assert.equal(edit("# c\na = 1\n# d\nb: 2\nc 3\nd\n", { key: "a", value: "x" }, { key: "b", value: "y" }, { key: "c", value: "z" }, { key: "d", value: "w" }), "# c\na = x\n# d\nb: y\nc z\nd=w\n", "each line keeps how it is written");
  assert.equal(edit("a=1\n", { key: "new", value: "2" }), "a=1\nnew=2\n");
  assert.equal(edit("a=1\r\nb=2\r\n", { key: "new", value: "2" }), "a=1\r\nb=2\r\nnew=2\r\n", "the file's own line ending");
  assert.equal(edit("a=1", { key: "new", value: "2" }), "a=1\nnew=2", "no final line break stays that way");
  assert.equal(edit("", { key: "new", value: "2" }), "new=2\n");
  assert.equal(edit("#a=old\n", { key: "a", value: "1" }), "#a=old\na=1\n", "a commented-out key is a comment");
  assert.equal(edit("a=1\nb=2\na=3\n", { key: "a", value: "9" }), "a=1\nb=2\na=9\n", "Java keeps the last, so that one changes");
  assert.equal(edit("a=1\nb=2\na=3\n", { key: "a", unset: true }), "b=2\n", "every copy goes");
  assert.equal(edit("b=2\n", { key: "a", unset: true }), "b=2\n");
  assert.equal(edit("a=1\\\n  2\\\n  3\nb=2\n", { key: "a", value: "x" }), "a=x\nb=2\n", "a continued value is replaced whole");
  assert.equal(edit("a=1\\\n  2\nb=2\n", { key: "a", unset: true }), "b=2\n");
  assert.equal(edit("a=1\\\n  2\n", { key: "a", value: "12" }), "a=1\\\n  2\n", "the same value keeps its lines");
  assert.equal(edit("a=1\n", { key: "a", value: "caf\u00e9 \u4e2d" }), "a=caf\\u00e9 \\u4e2d\n", "beyond ASCII goes as \\u, whatever the file's encoding");
  // Bytes elsewhere in the file are untouched, UTF-8 or not.
  for (const other of [Buffer.from("# caf\xe9\n", "latin1"), Buffer.from("# caf\u00e9 \u4e2d\n", "utf8")]) {
    const bytes = Buffer.concat([other, Buffer.from("a=1\n")]);
    assert.ok(editProperties(bytes, [{ key: "a", value: "2" }]).equals(Buffer.concat([other, Buffer.from("a=2\n")])));
  }
});

test("properties edits refuse what would break the file or smuggle a line in", () => {
  for (const [value, code] of [["(hidden)", "config/hidden-value"], ["x(hidden)y", "config/hidden-value"], ["1\nnifi.other=2", "config/bad-value"], ["1\r2", "config/bad-value"], [" 1", "config/bad-value"], ["1\\", "config/bad-value"], ["\u0000", "config/bad-value"]] as const) {
    assert.throws(() => edit("a=1\n", { key: "a", value }), refused(code), JSON.stringify(value));
  }
  assert.equal(edit("a=1\n", { key: "a", value: "C:\\\\" }), "a=C:\\\\\n", "an even number of backslashes continues nothing");
  for (const key of ["a=b", "a b", "#a", "!a", "a:b", "a\\b", "caf\u00e9", ""]) assert.throws(() => edit("a=1\n", { key, value: "1" }), refused("config/bad-key"), key);
});

test("errors name keys, never values", () => {
  assert.throws(() => edit("a=1\n", { key: "a", value: "s3cret\nmore" }), (e: Error) => !e.message.includes("s3cret"));
  assert.throws(() => restoreXmlSecrets('<a><property name="New Password">(hidden)</property></a>', '<a><property name="Old Password">s3cret</property></a>'), (e: Error) => !e.message.includes("s3cret"));
  const bad = xmlProblem('<a><b password="s3cret" password="s3cret2"/></a>');
  assert.ok(bad && !bad.message.includes("s3cret"));
});

test("redaction by Java's rules: nothing of a secret stays, whichever way it is written", () => {
  const cases: [string, string][] = [
    ["nifi.security.keyPasswd=pw\n", "nifi.security.keyPasswd=(hidden)\n"],
    ["nifi.security.keyPasswd = pw\r\n", "nifi.security.keyPasswd = (hidden)\r\n"],
    ["nifi.security.keyPasswd pw\n", "nifi.security.keyPasswd (hidden)\n"],
    ["nifi.security.keyPasswd:pw\n", "nifi.security.keyPasswd:(hidden)\n"],
    ["  nifi.security.keyPasswd=pw", "  nifi.security.keyPasswd=(hidden)"],
    ["nifi.security.keyPasswd=pw\\\n  more\\\n  rest\nb=2\n", "nifi.security.keyPasswd=(hidden)\n\n\nb=2\n"],
    ["nifi.security.key\\\n  Passwd=pw\n", "nifi.security.keyPasswd=(hidden)\n\n"],
    ["nifi.security.keyPasswd=pw\rb=2\r", "nifi.security.keyPasswd=(hidden)\rb=2\r"],
    ["nifi.security.key\\u0050asswd=pw\n", "nifi.security.key\\u0050asswd=(hidden)\n"],
    ["nifi.security.keyPasswd=\n", "nifi.security.keyPasswd=\n"],
  ];
  for (const [text, want] of cases) assert.equal(redactProperties(text).text, want, text);
  const lines = parseProperties(redactProperties("a=1\nnifi.security.keyPasswd=pw\\\n  more\nb=2\n").text);
  assert.deepEqual(lines.map((l) => [l.key, l.value, l.line]), [["a", "1", 1], ["nifi.security.keyPasswd", "(hidden)", 2], ["b", "2", 4]], "line numbers still match the file");
  assert.deepEqual(parseProperties("a=1\\\n  2\nb c\nd\n").map((l) => [l.key, l.value]), [["a", "12"], ["b", "c"], ["d", ""]]);
});

test("XML redaction: other quoting, other attributes, CDATA and comments leak nothing", () => {
  for (const xml of [
    '<a><property name="Manager Password">s3cret</property></a>',
    "<a><property name='Manager Password'>s3cret</property></a>",
    '<a><property name="Manager Password" encryption="aes/gcm/256">s3cret</property></a>',
    '<a><property encryption="x" name="Manager Password">s3cret</property></a>',
    '<a><property name="Manager Password"><![CDATA[s3cret]]></property></a>',
    '<a><property name="Manager Password"><!-- c -->s3cret</property></a>',
    '<a><property name="Manager Password">\n  s3cret\n</property></a>',
    '<a><!-- <property name="Manager Password">s3cret</property> --></a>',
    '<a><user password="s3cret"/></a>',
    "<a><user password='s3cret'/></a>",
    '<a><user PASSWORD="s3cret"/></a>',
    '<a><user clientSecret = "s3cret"/></a>',
  ]) {
    const r = redactXml(xml);
    assert.ok(!r.text.includes("s3cret") && r.secrets.length === 1, xml);
    assert.equal(restoreXmlSecrets(r.text, xml), xml, "and it goes back");
  }
  const clean = '<a><property name="Url">ldap://x</property><property name="Manager Password"></property><user name="u" password=""/></a>';
  assert.deepEqual(redactXml(clean), { text: clean, secrets: [] });
});

test("the lab's XML files: redacted and sent back they are the same bytes, and well-formed", () => {
  for (const s of XML) {
    const text = s.bytes.toString("utf8");
    assert.equal(xmlProblem(text), null, `${s.version} ${s.name}`);
    assert.ok(editXml(s.bytes, redactXml(text).text).equals(s.bytes), `${s.version} ${s.name}`);
    const crlf = Buffer.from(text.replace(/\n/g, "\r\n"));
    assert.ok(editXml(crlf, redactXml(crlf.toString("utf8")).text).equals(crlf), "CRLF as it is");
    assert.ok(editXml(crlf, redactXml(text).text).equals(crlf), "CRLF after a textarea made it LF");
  }
});

test("(hidden) goes back to the previous value of that name, and nowhere else", () => {
  const prev = '<a><property name="Manager Password">one</property><property name="TLS - Keystore Password">two</property><p><property name="Manager Password">three</property></p><user password="four"/></a>';
  const shown = redactXml(prev).text;
  assert.equal(restoreXmlSecrets(shown, prev), prev);
  assert.equal(restoreXmlSecrets(shown.replace("<a>", '<a><property name="Url">new</property>'), prev), prev.replace("<a>", '<a><property name="Url">new</property>'), "other edits stay");
  assert.equal(restoreXmlSecrets(shown.replace("(hidden)", "changed"), prev), prev.replace("one", "changed"), "a real new value counts, positions do not move");
  // A renamed or new place has no value to go back to.
  assert.throws(() => restoreXmlSecrets(shown.replace("TLS - Keystore Password", "Renamed Password"), prev), refused("config/hidden-unmatched"));
  assert.throws(() => restoreXmlSecrets(shown.replace("<a>", '<a><property name="Manager Password">(hidden)</property>'), prev), refused("config/hidden-unmatched"), "one more of the name");
  assert.throws(() => restoreXmlSecrets(shown.replace('<property name="Manager Password">(hidden)</property>', ""), prev), refused("config/hidden-unmatched"), "one fewer: which was removed is not known");
  assert.throws(() => restoreXmlSecrets('<a><property name="Manager Password">(hidden)</property></a>', '<a><property name="Manager Password"></property></a>'), refused("config/hidden-unmatched"), "it was empty");
  // A "(hidden)" that is not a whole secret value is a literal, refused.
  assert.throws(() => restoreXmlSecrets('<a><property name="Url">(hidden)</property></a>', "<a/>"), refused("config/hidden-value"));
  assert.throws(() => restoreXmlSecrets('<a><property name="Manager Password">x(hidden)</property></a>', '<a><property name="Manager Password">s</property></a>'), refused("config/hidden-value"));
  assert.throws(() => restoreXmlSecrets("<a><!-- (hidden) --></a>", "<a/>"), refused("config/hidden-value"));
});

test("editXml keeps the file's encoding", () => {
  const latin1 = Buffer.from('<a n="caf\xe9"><property name="P Password">pw</property></a>', "latin1");
  const shown = redactXml(decodeText(latin1)).text;
  assert.ok(editXml(latin1, shown).equals(latin1));
  assert.ok(editXml(latin1, shown.replace("<a ", '<a b="\xfc" ')).equals(Buffer.from('<a b="\xfc" n="caf\xe9"><property name="P Password">pw</property></a>', "latin1")));
  assert.throws(() => editXml(latin1, shown.replace("<a ", '<a b="\u4e2d" ')), refused("config/bad-value"));
  const utf8 = Buffer.from('\ufeff<a n="\u4e2d"/>', "utf8");
  assert.ok(editXml(utf8, decodeText(utf8)).equals(utf8), "a BOM stays");
});

test("well-formedness", () => {
  for (const good of ['<a/>', '<?xml version="1.0"?>\n<!-- c --><a b="1" c=\'2\'><d>x &amp; y &#65; &#x41;</d><![CDATA[<&]]><e /></a>\n<!-- end -->\n', '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', '\ufeff<a/>', "<ns:a xmlns:ns='u'/>"]) assert.equal(xmlProblem(good), null, good);
  for (const [bad, line] of [["", 1], ["text", 1], ["<a>", 1], ["<a></b>", 1], ["<a>\n<b>\n</a>", 3], ["<a/><b/>", 1], ["<a/>x", 1], ['<a b=1/>', 1], ['<a b="1"c="2"/>', 1], ['<a b="1" b="2"/>', 1], ['<a b="<"/>', 1], ["<a>&</a>", 1], ["<a>&b</a>", 1], ['<a b="&"/>', 1], ["<a><</a>", 1], ["<a><!-- x</a>", 1], ["<a><!-- x -- y --></a>", 1], ["<a><![CDATA[x</a>", 1], ["<![CDATA[x]]><a/>", 1], ["</a>", 1], ["<a/><!DOCTYPE a>", 1], ["<a", 1]] as const) {
    const p = xmlProblem(bad);
    assert.ok(p, `should be refused: ${bad}`);
    assert.equal(p.line, line, bad);
  }
});

test("the catalog's exemptions: only the listed keys, the same on both sides (testdata/redact/cases.json)", () => {
  const cases = JSON.parse(readFileSync(new URL("../testdata/redact/cases.json", import.meta.url), "utf8")) as { properties: { hidden: string[]; shown: string[]; exempt: string[] } };
  assert.deepEqual([...NOT_SECRET_KEYS].sort(), [...cases.properties.exempt].sort(), "a catalog key that matches the name rule comes out of hiding: on purpose only");
  for (const key of cases.properties.hidden) assert.equal(isSecretKey(key), true, key);
  for (const key of [...cases.properties.shown, ...cases.properties.exempt]) assert.equal(isSecretKey(key), false, key);
  const text = "nifi.web.max.access.token.requests.per.second=25\nnifi.security.user.oidc.token.refresh.window=60 secs\nnifi.security.user.oidc.client.secret=s\n";
  assert.equal(redactProperties(text).text, "nifi.web.max.access.token.requests.per.second=25\nnifi.security.user.oidc.token.refresh.window=60 secs\nnifi.security.user.oidc.client.secret=(hidden)\n");
});

const read = (name: string, raw: Buffer) => ({ name, path: `/x/conf/${name}`, sha256: sha(raw), size: raw.length, modifiedAt: "t", content: raw.toString("base64") });

test("files are sealed as their bytes: any encoding comes back exactly, and the redacted copy reads", () => {
  const raw = Buffer.from("# caf\xe9\nnifi.ui.banner.text=\xfc\nnifi.security.keyPasswd=p\xe4ss\n", "latin1");
  const f = importFile(read("nifi.properties", raw), box);
  assert.equal(f.sealedAs, "base64");
  assert.equal(f.sha256, sha(raw));
  const opened = openFile(f, box);
  assert.ok(opened.ok && opened.bytes.equals(raw));
  assert.equal(f.redacted, "# caf\u00e9\nnifi.ui.banner.text=\u00fc\nnifi.security.keyPasswd=(hidden)\n");
  assert.ok(sealedText(f, (s) => box.open(s)).includes("p\u00e4ss"), "compared on the server by the real value");
  assert.ok(!Object.keys(withoutSealed({ members: [{ host: "h", installDir: "/x", files: [f], missing: [] }] }).members[0]!.files[0]!).some((k) => k.startsWith("sealed")));
  assert.ok(!f.redacted.includes("p\u00e4ss") && !f.sealed.includes(raw.toString("base64")));
});

test("sealFile makes a new revision's record from edited bytes", () => {
  const before = importFile(read("nifi.properties", Buffer.from("a=1\nnifi.security.keyPasswd=pw\n")), box);
  const opened = openFile(before, box);
  assert.ok(opened.ok);
  const after = sealFile(before, editProperties(opened.bytes, [{ key: "a", value: "2" }]), box);
  assert.equal(after.redacted, "a=2\nnifi.security.keyPasswd=(hidden)\n");
  assert.notEqual(after.sha256, before.sha256);
  const again = openFile(after, box);
  assert.ok(again.ok && sha(again.bytes) === after.sha256);
});

test("old revisions: sealed as text, they open when the hash holds, and otherwise cannot be edited", () => {
  const old = (raw: Buffer): ConfigFileRecord => ({ name: "nifi.properties", path: "/x/conf/nifi.properties", sha256: sha(raw), size: raw.length, modifiedAt: "t", format: "properties", sealed: box.seal(raw.toString("utf8")), redacted: "", secrets: [] });
  const utf8 = Buffer.from("# caf\u00e9\na=1\n");
  const fine = openFile(old(utf8), box);
  assert.ok(fine.ok && fine.bytes.equals(utf8));
  assert.equal(sealedText(old(utf8), (s) => box.open(s)), utf8.toString("utf8"));

  const damaged = old(Buffer.from("# caf\xe9\na=1\n", "latin1"));
  const refusedOpen = openFile(damaged, box);
  assert.ok(!refusedOpen.ok);
  assert.equal(refusedOpen.code, "config/reimport");
  assert.ok(!("bytes" in refusedOpen), "no bytes to write back");
  assert.match(sealedText(damaged, (s) => box.open(s)), /a=1/, "still readable for comparing");

  const otherKey = openFile(old(utf8), new SecretBox(randomBytes(32).toString("base64")));
  assert.equal(otherKey.ok, false, "a key that cannot open it is the same refusal");
});
