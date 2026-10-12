#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const [pinPath, packagePath, lockPath, installedPath, cliPath, backendPath] =
  process.argv.slice(2);
if ([pinPath, packagePath, lockPath, installedPath, cliPath, backendPath].some(
  (value) => typeof value !== "string" || value.length === 0,
)) {
  throw new Error("Expected pin, package, lock, installed package, CLI, and backend paths");
}

const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path) => sha256Bytes(readFileSync(path));

function packageTreeSha256(root) {
  const absoluteRoot = resolve(root);
  const hash = createHash("sha256");
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const item = relative(absoluteRoot, path).split(sep).join("/");
      if (stat.isSymbolicLink()) {
        throw new Error(`Convex package contains an unexpected symlink: ${item}`);
      }
      if (stat.isDirectory()) {
        hash.update(`D\0${item}\0`);
        visit(path);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Convex package contains an unsupported item: ${item}`);
      }
      hash.update(`F\0${item}\0${(stat.mode & 0o111) === 0 ? 0 : 1}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
    }
  };
  visit(absoluteRoot);
  return hash.digest("hex");
}

const pin = readJSON(pinPath);
const rootPackage = readJSON(packagePath);
const lock = readJSON(lockPath);
const installed = readJSON(installedPath);
const lockEntry = lock.packages?.["node_modules/convex"];
const expectedVersion = pin.convexCliVersion;
const expectedRuntimeHashes = pin.convexRuntimePackageTreeSha256ByName;
const platformKey = `${process.platform}-${process.arch}`;
const expectedBackendHash = pin.backendSha256ByPlatform?.[platformKey];
if (
  typeof expectedVersion !== "string"
  || typeof pin.backendVersion !== "string"
  || expectedRuntimeHashes === null
  || typeof expectedRuntimeHashes !== "object"
  || Array.isArray(expectedRuntimeHashes)
  || Object.keys(expectedRuntimeHashes).length === 0
  || Object.values(expectedRuntimeHashes).some((hash) => !/^[0-9a-f]{64}$/u.test(hash))
  || !/^[0-9a-f]{64}$/u.test(expectedBackendHash ?? "")
) {
  throw new Error(`Tracked Convex toolchain pin is incomplete for ${platformKey}`);
}

const cliStat = lstatSync(cliPath);
if (!cliStat.isSymbolicLink() || readlinkSync(cliPath) !== "../convex/bin/main.js") {
  throw new Error("Convex CLI launcher symlink is not the canonical package entry point");
}
const installedRoot = dirname(installedPath);
const nodeModulesRoot = dirname(installedRoot);
const expectedCliPath = join(realpathSync(installedRoot), "bin/main.js");
if (realpathSync(cliPath) !== expectedCliPath) {
  throw new Error("Convex CLI launcher resolves outside the verified package tree");
}

const backendStat = lstatSync(backendPath);
if (!backendStat.isFile() || backendStat.isSymbolicLink()) {
  throw new Error("Convex local backend must be a regular non-symlink executable");
}
if ((backendStat.mode & 0o111) === 0) {
  throw new Error("Convex local backend is not executable");
}

const cliVersion = execFileSync(cliPath, ["--version"], { encoding: "utf8" }).trim();
for (const [label, actual] of [
  ["package.json", rootPackage.dependencies?.convex ?? rootPackage.devDependencies?.convex],
  ["package-lock root", lock.packages?.[""]?.dependencies?.convex
    ?? lock.packages?.[""]?.devDependencies?.convex],
  ["package-lock installed", lockEntry?.version],
  ["installed package", installed.version],
  ["CLI executable", cliVersion],
]) {
  if (actual !== expectedVersion) {
    throw new Error(`${label} Convex version ${actual} != ${expectedVersion}`);
  }
}
for (const packageName of Object.keys(expectedRuntimeHashes)) {
  const runtimeLockEntry = lock.packages?.[`node_modules/${packageName}`];
  if (
    typeof runtimeLockEntry?.integrity !== "string"
    || !runtimeLockEntry.integrity.startsWith("sha512-")
  ) {
    throw new Error(`Runtime lock integrity is missing for ${packageName}`);
  }
}

const runtimeTreeReceipts = [];
for (const packageName of Object.keys(expectedRuntimeHashes).sort()) {
  const packageRoot = join(nodeModulesRoot, ...packageName.split("/"));
  const actualHash = packageTreeSha256(packageRoot);
  const expectedHash = expectedRuntimeHashes[packageName];
  if (actualHash !== expectedHash) {
    throw new Error(`Convex runtime package ${packageName} tree hash ${actualHash} != ${expectedHash}`);
  }
  runtimeTreeReceipts.push(
    `convex-runtime-package-${packageName.replaceAll("/", "-")}-sha256=${actualHash}`,
  );
}
const actualBackendHash = sha256File(backendPath);
if (actualBackendHash !== expectedBackendHash) {
  throw new Error(`Convex backend hash ${actualBackendHash} != ${expectedBackendHash}`);
}

process.stdout.write([
  `convex-cli-version=${expectedVersion}`,
  `convex-backend-version=${pin.backendVersion}`,
  `convex-lock-integrity=${lockEntry.integrity}`,
  ...runtimeTreeReceipts,
  `convex-cli-entrypoint-sha256=${sha256File(expectedCliPath)}`,
  `convex-backend-platform=${platformKey}`,
  `convex-backend-executable-sha256=${actualBackendHash}`,
  `convex-toolchain-pin-sha256=${sha256File(pinPath)}`,
  `package-lock-sha256=${sha256File(lockPath)}`,
].join("\n") + "\n");
