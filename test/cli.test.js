'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: cwd || process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const BROKEN = {
  'app.json': JSON.stringify({
    expo: { plugins: ['expo-secure-store'], ios: { bundleIdentifier: 'com.example.app' } },
  }),
  'package.json': JSON.stringify({ dependencies: { expo: '~53.0.0', 'expo-notifications': '~0.31.5' } }),
  '.gitignore': 'ios/\n',
  'ios/App/App.entitlements': '<plist version="1.0"><dict/></plist>',
};

const HEALTHY = {
  'app.json': JSON.stringify({
    expo: {
      plugins: [['expo-notifications', { mode: 'production' }]],
      ios: { bundleIdentifier: 'com.example.app' },
      extra: { eas: { projectId: 'abc-123' } },
    },
  }),
  'package.json': JSON.stringify({ dependencies: { expo: '~52.0.0', 'expo-notifications': '~0.31.5' } }),
  'ios/App/App.entitlements':
    '<plist version="1.0"><dict><key>aps-environment</key><string>production</string></dict></plist>',
};

test('exits 1 on a broken project so it can gate CI', () => {
  const r = run(['--path', fixture(BROKEN)]);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /FAIL {2}expo-notifications in plugins/);
  assert.match(r.stdout, /eas update will not fix it/);
});

test('exits 0 on a healthy project', () => {
  const r = run(['--path', fixture(HEALTHY)]);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /No problems found/);
});

test('--json emits parseable results and keeps the exit code', () => {
  const r = run(['--json', '--path', fixture(BROKEN)]);
  assert.strictEqual(r.code, 1);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.configSource, 'app.json');
  assert.ok(parsed.results.find((x) => x.id === 'plugin' && x.status === 'fail'));
});

test('reads a dynamic app.config.js', () => {
  const dir = fixture({
    'app.config.js':
      'module.exports = { expo: { plugins: [["expo-notifications", { mode: "production" }]], ios: { bundleIdentifier: "com.example.app" }, extra: { eas: { projectId: "x" } } } };',
    'package.json': JSON.stringify({ dependencies: { expo: '~52.0.0', 'expo-notifications': '~0.31.5' } }),
  });
  const r = run(['--json', '--path', dir]);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.configSource, 'app.config.js');
  assert.ok(parsed.results.find((x) => x.id === 'plugin' && x.status === 'pass'));
});

test('a directory with no Expo config fails loudly instead of reporting a clean bill of health', () => {
  const r = run(['--path', fixture({ 'readme.md': 'hi' })]);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /Could not read an Expo app config/);
});

test('--help and --version exit 0', () => {
  assert.strictEqual(run(['--help']).code, 0);
  assert.match(run(['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('missing required flag values are reported instead of mis-parsed', () => {
  const missingPath = run(['--path']);
  assert.strictEqual(missingPath.code, 2);
  assert.match(missingPath.stderr, /--path requires a directory argument/);

  const missingIpa = run(['--ipa', '--json']);
  assert.strictEqual(missingIpa.code, 2);
  assert.match(missingIpa.stderr, /--ipa requires a file path argument/);
});
