import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("../bin/codeq-mcp", import.meta.url));
const codeqJs = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function writeFakeNode(path, version) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "-p" ]]; then
  echo "${version}"
  exit 0
fi
echo "unexpected argv: $*" >&2
exit 2
`,
  );
  chmodSync(path, 0o755);
}

function dryRun(args, env, cwd) {
  return execFileSync("bash", [wrapper, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

test("wrapper source never puts npx or python on the MCP pipe", () => {
  const source = readFileSync(wrapper, "utf8");
  assert.match(source, /exec "\$NODE" "\$CODEQ_JS" mcp/);
  assert.equal(source.includes("python3"), false);
  assert.equal(source.includes("codeq-mcp-framing"), false);
  assert.equal(source.includes("npx -y"), false);
  assert.equal(source.includes("$NPX"), false);
  assert.match(source, /WORKSPACE_FOLDER_PATHS is intentionally omitted/);
});

test("wrapper cds to interpolated $1 but not HOME, /, or uninterpolated hint", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "codeq-wrap-home-"));
  const project = mkdtempSync(join(tmpdir(), "codeq-wrap-proj-"));
  const trap = mkdtempSync(join(tmpdir(), "codeq-wrap-trap-"));
  const env = {
    ...process.env,
    HOME: fakeHome,
    CODEQ_NODE: process.execPath,
    CODEQ_MCP_DRY_RUN: "1",
    WORKSPACE_FOLDER_PATHS: `${trap},/tmp`,
    VSCODE_CWD: "/",
    PWD: fakeHome,
  };
  delete env.CODEQ_WORKSPACE_FOLDER;
  delete env.FFF_WORKSPACE_FOLDER;
  delete env.CURSOR_PROJECT_DIR;

  const uninterpolated = dryRun(["${workspaceFolder}"], env, fakeHome);
  assert.equal(uninterpolated.includes(`cwd=${fakeHome}`), true, uninterpolated);
  assert.equal(uninterpolated.includes(`bin=${codeqJs}`), true);
  assert.equal(uninterpolated.includes(`node=${process.execPath}`), true);
  assert.equal(uninterpolated.includes(trap), false);
  assert.match(uninterpolated, /target=\s*$/m);

  const interpolated = dryRun([project], env, fakeHome);
  assert.equal(interpolated.includes(`cwd=${project}`), true, interpolated);
  assert.equal(interpolated.includes(`target=${project}`), true);
});

test("wrapper prefers Homebrew node@22 over PATH node 26", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "codeq-wrap-node-home-"));
  const prefix = mkdtempSync(join(tmpdir(), "codeq-wrap-brew-"));
  const pathDir = mkdtempSync(join(tmpdir(), "codeq-wrap-path-"));
  const node22 = join(prefix, "opt", "node@22", "bin", "node");
  const node26 = join(pathDir, "node");
  writeFakeNode(node22, "22.23.2");
  writeFakeNode(node26, "26.9.0");

  const env = {
    ...process.env,
    HOME: fakeHome,
    HOMEBREW_PREFIX: prefix,
    PATH: `${pathDir}:/usr/bin:/bin`,
    CODEQ_MCP_DRY_RUN: "1",
    PWD: fakeHome,
    VSCODE_CWD: "/",
  };
  delete env.CODEQ_NODE;
  delete env.CODEQ_WORKSPACE_FOLDER;
  delete env.NVM_DIR;
  delete env.FNM_DIR;
  delete env.FNM_MULTISHELL_PATH;

  const out = dryRun(["${workspaceFolder}"], env, fakeHome);
  assert.equal(out.includes(`node=${node22}`), true, out);
  assert.equal(out.includes(node26), false);
});
