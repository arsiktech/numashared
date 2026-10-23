#!/usr/bin/env node
// Run from app/. Keep signing credentials in the environment, never Gradle properties.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const required = ['ANDROID_HOME', 'JAVA_HOME', 'NUMA_ANDROID_KEYSTORE', 'NUMA_ANDROID_STORE_PASSWORD', 'NUMA_ANDROID_KEY_PASSWORD', 'NUMA_ANDROID_AAB_OUTPUT', 'EXPO_PUBLIC_CONVEX_URL', 'EXPO_PUBLIC_CONVEX_SITE_URL', 'EXPO_PUBLIC_SITE_URL'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing build environment: ${name}`);
}
for (const name of ['EXPO_PUBLIC_CONVEX_URL', 'EXPO_PUBLIC_CONVEX_SITE_URL', 'EXPO_PUBLIC_SITE_URL']) {
  const url = new URL(process.env[name]);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`${name} must use HTTPS or loopback`);
}
const env = { ...process.env, APP_VARIANT: 'production', EXPO_NO_DOTENV: '1' };
const run = (command, args, cwd = process.cwd()) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run('npx', ['expo', 'prebuild', '-p', 'android', '--no-install']);
run('./gradlew', [':app:bundleRelease', '--no-daemon', '--max-workers=4', ...process.argv.slice(2)], resolve('android'));
const output = resolve(process.env.NUMA_ANDROID_AAB_OUTPUT);
mkdirSync(dirname(output), { recursive: true });
copyFileSync(resolve('android/app/build/outputs/bundle/release/app-release.aab'), output);
console.log(`Signed Android bundle: ${output}`);
