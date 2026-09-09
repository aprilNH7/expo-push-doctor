'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  FAIL,
  WARN,
  PASS,
  INFO,
  SKIP,
  normalizeConfig,
  findPlugin,
  checkNotificationsPlugin,
  checkDependency,
  checkBundleIdentifier,
  checkEntitlements,
  checkModeAgreement,
  checkNativeDirs,
  checkBackgroundModes,
  checkExpoGo,
  checkProjectId,
  runAllChecks,
} = require('../src/checks.js');

test('normalizeConfig unwraps app.json but leaves app.config.js alone', () => {
  assert.deepStrictEqual(normalizeConfig({ expo: { name: 'a' } }), { name: 'a' });
  assert.deepStrictEqual(normalizeConfig({ name: 'b' }), { name: 'b' });
  assert.deepStrictEqual(normalizeConfig(null), {});
});

test('findPlugin handles both string and [name, options] shapes', () => {
  assert.strictEqual(findPlugin({ plugins: ['expo-notifications'] }, 'expo-notifications').found, true);
  const withOpts = findPlugin(
    { plugins: [['expo-notifications', { mode: 'production' }]] },
    'expo-notifications'
  );
  assert.strictEqual(withOpts.found, true);
  assert.strictEqual(withOpts.options.mode, 'production');
  assert.strictEqual(findPlugin({ plugins: [] }, 'expo-notifications').found, false);
  assert.strictEqual(findPlugin({}, 'expo-notifications').found, false);
});

test('a missing plugin is the headline failure, and says an OTA will not fix it', () => {
  // The whole reason this tool exists: config looks complete, push is dead.
  const r = checkNotificationsPlugin({ plugins: ['expo-secure-store'] });
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /aps-environment/);
  assert.match(r.fix, /new native build/i);
});

test('a plugin with no mode warns, because it silently defaults to development', () => {
  const r = checkNotificationsPlugin({ plugins: ['expo-notifications'] });
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /development/);
});

test('a plugin with an explicit mode passes and reports it', () => {
  const r = checkNotificationsPlugin({ plugins: [['expo-notifications', { mode: 'production' }]] });
  assert.strictEqual(r.status, PASS);
  assert.match(r.detail, /production/);
});

test('a plugin with a misspelled or unknown mode warns', () => {
  const r = checkNotificationsPlugin({ plugins: [['expo-notifications', { mode: 'prod' }]] });
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /not a valid value/i);
  assert.match(r.fix, /development/);
  assert.match(r.fix, /production/);
});

test('entitlements are read from the plist, not guessed', () => {
  const good = `<plist><dict><key>aps-environment</key><string>production</string></dict></plist>`;
  const r = checkEntitlements(good, 'IQGen.entitlements');
  assert.strictEqual(r.status, PASS);
  assert.match(r.detail, /production/);
});

test('an empty entitlements dict is the real-world symptom and must fail', () => {
  // This is exactly what a build without the plugin produces.
  const r = checkEntitlements('<plist><dict/></plist>', 'app.entitlements');
  assert.strictEqual(r.status, FAIL);
  assert.match(r.detail, /no valid aps-environment/i);
});

test('unreadable entitlements skip rather than falsely passing or failing', () => {
  assert.strictEqual(checkEntitlements(null, null).status, SKIP);
});

test('a development entitlement in a production build warns about silent delivery', () => {
  const r = checkModeAgreement('production', 'development');
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /silently/);
});

test('matching modes pass, and an unknown side skips', () => {
  assert.strictEqual(checkModeAgreement('production', 'production').status, PASS);
  assert.strictEqual(checkModeAgreement(null, 'production').status, SKIP);
});

test('missing dependency and bundle identifier both fail', () => {
  assert.strictEqual(checkDependency({ dependencies: {} }).status, FAIL);
  assert.strictEqual(checkDependency({ dependencies: { 'expo-notifications': '~0.31.5' } }).status, PASS);
  assert.strictEqual(checkBundleIdentifier({}).status, FAIL);
  assert.strictEqual(checkBundleIdentifier({ ios: { bundleIdentifier: 'com.a.b' } }).status, PASS);
});

