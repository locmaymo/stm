# Android app

A plain Android app that runs the manager, and the upstream SillyTavern it
installs, on the phone itself: no Termux, no root. The manager's console opens
in a WebView; a foreground service keeps the manager running with the screen
off or another app in front, and its notification's **Stop** shuts it down the
way the Windows launcher does.

Package name: `top.locmaymo.stm`, after the project's domain.

## How it runs programs

Android lets an app start programs only from its native library directory, and
installs only files named `lib*.so` there. So:

- `node`, `git`, git's HTTPS helper and `cloudflared` ship in `jniLibs/<abi>/`
  as `libnode.so`, `libgit.so`, `libgit_remote_http.so` and
  `libcloudflared.so`. They are Termux's Android builds, unmodified.
- The libraries they load, npm, the license files and the CA bundle ship in
  `assets/runtime.tar`; the manager itself (the npm package build) ships in
  `assets/manager.tar`. On first start and after an update that changed them,
  the app unpacks them into its own storage. Loading a library from there is
  allowed; starting a program is not.
- `files/bin/node`, `git` and `cloudflared`, and git's `git-remote-https`,
  are symlinks into the native library directory, made again on every start
  because that directory moves with each update.
- The environment points everything at those places: `LD_LIBRARY_PATH`,
  `GIT_EXEC_PATH`, `GIT_SSL_CAINFO` and `SSL_CERT_FILE`. `STM_NPM_CLI` makes
  the manager run npm as `node npm-cli.js`, because there is no `npm` program
  to start by name, and a shell script standing in for one is refused like any
  other file in the app's storage. `STM_CLOUDFLARED_PATH` names the bundled
  cloudflared, since the manager's own download of it could never be started.

The manager runs `apps/manager-server/src/main.js` with `STM_DATA_DIR` in the
app's storage, on 7860 unless something on the phone already holds it.

## Building

```sh
npm run release:android
```

That runs `scripts/build-android.mjs --apk`: it downloads the pinned packages
(cached under `build/cache/android`), builds the manager's npm package, writes
the assets and `jniLibs`, and builds the APK with the Gradle wrapper into
`build/SillyTavernManager-android-arm64-v8a-v<version>.apk`. It needs a JDK 17
and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`), and
`xz` to unpack Termux's packages (Git for Windows carries one).

`--abi x86_64` builds for the emulator instead. Without `STM_ANDROID_KEYSTORE`
and its password, alias and key password variables, the APK is signed with the
debug key.

A release tag builds the arm64 APK in `.github/workflows/release.yml`, signed
with the release key from the repository secrets `STM_ANDROID_KEYSTORE_BASE64`
(the PKCS12 keystore, base64), `STM_ANDROID_KEYSTORE_PASSWORD`,
`STM_ANDROID_KEY_ALIAS` and `STM_ANDROID_KEY_PASSWORD`. A tag without them
fails the release: phones only take an update signed with the key they
installed from, so that key must never change.

Termux's mirror keeps only current builds, so a pinned package eventually stops
downloading. `node scripts/build-android.mjs --refresh` rewrites
`runtime-packages.json` from the mirror as it is now.
