// The application bundle of the run on the live tools of macOS: ditto builds the zip file of a tracked folder and extracts it, and the
// release address is a server on a local address. The owners of the options and the platform operations on recorded input are
// ../../../test-app.test.mjs and ../../../platform.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applicationZip, cachedBundle } from "../../../../test-app.mjs";

const darwin = { platform: "darwin", arch: "arm64" };
const fixture = (name) => fileURLToPath(new URL(`../../../../fixtures/test-app/${name}`, import.meta.url));

/** The zip file that `ditto` builds of the tracked folder `name`, which holds the folder `name` itself, at `zip`. */
const zipOf = (name, zip) => execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", fixture(name), zip]);

/** A server whose `/v0.0.41/<file>` answers the bytes of the files in `files`, `{ [file]: path }`, and the paths that it was asked for. */
async function release(t, files) {
  const requested = [];
  const server = createServer((request, response) => {
    requested.push(request.url);
    const file = files[request.url.split("/").pop()];
    if (file) response.end(readFileSync(file));
    else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { releases: `http://127.0.0.1:${server.address().port}`, requested };
}

const folder = (t) => {
  const path = mkdtempSync(join(tmpdir(), "window-check-bundle-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

test("the bundle of an application is downloaded and extracted by ditto once into the cache", { timeout: 60000 }, async (t) => {
  const work = folder(t);
  const zip = join(work, "bundle.zip");
  zipOf("application/soksak.app", zip);
  const { name } = applicationZip("0.0.41", "mygo", darwin);
  const host = await release(t, { [name]: zip });
  const cache = join(work, "cache");
  mkdirSync(cache);
  const bundle = await cachedBundle(cache, "0.0.41", "mygo", { ...darwin, releases: host.releases });
  assert.equal(bundle, join(cache, "0.0.41", "mygo", "soksak.app"));
  assert.equal(readFileSync(join(bundle, "Contents", "Info.txt"), "utf8").length > 0, true, "ditto extracted the files of the bundle");
  assert.equal(await cachedBundle(cache, "0.0.41", "mygo", { ...darwin, releases: host.releases }), bundle);
  assert.deepEqual(host.requested, [`/v0.0.41/${name}`], "the second call downloaded again");
});

test("a zip file that holds no soksak.app is an error that names the zip file", { timeout: 60000 }, async (t) => {
  const work = folder(t);
  const zip = join(work, "other.zip");
  zipOf("other", zip);
  const { name } = applicationZip("0.0.41", "wailsv3", darwin);
  const host = await release(t, { [name]: zip });
  const cache = join(work, "cache");
  mkdirSync(cache);
  await assert.rejects(cachedBundle(cache, "0.0.41", "wailsv3", { ...darwin, releases: host.releases }),
    /soksak-0\.0\.41-darwin-arm64-wailsv3\.zip holds no soksak\.app/);
  assert.equal(existsSync(join(cache, "0.0.41", "wailsv3")), false);
});
