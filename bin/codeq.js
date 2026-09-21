#!/usr/bin/env node

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonPaths } from "../src/paths.js";

const USAGE = `Usage:
  codeq [--root PATH] [--json] find  <query>   [--path PATH] [--limit N]
  codeq [--root PATH] [--json] grep  <pattern> [--path PATH] [--glob GLOB] [--context N]
  codeq [--root PATH] [--json] graph <query>   [--path PATH]`;

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
  const options = { command, cwd: process.cwd(), json: false };
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
    grep: new Set(["root", "path", "glob", "context"]),
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

function openSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function connectDaemon() {
  const paths = daemonPaths();
  try {
    return await openSocket(paths.socket);
  } catch {}

  mkdirSync(dirname(paths.log), { recursive: true });
  const logFd = openSync(paths.log, "a");
  const script = fileURLToPath(new URL("../src/daemon.js", import.meta.url));
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);

  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      return await openSocket(paths.socket);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `daemon did not start: ${lastError?.message || `see ${paths.log}`}`,
  );
}

function printStatus(result) {
  process.stderr.write(`[${result.status}] root ${result.root}\n`);
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

async function main() {
  const request = parseArguments(process.argv.slice(2));
  const { json, ...wireRequest } = request;
  const socket = await connectDaemon();
  socket.setEncoding("utf8");
  let buffer = "";

  const completion = new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === "progress") {
          const detail =
            message.message ||
            `${message.phase}${message.total ? ` ${message.current}/${message.total}` : ""}`;
          process.stderr.write(`[indexing] ${detail}\n`);
        } else if (message.type === "error") {
          reject(new Error(message.error));
        } else if (message.type === "result") {
          resolve(message.result);
        }
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (buffer.trim()) reject(new Error("daemon returned an incomplete response"));
    });
  });

  const cancel = () => {
    socket.destroy();
    process.exit(130);
  };
  process.once("SIGINT", cancel);
  socket.write(`${JSON.stringify(wireRequest)}\n`);
  const result = await completion;
  process.removeListener("SIGINT", cancel);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ command: request.command, ...result }, null, 2)}\n`,
    );
  } else {
    printHuman(request.command, result);
  }
}

main().catch((error) => {
  process.stderr.write(`codeq: ${error.message}\n`);
  process.exit(1);
});
