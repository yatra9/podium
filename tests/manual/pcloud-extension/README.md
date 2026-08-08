# pCloud Chrome-extension capability probe

This unpacked Manifest V3 extension verifies the one uncertain provider boundary
before pCloud support is added to Podium: whether an extension can call
`getfilelink` and read the returned private file URL as an `ArrayBuffer`.

## Fixed identity

- Extension ID: `gdekbcnhempebaocajciooibhhgnbdjb`
- OAuth redirect URI:
  `https://gdekbcnhempebaocajciooibhhgnbdjb.chromiumapp.org/`

The public manifest `key` fixes the unpacked extension ID across installations.
It is not a credential or a signing key.

## Setup

1. For OAuth, register a pCloud application and add the OAuth redirect URI above.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this `tests/manual/pcloud-extension` directory.
4. Click the extension toolbar action to open the probe.
5. While OAuth approval is pending, use **Direct login (test only)**. Otherwise,
   enter the public pCloud Client ID and follow the numbered buttons.
6. Ensure at least one PDF exists in the root of the test pCloud account.

Do not enter or commit a Client Secret. OAuth access tokens are held in memory
only and disappear when the probe tab is closed or reloaded.

Direct login exists only to unblock this manual capability test. Its password is
never stored; it remains in function memory only while the test runs. Any
resulting auth token remains in memory with a one-hour expiry. This flow must not
be copied into Podium's production implementation.
