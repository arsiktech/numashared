#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";

const requiredNames = [
  "NUMA_SHARED_PRODUCT",
  "NUMA_SHARED_DEPLOYMENT_CLASS",
  "NUMA_SHARED_DEPLOYMENT_NAME",
  "NUMA_SHARED_SESSION_ISSUER",
  "NUMA_SHARED_SESSION_AUDIENCE",
  "NUMA_SHARED_AUTH_KEY_ID",
  "NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM",
  "NUMA_SHARED_AUTH_JWKS_URI",
  "NUMA_SHARED_TOKEN_HASH_SECRET",
  "NUMA_SHARED_E2E_AUTH_ENABLED",
  "NUMA_SHARED_E2E_BOOTSTRAP_SECRET",
  "NUMA_SHARED_APP_IDENTIFIER",
  "NUMA_SHARED_APP_STORE_URL",
  "NUMA_SHARED_CONTROLLER_NAME",
  "NUMA_SHARED_CONTROLLER_ADDRESS",
  "NUMA_SHARED_PRIVACY_EMAIL",
  "NUMA_SHARED_SUPPORT_EMAIL",
  "NUMA_SHARED_TRANSFER_MECHANISM",
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(66);
}

function validDeploymentName(value) {
  return /^anonymous-[a-z0-9][a-z0-9-]*$/u.test(value);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function parseRuntimeFile(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    fail("Local E2E runtime env must be an owner-only regular file");
  }
  const entries = new Map();
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.length === 0) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.+)$/u);
    if (!match || entries.has(match[1])) {
      fail(`Invalid local E2E runtime env line ${index + 1}`);
    }
    let value;
    try {
      value = JSON.parse(match[2]);
    } catch {
      fail(`Invalid local E2E runtime env value on line ${index + 1}`);
    }
    if (typeof value !== "string") {
      fail(`Invalid local E2E runtime env value on line ${index + 1}`);
    }
    entries.set(match[1], value);
  }
  return entries;
}

function validateRuntimeFile(path, deploymentName) {
  if (!validDeploymentName(deploymentName)) fail("Invalid anonymous deployment name");
  const entries = parseRuntimeFile(path);
  if (
    entries.size !== requiredNames.length
    || requiredNames.some((name) => !entries.has(name))
  ) {
    fail("Local E2E runtime env has an unexpected key set");
  }
  const expected = new Map([
    ["NUMA_SHARED_PRODUCT", "numa-shared"],
    ["NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local"],
    ["NUMA_SHARED_DEPLOYMENT_NAME", deploymentName],
    ["NUMA_SHARED_SESSION_ISSUER", "https://auth.local.numa.shared"],
    ["NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared"],
    ["NUMA_SHARED_E2E_AUTH_ENABLED", "1"],
    ["NUMA_SHARED_APP_IDENTIFIER", "794UJ787LZ.tech.arsik.numashared"],
    ["NUMA_SHARED_APP_STORE_URL", "https://apps.apple.com/app/id1234567890"],
    ["NUMA_SHARED_CONTROLLER_NAME", "Local test controller"],
    ["NUMA_SHARED_CONTROLLER_ADDRESS", "Local test address"],
    ["NUMA_SHARED_PRIVACY_EMAIL", "privacy@example.invalid"],
    ["NUMA_SHARED_SUPPORT_EMAIL", "support@example.invalid"],
    ["NUMA_SHARED_TRANSFER_MECHANISM", "Local test transfer safeguard"],
  ]);
  for (const [name, value] of expected) {
    if (entries.get(name) !== value) fail(`Local E2E runtime env rejected ${name}`);
  }
  if (!/^local-e2e-[a-f0-9]{16}$/u.test(entries.get("NUMA_SHARED_AUTH_KEY_ID"))) {
    fail("Local E2E signing key id is invalid");
  }
  const privateKey = entries.get("NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM");
  if (
    !privateKey.startsWith("-----BEGIN PRIVATE KEY-----")
    || !privateKey.trimEnd().endsWith("-----END PRIVATE KEY-----")
  ) {
    fail("Local E2E signing key is invalid");
  }
  for (const name of [
    "NUMA_SHARED_TOKEN_HASH_SECRET",
    "NUMA_SHARED_E2E_BOOTSTRAP_SECRET",
  ]) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(entries.get(name))) {
      fail(`Local E2E secret is invalid: ${name}`);
    }
  }
  const jwksURI = entries.get("NUMA_SHARED_AUTH_JWKS_URI");
  const prefix = "data:application/json;base64,";
  if (!jwksURI.startsWith(prefix)) fail("Local E2E JWKS URI is invalid");
  let jwks;
  try {
    jwks = JSON.parse(Buffer.from(jwksURI.slice(prefix.length), "base64").toString("utf8"));
  } catch {
    fail("Local E2E JWKS payload is invalid");
  }
  if (
    !Array.isArray(jwks?.keys)
    || jwks.keys.length !== 1
    || jwks.keys[0].kty !== "EC"
    || jwks.keys[0].crv !== "P-256"
    || jwks.keys[0].alg !== "ES256"
    || jwks.keys[0].use !== "sig"
    || jwks.keys[0].kid !== entries.get("NUMA_SHARED_AUTH_KEY_ID")
    || Object.hasOwn(jwks.keys[0], "d")
  ) {
    fail("Local E2E JWKS must contain exactly one public ES256 key");
  }
}

