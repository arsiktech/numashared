// Run only in the admitted, resource-limited, no-network test sandbox.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { interceptorPlugin } from "@vitest/mocker/node";
import { resolveConfig } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));

test("the lock and installed packages match the same-major security patch set", async () => {
  const versions = {
    nanoid: "3.3.18", postcss: "8.5.23", vitest: "4.1.11",
    "@vitest/mocker": "4.1.11", "@vitest/expect": "4.1.11",
    "@vitest/runner": "4.1.11", "@vitest/snapshot": "4.1.11",
    "@vitest/spy": "4.1.11", "@vitest/utils": "4.1.11",
    "@vitest/pretty-format": "4.1.11",
  };
  for (const [name, version] of Object.entries(versions)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `lock: ${name}`);
    const installed = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
    assert.equal(installed.version, version, `installed: ${name}`);
  }
});

test("nanoid zero-size custom generators return instead of blocking the calling thread", () => {
  // A subprocess deadline safely exposes the old infinite loop without hanging
  // the test runner. The enclosing sandbox supplies the empty/allowlisted env.
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { customAlphabet, customRandom } from "nanoid";
    const random = size => new Uint8Array(size);
    assert.equal(customAlphabet("abc", 0)(), "");
    assert.equal(customAlphabet("abc", 4)(0), "");
    assert.equal(customRandom("abc", 0, random)(), "");
    assert.equal(customRandom("abc", 4, random)(0), "");
    assert.equal(customRandom("abc", 4, random)(), "aaaa");
    assert.match(customAlphabet("abc", 4)(), /^[abc]{4}$/);
  `], { cwd: root, timeout: 2_000, maxBuffer: 65_536, stdio: "pipe" });
});

test("PostCSS does not disclose an external map when from is unset", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "numa-postcss-security-"));
  try {
    const sentinel = "NUMA_SYNTHETIC_EXTERNAL_MAP_CONTENT";
    const map = {
      version: 3, file: "fixture.css", sources: ["fixture-source.css"],
      sourcesContent: [sentinel], names: [], mappings: "AAAA",
    };
    const mapPath = join(scratch, "outside.map");
    await writeFile(mapPath, JSON.stringify(map), { flag: "wx" });
    const result = await postcss([]).process(
      `a{color:red}\n/*# sourceMappingURL=${mapPath} */`,
      { map: { inline: false, annotation: false } },
    );
    assert.ok(!JSON.stringify(result.map?.toJSON() ?? null).includes(sentinel));
    assert.ok(result.css.includes("a{color:red}"));
    // Explicitly supplied maps remain supported; only untrusted annotations
    // without an input-file base must be denied.
    const trusted = await postcss([]).process("a{color:red}", {
      from: join(scratch, "fixture.css"),
      map: { prev: map, inline: false, annotation: false },
    });
    assert.ok(JSON.stringify(trusted.map.toJSON()).includes(sentinel));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Vitest redirect registration respects Vite's file allowlist without starting a server", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "numa-mocker-security-"));
  try {
    const project = join(scratch, "project");
    await mkdir(project);
    await writeFile(join(project, "allowed.js"), "export default 'allowed fixture';");
    await writeFile(join(project, ".env"), "SYNTHETIC_DENIED_CONTENT");
    await writeFile(join(scratch, "outside.js"), "SYNTHETIC_OUTSIDE_CONTENT");
    const config = await resolveConfig({
      configFile: false, envFile: false, root: project,
      server: { fs: { strict: true, allow: [project] } },
    }, "serve");
    const callbacks = new Map();
    const plugin = interceptorPlugin();
    // Only the WebSocket transport is replaced. Use the real registration,
    // registry, allowlist and file-loading code. No socket is opened.
    plugin.configureServer({
      config,
      ws: { on: (name, callback) => callbacks.set(name, callback), send: () => {} },
    });
    const register = callbacks.get("vitest:interceptor:register");
    assert.equal(typeof register, "function");
    const load = typeof plugin.load === "function" ? plugin.load : plugin.load.handler;
    for (const [id, redirect, expected] of [
      ["/allowed-import", "file:///allowed.js", "export default 'allowed fixture';"],
      ["/outside-import", "fixture:../outside.js", undefined],
      ["/denied-import", "file:///.env", undefined],
    ]) {
      register({ type: "redirect", raw: id, id, url: id, redirect });
      assert.equal(await load(id), expected, id);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
