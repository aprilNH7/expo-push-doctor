'use strict';

/**
 * Every check is a pure function so the diagnosis can be tested without a real
 * Expo project on disk. The CLI does the I/O and hands the parsed values in.
 *
 * Each returns: { id, title, status, detail, fix? }
 *   fail — push cannot work until this is fixed
 *   warn — probably wrong, or right but worth knowing
 *   pass — verified good
 *   info — context, not a verdict
 *   skip — could not be determined from what was available
 */

const FAIL = 'fail';
const WARN = 'warn';
const PASS = 'pass';
const INFO = 'info';
const SKIP = 'skip';

/**
 * app.json wraps everything in `expo`, app.config.js usually does not.
 */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return raw.expo && typeof raw.expo === 'object' ? raw.expo : raw;
}

/**
 * Plugin entries come in two shapes: "expo-notifications" or
 * ["expo-notifications", { mode: "production" }].
 */
function findPlugin(config, name) {
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  for (const entry of plugins) {
    if (typeof entry === 'string') {
      if (entry === name || entry === `${name}/app.plugin.js`) {
        return { found: true, options: null };
      }
      continue;
    }
    if (Array.isArray(entry) && typeof entry[0] === 'string') {
      if (entry[0] === name || entry[0] === `${name}/app.plugin.js`) {
        return { found: true, options: entry[1] && typeof entry[1] === 'object' ? entry[1] : null };
      }
    }
  }
  return { found: false, options: null };
}

function isValidMode(mode) {
  return mode === 'development' || mode === 'production';
}

/**
 * The check that matters most, and the one that is almost impossible to spot by
 * reading your own config: this plugin is the only thing that writes the
 * `aps-environment` entitlement. Without it iOS refuses to issue a token
 * *before* it shows the permission prompt, so the symptom is "no prompt and no
 * token" rather than anything that points at the cause.
 */
function checkNotificationsPlugin(config) {
  const { found, options } = findPlugin(config, 'expo-notifications');
  if (!found) {
    return {
      id: 'plugin',
      title: 'expo-notifications in plugins',
      status: FAIL,
      detail:
        'Missing from the plugins array. This plugin is the only thing that writes the ' +
        'aps-environment entitlement, so your binary is being built without push ' +
        'capability no matter what your provisioning profile allows.',
      fix: 'Add ["expo-notifications", { "mode": "production" }] to plugins, then make a new native build. An OTA update cannot fix this - entitlements are compiled into the binary.',
    };
  }
  const mode = options && typeof options.mode === 'string' ? options.mode : null;
  if (!mode) {
    return {
      id: 'plugin',
      title: 'expo-notifications in plugins',
      status: WARN,
      detail:
        'Present, but no mode is set, so it defaults to "development". A ' +
        'TestFlight or App Store build needs "production" or APNs will reject ' +
        'the token as being for the wrong environment.',
      fix: 'Set { "mode": "production" } for release builds.',
    };
  }
  if (!isValidMode(mode)) {
    return {
      id: 'plugin',
      title: 'expo-notifications in plugins',
      status: WARN,
      detail: `Present with mode "${mode}", which is not a valid value. The plugin only recognizes "development" or "production".`,
      fix: 'Set { "mode": "production" } for release builds, or "development" for local/debug builds.',
    };
  }
  return {
    id: 'plugin',
    title: 'expo-notifications in plugins',
    status: PASS,
    detail: `Present with mode "${mode}".`,
  };
}

/**
 * Extract the major SDK version from a semver-style range. Ranges like ~53.0.0
 * and ^52.1.2 are the normal shape in package.json; bare integers are rare,
 * so the regex looks for the first digits followed by a dot.
 */
function parseMajor(range) {
  if (typeof range !== 'string') return null;
  const m = range.match(/(\d+)\./);
  return m ? Number.parseInt(m[1], 10) : null;
}

