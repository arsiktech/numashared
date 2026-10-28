#!/usr/bin/env node
// Run from app/. Keep signing credentials in the environment, never Gradle properties.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const required = ['ANDROID_HOME', 'JAVA_HOME', 'NUMA_ANDROID_KEYSTORE', 'NUMA_ANDROID_STORE_PASSWORD', 'NUMA_ANDROID_KEY_PASSWORD', 'NUMA_ANDROID_AAB_OUTPUT'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing build environment: ${name}`);
}
const urlNames = ['EXPO_PUBLIC_CONVEX_URL', 'EXPO_PUBLIC_CONVEX_SITE_URL', 'EXPO_PUBLIC_SITE_URL'];
const loopback = (url) => ['127.0.0.1', 'localhost'].includes(url.hostname);
const overrides = urlNames.filter((name) => process.env[name] !== undefined).map((name) => [name, new URL(process.env[name])]);
for (const [name, url] of overrides) {
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) throw new Error(`${name} must use HTTPS or loopback`);
}
if (overrides.some(([, url]) => loopback(url)) &&
    (overrides.length !== urlNames.length || overrides.some(([, url]) => !loopback(url)) || process.env.NUMA_DISABLE_UPDATES !== '1')) {
  throw new Error('Isolated QA requires all three loopback URLs and NUMA_DISABLE_UPDATES=1');
}
const env = { ...process.env, APP_VARIANT: 'production', EXPO_NO_DOTENV: '1' };
const run = (command, args, cwd = process.cwd()) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run('npx', ['expo', 'prebuild', '-p', 'android', '--no-install']);
run('./gradlew', [':app:bundleRelease', '--no-daemon', '--max-workers=4',
  '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1536m', ...process.argv.slice(2)], resolve('android'));
const output = resolve(process.env.NUMA_ANDROID_AAB_OUTPUT);
mkdirSync(dirname(output), { recursive: true });
copyFileSync(resolve('android/app/build/outputs/bundle/release/app-release.aab'), output);
console.log(`Signed Android bundle: ${output}`);
