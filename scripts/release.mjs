// npm run release: signs dist/xrnsoc-<version>.crx and publishes it, with the
// update manifest xrnsoc.xml, in the update folder of a server you already run
// for another extension (xrnsoc has no server of its own). A browser that
// installed the .crx (Quetta on a phone) reads xrnsoc.xml and takes each new
// version by itself. A version the server already has is bumped first; one
// older than the server's stops the release (scripts/crx.mjs → releaseVersion).
// Only from main with nothing left uncommitted (--force releases this tree
// anyway).
//
// Reads ~/.config/xrnsoc/release.json:
//   { "server": "https://<host>/<path>", "ssh": "<ssh-host>", "dir": "<folder>" }
// "server": the public address of a server that serves its <dir>/update/ folder
// at <server>/update/ to anyone (any *.crx and *.xml there); "dir": that data
// folder, from the ssh login's home; "ssh" may list several ways to the same
// server, tried in order. The files are named xrnsoc*, so the other
// extension's own files there are left alone. Signs with
// ~/.config/xrnsoc/xrnsoc.pem, made only on a first release (--new-key).
// Neither belongs in the repo: the key is what makes an update the same
// extension; lose it and every phone has to install afresh under a new ID.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { packageFiles, withUpdateUrl, zip, crx3, extensionId, updateManifest, releaseVersion } from "./crx.mjs";
import { treeRefusals, signingKey, idRefusal, appIdOf } from "./release-guard.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST = join(ROOT, "manifest.json");
const DIST = process.env.XRNSOC_DIST || join(ROOT, "dist");
const CONFIG_DIR = join(process.env.XRNSOC_CONFIG || join(homedir(), ".config"), "xrnsoc");
const XML = "xrnsoc.xml";

const version = () => JSON.parse(readFileSync(MANIFEST, "utf8")).version;
const ssh = (host, command, input) => execFileSync("ssh", [host, command], { input, stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });
const stop = (message) => {
  console.error(`Not released: ${message}`);
  process.exit(1);
};

const flags = new Set(process.argv.slice(2));
if ([...flags].some((f) => !["--force", "--new-key"].includes(f))) {
  console.error("usage: node scripts/release.mjs [--force] [--new-key]");
  process.exit(2);
}
const refusals = treeRefusals(ROOT);
if (refusals.length && !flags.has("--force")) stop(`${refusals.join("\n")}\n(--force releases this tree anyway)`);

const configFile = join(CONFIG_DIR, "release.json");
if (!existsSync(configFile)) {
  stop(`no ${configFile}. Create it with the server's public address, its ssh host and its data folder:
  { "server": "https://<host>/<path>", "ssh": "<ssh-host>", "dir": "<data folder>" }`);
}
const config = JSON.parse(readFileSync(configFile, "utf8"));
const server = String(config.server || "").replace(/\/+$/, "");
const dir = String(config.dir || "");
const tried = [].concat(config.ssh || []);
if (!/^https:\/\/[^/]+/.test(server) || !tried.length || !/^[\w./-]+$/.test(dir) || dir.includes("..")) {
  stop(`${configFile} needs "server" (https://…), "ssh" and "dir" (a plain folder name)`);
}

// The key and the ID it signs as, before the server is reached. A key made
// just now, asked for with --new-key, is a new ID on purpose.
const keyFile = join(CONFIG_DIR, "xrnsoc.pem");
const made = !existsSync(keyFile);
let key;
try {
  key = signingKey(keyFile, flags.has("--new-key"));
} catch (err) {
  stop(err.message);
}
const id = extensionId(key);
const checkId = (xml, where) => {
  const refusal = idRefusal(id, xml, where);
  if (refusal && !made) stop(refusal);
  if (refusal) console.warn(`--new-key: ${where} named ${appIdOf(xml)}; copies installed under it won't update.`);
};
mkdirSync(DIST, { recursive: true });
const lastXml = join(DIST, XML);
if (existsSync(lastXml)) checkId(readFileSync(lastXml, "utf8"), relative(ROOT, lastXml));

// Found before anything is bumped, so an unreachable server changes nothing.
const host = tried.find((h) => {
  try {
    execFileSync("ssh", ["-o", "ConnectTimeout=8", "-o", "BatchMode=yes", h, "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
if (!host) stop(`no ssh host in ${configFile} answers: ${tried.join(", ")}`);
console.log(`publishing over ssh to ${host}`);

const { version: live, xml: liveXml } = await liveUpdates();
checkId(liveXml, `${server}/update/${XML}`);
let plan;
try {
  plan = releaseVersion(live, version());
} catch (err) {
  stop(err.message);
}
if (plan.bumped) {
  // manifest.json and package.json carry the same number.
  for (const file of [MANIFEST, join(ROOT, "package.json")]) {
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${plan.version}$2`));
  }
  console.log(`the server already has ${live}: manifest.json is now ${plan.version} (not committed)`);
}
const v = version();

const updateUrl = `${server}/update/${XML}`;
const crx = crx3(zip(withUpdateUrl(packageFiles(ROOT), updateUrl)), key);
const crxName = `xrnsoc-${v}.crx`;
writeFileSync(join(DIST, crxName), crx);
const xml = updateManifest({ id, version: v, codebase: `${server}/update/${crxName}`, crx });
writeFileSync(lastXml, xml);
console.log(`dist/${crxName}: ${Math.round(crx.length / 1024)} KB, extension ID ${id}`);

// The .crx files first and the manifest last, each written beside its final
// name and moved into place, so a browser never reads a half-written file or a
// manifest pointing at a .crx that isn't there yet. Only xrnsoc's own old
// .crx files are pruned.
const put = (name, data) => ssh(host, `cat > ${dir}/update/${name}.part && mv ${dir}/update/${name}.part ${dir}/update/${name}`, data);
ssh(host, `mkdir -p ${dir}/update`);
put(crxName, crx);
put("xrnsoc.crx", crx); // the stable link a new install starts from
put(XML, Buffer.from(xml));
ssh(host, `cd ${dir}/update && for f in xrnsoc-*.crx; do [ "$f" = ${crxName} ] || rm -f "$f"; done`);

const { version: now } = await liveUpdates();
if (now !== v) stop(`uploaded, but ${updateUrl} says ${now || "nothing"}: does that server serve its update folder?`);
console.log(`published ${v}. Browsers with the .crx pick it up within hours.
First install on a new device: ${server}/update/xrnsoc.crx`);

// The server's xrnsoc.xml: its text and the version it offers (both null
// before the first release).
async function liveUpdates() {
  const res = await fetch(`${server}/update/${XML}`, { cache: "no-store" });
  if (res.status === 404) return { version: null, xml: null };
  if (!res.ok) stop(`${server}/update/${XML} answered ${res.status}`);
  const text = await res.text();
  const m = /updatecheck[^>]*\sversion='([^']+)'/.exec(text);
  return { version: m ? m[1] : null, xml: text };
}