function checkDependency(pkg) {
  const deps = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
  const range = deps['expo-notifications'];
  if (!range) {
    return {
      id: 'dependency',
      title: 'expo-notifications installed',
      status: FAIL,
      detail: 'Not in package.json.',
      fix: 'npx expo install expo-notifications',
    };
  }
  return {
    id: 'dependency',
    title: 'expo-notifications installed',
    status: PASS,
    detail: `Found ${range}.`,
  };
}

function checkBundleIdentifier(config) {
  const id = config.ios && config.ios.bundleIdentifier;
  if (!id || typeof id !== 'string' || id.trim() === '' || id.includes(' ')) {
    return {
      id: 'bundle-id',
      title: 'ios.bundleIdentifier set',
      status: FAIL,
      detail: 'Missing or invalid. APNs credentials are attached to a bundle identifier, so there is nothing to attach them to.',
      fix: 'Set ios.bundleIdentifier to a non-empty string without spaces in your app config.',
    };
  }
  return { id: 'bundle-id', title: 'ios.bundleIdentifier set', status: PASS, detail: id };
}

/**
 * Reads a signed binary's or generated project's entitlements. This is the
 * ground truth - config can look perfect while the built artifact is empty.
 */
function checkEntitlements(entitlementsText, source) {
  if (!entitlementsText) {
    return {
      id: 'entitlements',
      title: 'aps-environment in entitlements',
      status: SKIP,
      detail: 'No entitlements file or built binary was available to inspect.',
      fix: 'Run with --ipa <path to .ipa> to check what actually shipped, or run expo prebuild first.',
    };
  }
  const match = entitlementsText.match(
    /<key>\s*aps-environment\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/i
  );
  if (!match) {
    return {
      id: 'entitlements',
      title: 'aps-environment in entitlements',
      status: FAIL,
      detail: `Not present in ${source}. This is the exact condition behind "no valid aps-environment entitlement string found for application".`,
      fix: 'Add expo-notifications to plugins and rebuild. If entitlements are empty (<dict/>), no plugin wrote them.',
    };
  }
  return {
    id: 'entitlements',
    title: 'aps-environment in entitlements',
    status: PASS,
    detail: `"${match[1]}" in ${source}.`,
  };
}

/**
 * A development entitlement in a store build is a slow, confusing failure: the
 * token is issued, sends are accepted, and nothing ever arrives.
 */
function checkModeAgreement(pluginMode, entitlementValue) {
  if (!pluginMode || !entitlementValue) {
    return {
      id: 'mode-match',
      title: 'entitlement matches plugin mode',
      status: SKIP,
      detail: 'Need both a plugin mode and a readable entitlement to compare.',
    };
  }
  if (pluginMode === entitlementValue) {
    return {
      id: 'mode-match',
      title: 'entitlement matches plugin mode',
      status: PASS,
      detail: `Both "${pluginMode}".`,
    };
  }
  return {
    id: 'mode-match',
    title: 'entitlement matches plugin mode',
    status: WARN,
    detail: `Plugin says "${pluginMode}" but the binary carries "${entitlementValue}". A development entitlement in a store build gets a token and silently delivers nothing.`,
    fix: 'Align the plugin mode with how you distribute this build, then rebuild.',
  };
}

/**
 * Learned the hard way: with no committed ios/ directory, entitlements are
 * regenerated from config on every build. Anything hand-edited in Xcode is
 * discarded, which makes the plugin the only durable fix.
 */
function checkNativeDirs(hasIosDir, gitignoreText) {
  const ignored = typeof gitignoreText === 'string' && /^\/?ios\/?\s*$/m.test(gitignoreText);
  if (hasIosDir && ignored) {
    return {
      id: 'native-dirs',
      title: 'how entitlements get generated',
      status: INFO,
      detail:
        'ios/ exists locally but is gitignored, so it is a throwaway artifact: EAS regenerates entitlements ' +
        'from your config on every build. Anything you fix by hand in Xcode is silently discarded.',
      fix: 'Change push config through app config plugins, not Xcode.',
    };
  }
  if (!hasIosDir) {
    return {
      id: 'native-dirs',
      title: 'how entitlements get generated',
      status: INFO,
      detail:
        'No ios/ directory, so prebuild regenerates entitlements from your config on every build. ' +
        'Editing entitlements by hand in Xcode will not survive.',
      fix: 'Change push config through app config plugins, not Xcode.',
    };
  }
  return {
    id: 'native-dirs',
    title: 'how entitlements get generated',
    status: INFO,
    detail: 'A committed ios/ directory exists, so its entitlements file is used as-is. Keep it in sync with your config.',
  };
}

