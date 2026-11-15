# Sharing sync recovery and native read fixes

Windows `17.1.1-sharing.5-syncfix.1` and Android `17.1.1-sharing.5-syncfix.2` contain the fixes validated on a Windows PC and Galaxy Flip5. This branch remains separate from the stable release.

## Behavior changes

- Valid immutable operations from another group are counted separately from malformed or incomplete operations. They are preserved rather than imported automatically. Once validated, their IDs and group IDs are cached locally to avoid rereading them on every scan. Corrupt operations remain blocked and are retried.
- An explicit recovery action can join an already-present group after validating its operations and backing up the previous local state and manifest. It preserves both original ledgers, checks the manifest before writing, and only rolls back bytes written by that attempt. This is not automatic cross-group merging.
- Diagnostics show the current cycle stage, busy state and outstanding native request metadata, and offer a manual refresh button. Memo bodies, file contents, folder tokens and write leases are not retained in request diagnostics.
- Native reads use a direct request instead of repeated directory-handle/stat traversal. Android treats a missing ancestor during read/stat as an absent file, without creating directories. A new memo can therefore publish into a previously nonexistent readable subdirectory instead of failing with `EIO`.

`readable/*.md` is a readable projection. `operations/*.json` is the immutable history consumed by MemoTalk. Delivery of a Markdown file alone does not prove that the corresponding JSON reached the other app.

## Device validation and limits

After preserving the original app data, the Android fixes were installed and verified across a full process restart without runtime code injection. New notes were sent in both directions through the actual Obsidian Sync server. Each test JSON had matching SHA-256 values on the PC, server metadata and phone; both actual app screens displayed the notes. Existing memo contents, comments and original JSON were checked for preservation. The test room's latest-message preview and activity timestamp changed normally after adding the test notes.

No extra Obsidian plugin or manual file reconciliation was used for the final automatic roundtrip. The devices still require MemoTalk, Obsidian and network availability. Extended sleep, every reboot scenario and real photo roundtrips are outside this device validation. Synthetic Android tests are not a substitute for this device evidence, and device evidence is not a claim that every CI job has passed.

## Existing APK signatures and the optional separate install

An installed APK can only be updated in place with the same application ID and an accepted signing identity. Earlier sharing previews built with ephemeral CI debug keys may reject a later APK. Never uninstall an existing app to work around a signature mismatch without an independently verified backup and an agreed migration plan.

To build the separate recovery package, use Gradle 8.9 and the existing signing environment described in [SIGNING.md](../SIGNING.md):

```sh
gradle -p android -PmemotalkMigrationPreview=true testSharingPreviewUnitTest assembleSharingPreview
```

This produces `kr.memotalk.app.sharingpreview5.syncfix`, labelled **메모톡 동기화 수정판**, alongside existing installations. Omitting the property retains the normal `kr.memotalk.app.sharingpreview5` preview package. The flag does not migrate data or grant folder access. Preserve memo IDs and history during any separately authorized migration; importing a backup may create additional copies. Android's persisted folder grant must be selected again for a different application ID. Use the same existing shared folder and group rather than creating a replacement group.

Retain the signing identity used for the new package for subsequent in-place updates. A newly generated CI debug key is not guaranteed to match it. Private keystores, passwords, device backups and real note data are not part of this repository.

## Regression checks

The existing Node test suite is supplemented by synthetic foreign-group isolation/caching, explicit existing-group recovery, and stalled-read progress/request diagnostics tests. The Android instrumentation suite includes a missing-ancestor read/stat test that verifies no directory is created. During device repair, the latter behavior was also checked directly on the installed APK; the full instrumentation suite was not run against real user data.
