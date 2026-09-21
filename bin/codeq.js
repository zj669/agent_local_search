#!/usr/bin/env node

import { queryDaemon } from "../src/client.js";
import { rootOrigin } from "../src/mcp-format.js";
import { runMcpServer } from "../src/mcp.js";

const USAGE = `Usage:
  codeq [--root PATH] [--json] find  <query>   [--path PATH] [--limit N]
  codeq [--root PATH] [--json] grep  <pattern> [--path PATH] [--glob GLOB] [--context N] [--limit N]
  codeq [--root PATH] [--json] graph <query>   [--path PATH]
  codeq mcp`;

const MCP_USAGE = `Usage:
  codeq mcp

Run a stdio MCP server that exposes find, grep, and graph. The server reuses
the per-user codeq daemon. Handshake (initialize / tools/list) does not index.
Indexing starts on the first tools/call that has a real target: path/root on
that call, else roots/list if the client gave a non-HOME folder, else a spawn
cwd that is not $HOME or /. For Cursor, run the codeq-mcp wrapper (Node 22,
no npx) rather than this command directly. Pass path or root to search a
different repository.`;

function fail(message, code = 2) {
  process.stderr.write(`codeq: ${message}\n\n${USAGE}\n`);
  process.exit(code);
}

function positiveInteger(value, name, allowZero = false) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 : parsed < 1)
  ) {
    fail(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (argv.length === 0) fail("a command is required");

  const commands = new Set(["find", "grep", "graph"]);
  const commandIndex = argv.findIndex((arg) => commands.has(arg));
  if (commandIndex < 0) fail(`unknown command: ${argv.find((arg) => !arg.startsWith("-")) || argv[0]}`);
  const command = argv[commandIndex];
  const options = {
    command,
    cwd: process.cwd(),
    cwdSource: "shell cwd",
    json: false,
  };
  const positionals = [];
  const takesValue = new Set([
    "--root",
    "--path",
    "--limit",
    "--glob",
    "--context",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    if (index === commandIndex) continue;
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (takesValue.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    positionals.push(arg);
  }

  if (positionals.length === 0) fail(`${command} requires a query`);
  options.query = positionals.join(" ");

  const valid = {
    find: new Set(["root", "path", "limit"]),
    grep: new Set(["root", "path", "glob", "context", "limit"]),
    graph: new Set(["root", "path"]),
  }[command];
  for (const key of ["root", "path", "limit", "glob", "context"]) {
    if (options[key] !== undefined && !valid.has(key)) {
      fail(`--${key} is not valid for ${command}`);
    }
  }
  if (options.limit !== undefined) {
    options.limit = positiveInteger(options.limit, "--limit");
  }
  if (options.context !== undefined) {
    options.context = positiveInteger(options.context, "--context", true);
  }
  return options;
}

function printStatus(result) {
  const sync = result.lastSuccessfulSync
    ? ` lastSuccessfulSync ${result.lastSuccessfulSync}`
    : "";
  const origin = rootOrigin(result);
  const via = origin ? ` via ${origin}` : "";
  const note = result.rootNote ? ` (${result.rootNote})` : "";
  process.stderr.write(`[${result.status}] root ${result.root}${via}${note}${sync}\n`);
  if (result.warning) process.stderr.write(`warning: ${result.warning}\n`);
}

function printHuman(command, result) {
  printStatus(result);
  if (command === "find") {
    for (const item of result.results) process.stdout.write(`${item.path}\n`);
    process.stderr.write(`${result.total} file match(es)\n`);
    return;
  }
  if (command === "grep") {
    if (result.fuzzyFallback) {
      process.stderr.write("warning: 0 exact matches; showing fuzzy matches\n");
    }
    for (const item of result.results) {
      for (let i = 0; i < item.contextBefore.length; i += 1) {
        const line = item.line - item.contextBefore.length + i;
        process.stdout.write(`${item.path}-${line}- ${item.contextBefore[i]}\n`);
      }
      process.stdout.write(`${item.path}:${item.line}:${item.column}: ${item.text}\n`);
      for (let i = 0; i < item.contextAfter.length; i += 1) {
        process.stdout.write(`${item.path}-${item.line + i + 1}- ${item.contextAfter[i]}\n`);
      }
    }
    process.stderr.write(`${result.total} text match(es)\n`);
    return;
  }
  process.stdout.write(`${result.result.trimEnd()}\n`);
}

async function runCli(argv) {
  const request = parseArguments(argv);
  const { json, ...wireRequest } = request;
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    process.exit(130);
  };
  process.once("SIGINT", cancel);
  const result = await queryDaemon(wireRequest, {
    signal: controller.signal,
    onProgress: (message) => {
      const detail =
        message.message ||
        `${message.phase}${message.total ? ` ${message.current}/${message.total}` : ""}`;
      process.stderr.write(`[indexing] ${detail}\n`);
    },
  });
  process.removeListener("SIGINT", cancel);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ command: request.command, ...result }, null, 2)}\n`,
    );
  } else {
    printHuman(request.command, result);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "mcp") {
    const rest = argv.slice(1);
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(`${MCP_USAGE}\n`);
      process.exit(0);
    }
    if (rest.length > 0) fail("mcp does not take additional arguments");
    await runMcpServer();
    return;
  }
  await runCli(argv);
}

main().catch((error) => {
  process.stderr.write(`codeq: ${error.message}\n`);
  process.exit(1);
});