/**
 * UIBackgroundModes is the single most common false positive. It makes the
 * config look finished while the entitlement is still missing.
 */
function checkBackgroundModes(config) {
  const modes = (config.ios && config.ios.infoPlist && config.ios.infoPlist.UIBackgroundModes) || [];
  const has = Array.isArray(modes) && modes.includes('remote-notification');
  return {
    id: 'background-modes',
    title: 'remote-notification background mode',
    status: INFO,
    detail: has
      ? 'Set. Worth being clear: this only allows waking in the background. It is not the push entitlement and does not help a token get issued.'
      : 'Not set. Only needed for silent/background notifications; normal alerts work without it.',
  };
}

function checkExpoGo(pkg) {
  const major = parseMajor(((pkg && pkg.dependencies) || {}).expo);
  if (!major) {
    return { id: 'expo-go', title: 'Expo Go support', status: SKIP, detail: 'Could not read the expo version.' };
  }
  if (major >= 53) {
    return {
      id: 'expo-go',
      title: 'Expo Go support',
      status: WARN,
      detail: `SDK ${major}: remote push notifications are not supported in Expo Go. Expo Go can also report permission as already granted, which hides the real failure.`,
      fix: 'Test push in a development build or a real EAS build, never in Expo Go.',
    };
  }
  return { id: 'expo-go', title: 'Expo Go support', status: PASS, detail: `SDK ${major}.` };
}

function checkProjectId(config) {
  const id = config.extra && config.extra.eas && config.extra.eas.projectId;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    return {
      id: 'project-id',
      title: 'EAS projectId set',
      status: WARN,
      detail: 'extra.eas.projectId is missing or empty. getExpoPushTokenAsync needs it in a bare/standalone build and will throw without it.',
      fix: 'Run eas init, or set extra.eas.projectId to a non-empty string.',
    };
  }
  return { id: 'project-id', title: 'EAS projectId set', status: PASS, detail: id };
}

/**
 * @param {object} input
 * @param {object|null} input.appConfig   parsed app.json / app.config.js
 * @param {object|null} input.pkg         parsed package.json
 * @param {string|null} input.entitlements  entitlements XML, if any
 * @param {string|null} input.entitlementsSource  where it came from
 * @param {boolean} input.hasIosDir
 * @param {string|null} input.gitignore
 */
function runAllChecks(input) {
  const config = normalizeConfig(input.appConfig);
  const pkg = input.pkg || {};
  const plugin = findPlugin(config, 'expo-notifications');
  const pluginMode = plugin.options && typeof plugin.options.mode === 'string' ? plugin.options.mode : null;

  const entitlementsCheck = checkEntitlements(input.entitlements, input.entitlementsSource || 'entitlements');
  const entitlementValue =
    entitlementsCheck.status === PASS ? (entitlementsCheck.detail.match(/"([^"]+)"/) || [])[1] || null : null;

  return [
    checkNotificationsPlugin(config),
    checkDependency(pkg),
    checkBundleIdentifier(config),
    checkProjectId(config),
    entitlementsCheck,
    checkModeAgreement(pluginMode, entitlementValue),
    checkExpoGo(pkg),
    checkNativeDirs(input.hasIosDir, input.gitignore),
    checkBackgroundModes(config),
  ];
}

module.exports = {
  FAIL,
  WARN,
  PASS,
  INFO,
  SKIP,
  normalizeConfig,
  parseMajor,
  isValidMode,
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
};