function generate(shellPath, runtimePath, deploymentName) {
  if (!validDeploymentName(deploymentName)) fail("Invalid anonymous deployment name");
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const keyID = `local-e2e-${randomBytes(8).toString("hex")}`;
  const publicJwk = publicKey.export({ format: "jwk" });
  const jwks = {
    keys: [{ ...publicJwk, kid: keyID, alg: "ES256", use: "sig" }],
  };
  const values = new Map([
    ["NUMA_SHARED_PRODUCT", "numa-shared"],
    ["NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local"],
    ["NUMA_SHARED_DEPLOYMENT_NAME", deploymentName],
    ["NUMA_SHARED_SESSION_ISSUER", "https://auth.local.numa.shared"],
    ["NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared"],
    ["NUMA_SHARED_AUTH_KEY_ID", keyID],
    [
      "NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM",
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ],
    [
      "NUMA_SHARED_AUTH_JWKS_URI",
      `data:application/json;base64,${Buffer.from(JSON.stringify(jwks)).toString("base64")}`,
    ],
    ["NUMA_SHARED_TOKEN_HASH_SECRET", encodeBase64Url(randomBytes(32))],
    ["NUMA_SHARED_E2E_AUTH_ENABLED", "1"],
    ["NUMA_SHARED_E2E_BOOTSTRAP_SECRET", encodeBase64Url(randomBytes(32))],
    ["NUMA_SHARED_APP_IDENTIFIER", "794UJ787LZ.tech.arsik.numashared"],
    ["NUMA_SHARED_APP_STORE_URL", "https://apps.apple.com/app/id1234567890"],
    ["NUMA_SHARED_CONTROLLER_NAME", "Local test controller"],
    ["NUMA_SHARED_CONTROLLER_ADDRESS", "Local test address"],
    ["NUMA_SHARED_PRIVACY_EMAIL", "privacy@example.invalid"],
    ["NUMA_SHARED_SUPPORT_EMAIL", "support@example.invalid"],
    ["NUMA_SHARED_TRANSFER_MECHANISM", "Local test transfer safeguard"],
  ]);
  const runtime = requiredNames
    .map((name) => `${name}=${JSON.stringify(values.get(name))}`)
    .join("\n") + "\n";
  const shell = requiredNames
    .map((name) => `export ${name}=${shellQuote(values.get(name))}`)
    .join("\n") + "\n";
  writeFileSync(runtimePath, runtime, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(shellPath, shell, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(runtimePath, 0o600);
  chmodSync(shellPath, 0o600);
  validateRuntimeFile(runtimePath, deploymentName);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "generate" && args.length === 3) {
  generate(args[0], args[1], args[2]);
} else if (mode === "validate-runtime" && args.length === 2) {
  validateRuntimeFile(args[0], args[1]);
} else {
  fail(
    "Usage: local-e2e-env.mjs generate <shell-file> <runtime-env-file> <anonymous-name> | validate-runtime <runtime-env-file> <anonymous-name>",
  );
}