test('a missing EAS projectId warns, since getExpoPushTokenAsync throws without it', () => {
  assert.strictEqual(checkProjectId({}).status, WARN);
  assert.strictEqual(checkProjectId({ extra: { eas: { projectId: 'x' } } }).status, PASS);
});

test('Expo Go is flagged on SDK 53+ because it masks the real failure', () => {
  const r = checkExpoGo({ dependencies: { expo: '~53.0.0' } });
  assert.strictEqual(r.status, WARN);
  assert.match(r.detail, /permission as already granted/);
  assert.strictEqual(checkExpoGo({ dependencies: { expo: '~52.0.0' } }).status, PASS);
});

test('a gitignored ios/ explains why Xcode edits vanish', () => {
  const r = checkNativeDirs(true, 'node_modules/\nios/\nandroid/\n');
  assert.strictEqual(r.status, INFO);
  assert.match(r.detail, /regenerates entitlements/);
  assert.match(r.detail, /gitignored/);
  assert.match(r.fix, /not Xcode/);
});

test('no ios/ directory at all is reported as prebuild-generated', () => {
  const r = checkNativeDirs(false, '');
  assert.match(r.detail, /No ios\/ directory/);
});

test('a committed ios/ is reported differently', () => {
  const r = checkNativeDirs(true, 'node_modules/\n');
  assert.match(r.detail, /used as-is/);
});

test('background mode is reported as context, never a verdict', () => {
  const set = checkBackgroundModes({
    ios: { infoPlist: { UIBackgroundModes: ['remote-notification'] } },
  });
  assert.strictEqual(set.status, INFO);
  assert.match(set.detail, /not the push entitlement/);

  const unset = checkBackgroundModes({ ios: {} });
  assert.strictEqual(unset.status, INFO);
  assert.match(unset.detail, /Only needed for silent/);
});

test('runAllChecks reproduces the real-world broken project', () => {
  // Config that looks finished: notifications installed, background mode set,
  // bundle id present - and push completely dead because the plugin is absent.
  const results = runAllChecks({
    appConfig: {
      expo: {
        plugins: ['expo-secure-store'],
        ios: {
          bundleIdentifier: 'com.iqgen.energy',
          infoPlist: { UIBackgroundModes: ['remote-notification'] },
        },
        extra: { eas: { projectId: 'abc' } },
      },
    },
    pkg: { dependencies: { expo: '~53.0.0', 'expo-notifications': '~0.31.5' } },
    entitlements: '<plist><dict/></plist>',
    entitlementsSource: 'IQGen.entitlements',
    hasIosDir: true,
    gitignore: 'ios/\n',
  });

  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.strictEqual(byId.plugin.status, FAIL);
  assert.strictEqual(byId.entitlements.status, FAIL);
  // The background mode must not be presented as reassurance.
  assert.strictEqual(byId['background-modes'].status, INFO);
  assert.match(byId['background-modes'].detail, /not the push entitlement/);
});

test('runAllChecks passes a correctly configured project', () => {
  const results = runAllChecks({
    appConfig: {
      expo: {
        plugins: [['expo-notifications', { mode: 'production' }]],
        ios: { bundleIdentifier: 'com.iqgen.energy' },
        extra: { eas: { projectId: 'abc' } },
      },
    },
    pkg: { dependencies: { expo: '~52.0.0', 'expo-notifications': '~0.31.5' } },
    entitlements: '<plist><dict><key>aps-environment</key><string>production</string></dict></plist>',
    entitlementsSource: 'signed binary',
    hasIosDir: false,
    gitignore: '',
  });
  assert.strictEqual(results.filter((r) => r.status === FAIL).length, 0);
  assert.strictEqual(results.filter((r) => r.status === WARN).length, 0);
});
