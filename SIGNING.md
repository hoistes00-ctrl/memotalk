# MemoTalk Android signing and safe upgrades

The Android **official** application ID is `kr.memotalk.app`. The previously published experimental application's ID is `kr.memotalk.app.test`. These are separate Android installations and do **not** automatically share stored notes.

## Why this needs a signing key

Android can update an installed APK in place only if the application ID matches **and** the new APK is signed by the same signing identity accepted for that installed app. A different signing key will cause the update to be rejected. Changing only the app's displayed name will not fix this.

The GitHub Actions debug key used for earlier `.test` APKs is ephemeral. Do not assume a newly generated debug APK can overwrite the earlier one.

**Protect existing notes:** export a JSON backup from the installed app and verify the file exists **before** you uninstall anything. Do not upload real note backups to the public repository.

## Use the original signing key if you have it

If the existing `kr.memotalk.app` installation was built with a key you still have, reuse that keystore for official APK updates. The original key may be a release keystore (`.jks` / `.keystore`), or an Android Studio debug keystore from the PC that built the old APK. The latter is not a recommended long-term public distribution key.

If the original signing key is unavailable, the first official build cannot overwrite the differently signed existing installation. You must plan a **one-time** export/import migration instead. Future official builds can update each other once you keep a persistent dedicated signing key.

## Create a private persistent key only if needed

Run this on **your own PC** with Java `keytool` available, outside any Git repository:

```powershell
keytool -genkeypair -v -keystore MemoTalk-release.jks -alias memotalk -keyalg RSA -keysize 3072 -validity 36500
```

Set strong passwords when prompted, securely back up the keystore and passwords, and never commit or upload them as public source code.

## Configure GitHub Actions secrets

Open **Repository → Settings → Secrets and variables → Actions → New repository secret**.

Add these *four* repository secrets; do **not** paste their values into source code, issues, chat, or README:

| Secret name | Value |
|---|---|
| `MEMOTALK_ANDROID_KEYSTORE_BASE64` | Base64 text of your private keystore |
| `MEMOTALK_ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `MEMOTALK_ANDROID_KEY_ALIAS` | Key alias |
| `MEMOTALK_ANDROID_KEY_PASSWORD` | Key password |

On the PC where the keystore is stored, calculate the Base64 value in PowerShell, replacing the file path:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\SecureKeys\MemoTalk-release.jks"))
```

Paste the result **only** into GitHub's corresponding private Actions secret.

After adding all four secrets, run the workflow **Actions → Publish signed official MemoTalk Android APK → Run workflow**:

`https://github.com/hoistes00-ctrl/memotalk/actions/workflows/android-stable-apk.yml`

It verifies the app ID and APK signature, and publishes the signed APK to branch `android-official-downloads`. It does not upload the signing key. The official download button should only be activated **after** this workflow has succeeded.

**Important:** if you have installed the earlier `메모톡 테스트` (`.test` package), the official app is a different package and cannot update it in place; make a backup and import it into the official app first.
