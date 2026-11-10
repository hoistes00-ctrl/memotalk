$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot/android"
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {throw 'Java 17 and Android SDK required; Android Studio installs them.'}
if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {Write-Warning 'Android SDK path must be set in ANDROID_HOME or local.properties.'}
$gradleVersion = '8.9'
$gradle = "$PSScriptRoot/.build-tools/gradle-$gradleVersion/bin/gradle.bat"
if (-not (Test-Path $gradle)) {
  $zip = "$PSScriptRoot/.build-tools/gradle.zip"
  New-Item -ItemType Directory -Force "$PSScriptRoot/.build-tools" | Out-Null
  Invoke-WebRequest "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" -OutFile $zip
  Expand-Archive $zip "$PSScriptRoot/.build-tools" -Force
  Remove-Item $zip
}
& $gradle --no-daemon assembleDebug
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed ($LASTEXITCODE)" }
Write-Host "APK: $PSScriptRoot/android/app/build/outputs/apk/debug/app-debug.apk"
