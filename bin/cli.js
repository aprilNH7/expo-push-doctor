#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { runAllChecks, FAIL } = require('../src/checks.js');
const { render } = require('../src/report.js');

function parseArgs(argv) {
  const args = { path: process.cwd(), ipa: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path' || a === '-p') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) {
        return { error: '--path requires a directory argument.' };
      }
      args.path = v;
    } else if (a === '--ipa') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) {
        return { error: '--ipa requires a file path argument.' };
      }
      args.ipa = v;
    } else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
  }
  return args;
}

const HELP = `
expo-push-doctor - find out why iOS push notifications are silently broken

Usage
  npx expo-push-doctor [options]

Options
  -p, --path <dir>   project directory (default: current directory)
      --ipa <file>   also inspect a built .ipa's signed entitlements (macOS)
      --json         machine-readable output
  -h, --help
  -v, --version

Exit code is 1 when a blocking problem is found, so it works in CI.
`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * app.json is the common case. app.config.js is required through Node so that
 * dynamic configs still resolve; a config that throws is reported rather than
 * crashing the run.
 */
function loadAppConfig(root) {
  const jsonPath = path.join(root, 'app.json');
  if (fs.existsSync(jsonPath)) {
    const parsed = readJson(jsonPath);
    if (parsed) return { config: parsed, source: 'app.json' };
  }
  for (const name of ['app.config.js', 'app.config.ts']) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    if (name.endsWith('.ts')) {
      return { config: null, source: name, error: 'TypeScript config cannot be evaluated without a loader.' };
    }
    try {
      const mod = require(p);
      const resolved = typeof mod === 'function' ? mod({ config: {} }) : mod.default || mod;
      return { config: resolved, source: name };
    } catch (e) {
      return { config: null, source: name, error: e.message };
    }
  }
  return { config: null, source: null };
}

/** First *.entitlements under ios/, which is where prebuild writes it. */
function findEntitlements(root) {
  const iosDir = path.join(root, 'ios');
  if (!fs.existsSync(iosDir)) return null;
  const stack = [iosDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'Pods' && e.name !== 'build') stack.push(full);
      } else if (e.name.endsWith('.entitlements')) {
        return { text: readText(full), source: path.relative(root, full) };
      }
    }
  }
  return null;
}

/**
 * Ground truth: what the signed binary actually claims. Config and profile can
 * both look right while this is empty.
 */
function inspectIpa(ipaPath) {
  if (process.platform !== 'darwin') {
    return { text: null, source: null, error: 'IPA inspection needs macOS (codesign).' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-'));
  try {
    execFileSync('unzip', ['-q', ipaPath, '-d', tmp], { stdio: 'ignore' });
    const payload = path.join(tmp, 'Payload');
    const app = fs.readdirSync(payload).find((n) => n.endsWith('.app'));
    if (!app) return { text: null, source: null, error: 'No .app inside Payload/.' };
    const out = execFileSync('codesign', ['-d', '--entitlements', ':-', path.join(payload, app)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { text: out, source: `${path.basename(ipaPath)} (signed)` };
  } catch (e) {
    return { text: null, source: null, error: e.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(args.error + '\n');
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(require('../package.json').version + '\n');
    return 0;
  }

  const root = path.resolve(args.path);
  if (!fs.existsSync(root)) {
    process.stderr.write(`No such directory: ${root}\n`);
    return 2;
  }

  const { config, source, error } = loadAppConfig(root);
  if (!config) {
    process.stderr.write(
      `Could not read an Expo app config in ${root}.\n` +
        (error ? `  ${source}: ${error}\n` : '  Looked for app.json, app.config.js.\n')
    );
    return 2;
  }

  // Prefer the signed binary when given one: it is the only source that proves
  // what shipped rather than what was intended.
  let ent = { text: null, source: null };
  if (args.ipa) {
    const res = inspectIpa(args.ipa);
    if (res.error) process.stderr.write(`Could not read ${args.ipa}: ${res.error}\n`);
    ent = res;
  }
  if (!ent.text) {
    const found = findEntitlements(root);
    if (found) ent = found;
  }

  const results = runAllChecks({
    appConfig: config,
    pkg: readJson(path.join(root, 'package.json')),
    entitlements: ent.text,
    entitlementsSource: ent.source,
    hasIosDir: fs.existsSync(path.join(root, 'ios')),
    gitignore: readText(path.join(root, '.gitignore')),
  });

  if (args.json) {
    process.stdout.write(JSON.stringify({ configSource: source, results }, null, 2) + '\n');
  } else {
    process.stdout.write(render(results) + '\n');
  }

  return results.some((r) => r.status === FAIL) ? 1 : 0;
}

process.exit(main());
