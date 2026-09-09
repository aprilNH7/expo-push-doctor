# expo-push-doctor

[![test](https://github.com/aprilNH7/expo-push-doctor/actions/workflows/test.yml/badge.svg)](https://github.com/aprilNH7/expo-push-doctor/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

Find out why iOS push notifications are silently broken in your Expo app, in one command.

```
npx expo-push-doctor
```

No install, no config, no dependencies.

## Why this exists

An Expo app shipped to TestFlight with push notifications that never arrived. No
crash, no error in the logs, and no iOS permission prompt at all. The APNs key was
uploaded, the provisioning profile had the Push Notifications capability, the
`expo-notifications` package was installed, `UIBackgroundModes` had
`remote-notification`. Everything looked correct.

The real cause: `expo-notifications` was missing from the `plugins` array in
`app.json`. That plugin is the only thing that writes the `aps-environment`
entitlement into the generated iOS project. Without it, the built binary's
entitlements file was literally empty:

```xml
<plist version="1.0"><dict/></plist>
```

iOS refuses to issue a push token *before* it shows the permission prompt, so the
symptom is "no prompt and no token" — which points at permissions, not at your
config. Meanwhile the package being installed makes the config look finished.

It took a controlled `expo prebuild` diff, plus `codesign -d --entitlements` on the
actual signed `.ipa`, to see it. This tool does that in one command.

## What it checks

| Check | Why it matters |
| --- | --- |
| `expo-notifications` in `plugins` | The only thing that writes `aps-environment`. Missing it kills push regardless of your Apple setup. |
| `expo-notifications` in `package.json` | Installed but not registered as a plugin is the trap. |
| `aps-environment` in entitlements | Ground truth. Reads the generated project, or a signed `.ipa` with `--ipa`. |
| Plugin mode vs. entitlement value | A `development` entitlement in a store build gets a token and silently delivers nothing. |
| `ios.bundleIdentifier` | APNs credentials attach to a bundle id. |
| `extra.eas.projectId` | `getExpoPushTokenAsync` throws without it in standalone builds. |
| Expo Go / SDK version | SDK 53+ has no remote push in Expo Go, and Expo Go can report permission as already granted — masking the real failure. |
| Committed vs. generated `ios/` | If `ios/` is gitignored, every build regenerates entitlements from config and discards your Xcode edits. |
| `remote-notification` background mode | The most common false positive. It only allows background wake-ups. It is not the push entitlement. |

## Usage

```bash
# check the current project
npx expo-push-doctor

# check another directory
npx expo-push-doctor --path ../my-app

# check what actually shipped (macOS, reads the signed binary)
npx expo-push-doctor --ipa ~/Downloads/build.ipa

# machine-readable
npx expo-push-doctor --json

# disable ANSI colors for logs
NO_COLOR=1 npx expo-push-doctor
```

Exit code is `1` when a blocking problem is found, so it works as a CI gate:

```yaml
- run: npx expo-push-doctor
```

## Example output

A project that looks fine and cannot receive a push:

```
FAIL  expo-notifications in plugins
       Missing from the plugins array. This plugin is the only thing that
       writes the aps-environment entitlement, so your binary is being built
       without push capability no matter what your provisioning profile allows.
       -> Add ["expo-notifications", { "mode": "production" }] to plugins, then
          make a new native build. An OTA update cannot fix this - entitlements
          are compiled into the binary.

FAIL  aps-environment in entitlements
       Not present in ios/App/App.entitlements. This is the exact condition
       behind "no valid aps-environment entitlement string found for
       application".

INFO  remote-notification background mode
       Set. Worth being clear: this only allows waking in the background. It is
       not the push entitlement and does not help a token get issued.

2 blocking problems. Push cannot work until fixed.
Entitlements are compiled into the binary. A new native build is required - eas update will not fix it.
```

## The one thing worth remembering

Entitlements are compiled into the binary at build time. `eas update` cannot fix
a push problem. If `aps-environment` is missing, you need a new native build —
there is no shortcut.

## Errors this explains

If you searched any of these, this tool is for you:

- `no valid aps-environment entitlement string found for application`
- Expo push notifications work on Android but not iOS
- No iOS notification permission prompt ever appears
- `getExpoPushTokenAsync` fails in a TestFlight build but works in development
- Push token is issued but notifications never arrive

## Contributing

Checks live in `src/checks.js` as pure functions returning
`{ id, title, status, detail, fix }`. They take parsed input and do no I/O, so
adding one means adding a function and a test — no fixture project needed.

```bash
npm test
```

If you hit a push failure this tool did not catch, open an issue with your
`app.json` and the entitlements output. That is the most useful contribution.

## Related

[**expo-preflight**](https://github.com/aprilNH7/expo-preflight) is the wider
version of the same idea: 17 checks for everything else that fails at upload or
in App Review, from an icon with an alpha channel, to a secret inlined into your
JS bundle, to an OTA update that cannot reach a single installed device. Same
zero-dependency, one-command shape.

## License

MIT
