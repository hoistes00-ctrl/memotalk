"""Verify that the APK contains exactly the tested shared UI and sync modules."""
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
apk = Path(sys.argv[1])
with zipfile.ZipFile(apk) as archive:
    for name in ('index.html', 'platform-bridge.js', 'mirror-engine.js', 'peer-sync-engine.js', 'peer-sync-client.js'):
        assert archive.read('assets/' + name) == (root / 'shared' / name).read_bytes(), name + ' differs from tested source'
print('Verified packaged Android UI, native bridge and both synchronization engines.')
