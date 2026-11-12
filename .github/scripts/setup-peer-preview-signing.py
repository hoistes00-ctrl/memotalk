"""Use an owner-provided signing identity when available; never publish a key."""
import base64
import os
from pathlib import Path
import uuid

names = ('KEYSTORE_B64', 'KEYSTORE_PW', 'KEY_ALIAS', 'KEY_PW')
values = [os.environ.get(name, '') for name in names]
exports = {'MEMOTALK_PREVIEW_SIGNING': 'debug-ephemeral'}
if all(values):
    key = Path(os.environ['RUNNER_TEMP']) / 'memotalk-sharing-preview.jks'
    key.write_bytes(base64.b64decode(''.join(values[0].split()), validate=True))
    key.chmod(0o600)
    exports.update(MEMOTALK_KEYSTORE_FILE=str(key), MEMOTALK_KEYSTORE_PASSWORD=values[1],
                   MEMOTALK_KEY_ALIAS=values[2], MEMOTALK_KEY_PASSWORD=values[3], MEMOTALK_PREVIEW_SIGNING='owner')
    print('Using the existing private owner signing identity for the isolated preview package.')
else:
    print('::notice::Preview uses an ephemeral debug signature. It is a separate app; future in-place preview updates require a persistent signing identity.')
with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as env:
    for name, value in exports.items():
        delimiter = 'MEMOTALK_' + uuid.uuid4().hex
        env.write(name + '<<' + delimiter + '\n' + value + '\n' + delimiter + '\n')
