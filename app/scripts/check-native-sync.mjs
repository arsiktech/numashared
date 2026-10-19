#!/usr/bin/env node
// The iOS project is committed (Xcode Cloud builds it as is), so app.json and app.config.ts no
// longer reach it on their own. This regenerates ios/ from the config in a scratch copy and fails
// when the committed project differs. Fix a failure with:
//   npx expo prebuild --platform ios --no-install --clean   (then restore ios/ci_scripts)
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
// Files that prebuild doesn't own or git ignores: CocoaPods output (lock file, Pods, the
// workspace), Xcode's per-user state, the Xcode Cloud script, local machine config.
const ignored = ['Podfile.lock', 'Pods', 'NumaShared.xcworkspace', 'project.xcworkspace', 'xcuserdata', 'ci_scripts', '.xcode.env.local', 'build'];

const scratch = mkdtempSync(join(tmpdir(), 'numa-native-sync-'));
try {
  cpSync(app, scratch, {
    recursive: true,
    filter: (src) => !['node_modules', 'ios', 'android', 'dist', '.expo'].some((d) => src === join(app, d)),
  });
  symlinkSync(join(app, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  execFileSync('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install', '--clean'], {
    cwd: scratch, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CI: '1', EXPO_NO_GIT_STATUS: '1' },
  });
  try {
    execFileSync('diff', ['-r', ...ignored.flatMap((x) => ['-x', x]), join(app, 'ios'), join(scratch, 'ios')], { stdio: 'inherit' });
  } catch {
    console.error('\nios/ is out of date with app.json or app.config.ts. Regenerate it (see the top of this script).');
    process.exit(1);
  }
  console.log('ios/ matches the app config.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
