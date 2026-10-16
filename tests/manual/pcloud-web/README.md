# pCloud normal-web capability probe

Start the local server without activating mise:

```powershell
mise exec -- npm run probe:pcloud-web
```

Then open:

```text
http://127.0.0.1:9876/pcloud-web/probe.html
```

Use a dedicated test account where practical. The password is never stored; it
remains in function memory only while the test runs. Any one-hour auth token
stays in memory only.

pCloud has historically treated localhost differently from deployed web origins.
Therefore a localhost failure confirms a browser restriction, while a localhost
success must be followed by the same test from the real HTTPS Podium origin.

## Result

A web origin can read pCloud file contents, but only through `getzip` with
per-request digest authentication. This was confirmed from a deployed origin,
`https://yatra9.github.io`, not just from localhost. Measured against a 22 MB
PDF: 22250619 archive bytes in 3892 ms (5584 KiB/s), extracted to 22250443 PDF
bytes. The member was stored rather than deflated, so the archive cost 176 bytes
of overhead and no decompression work.

From a deployed origin `getfilelink` fails differently than on localhost: the
call itself is refused with `7010 Invalid link referer` before CORS even comes
into play. The content-host path is closed to web origins twice over.

| Credential | JSON methods | File contents |
| --- | --- | --- |
| OAuth access token | work | **impossible** |
| Per-request digest | work | `getzip` works |

OAuth is the problem, not CORS. `getzip` rejects `access_token` with `1000 Log in
required`, rejects an OAuth token placed in `auth` with `2000 Log in failed`, and
`userinfo?getauth=1` will not exchange an OAuth token for a session token. The
account issues no session token for password login either, which is why
`PCloudDirectAuth` already signs every request with a fresh digest.

So a web app or PWA can support pCloud, but only with Direct Login, holding the
password in memory for the session. OAuth cannot read files at all.

## The download paths

`getfilelink` returns a content host, and those hosts send no
`Access-Control-Allow-Origin`:

| Host | `Server` | `Access-Control-Allow-Origin` |
| --- | --- | --- |
| `api.pcloud.com` | `CloudHTTPd-API` | `*` |
| `c123.pcloud.com` | `CloudHTTPd` | none |
| `edef2.pcloud.com` | `CacheHTTPd` | none |

That is why pCloud support is confined to the browser extension, whose
`host_permissions` bypass CORS. The probe's **getfilelink download** button
reproduces the failure.

The **file_pread download** button tests the descriptor API, which answers from
`api.pcloud.com`. It fails: `file_open` returns `2003 Access denied` even when
called with no credentials at all, while sibling methods return `1000 Log in
required`, so the descriptor API is closed to API clients rather than gated on
permissions.

The **getzip download** button tests the remaining candidate. pCloud pairs a
`getXlink` method that returns a content host with a `getX` method that returns
the bytes from `api.pcloud.com`, and `getzip` is open to API clients. The probe
asks for a single-member archive and extracts it with `DecompressionStream`. If
that path passes from a deployed origin, a plain web app or PWA can read pCloud
files without an extension, and the Android tablet needs no Chrome extension
support.

## Writing

Writing was declared not in question too early. `uploadfile` is served by
`api.pcloud.com`, but Podium's `PCloudSrc.putFileSrc` sends `PUT` with
`Content-Type: application/octet-stream`, which is not a CORS-safelisted value,
so the request is preflighted. `api.pcloud.com` answers `OPTIONS` like this, for
any `Access-Control-Request-Headers`:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS
Access-Control-Max-Age: 86400
```

No `Access-Control-Allow-Headers`, so the `Content-Type` is never allowed and the
current upload cannot work from a web origin. The extension does not notice:
`host_permissions` bypass CORS.

`multipart/form-data` is one of the three safelisted `Content-Type` values, so a
`POST` built from a `FormData` is a simple request and is never preflighted. The
**Test write** button runs both uploads so the comparison is recorded rather
than assumed, then reads the file back with `getzip` and compares every byte: a
write that returns `result 0` is worthless to a score annotator if the
annotations do not survive the trip.

The test works in `/podium-write-probe`, uploads one file of random bytes, and
deletes what it created. The folder is deleted recursively only when the run
created it; if it already existed it is the user's folder and only that run's
uploads are removed.

The probe size is selectable because the default 32 KiB answers the CORS
question but measures nothing: the whole request is round-trip latency. Saving
an annotated score uploads megabytes, so the deployed-origin run should also use
a realistic size.

### Write result

Confirmed from the deployed origin `https://yatra9.github.io`, in the same run
where `getfilelink` was refused with `7010 Invalid link referer`. The preflighted
`PUT` fails with `Failed to fetch` at both sizes, and the `multipart/form-data`
`POST` succeeds at both:

| Probe size | Upload | Round trip |
| --- | --- | --- |
| 32812 bytes | 606 ms (53 KiB/s) | byte-exact |
| 21007404 bytes | 5723 ms (3585 KiB/s) | byte-exact |

The small figure is round-trip latency, not throughput. At a realistic score
size the upload sustains about 3.5 MiB/s, against about 5 MiB/s for the `getzip`
download of a comparable file, so a save costs a few seconds rather than being
impractical.

So a web origin can both read and write pCloud files with per-request digest
authentication. `PCloudSrc.putFileSrc` has to move from `PUT` with
`application/octet-stream` to a `POST` built from a `FormData`. That request is
simple in the extension too, so no platform branch is needed.

Requests pass the token as a query parameter rather than an `Authorization`
header. `api.pcloud.com` omits `Access-Control-Allow-Headers` from its preflight
response, so a request carrying `Authorization` is rejected from a web origin.

## Authentication for the descriptor test

File descriptors belong to an authenticated session, so per-request digest
authentication cannot be used: each call would start a new session and the
descriptor from `file_open` would already be gone. Direct login only helps when
the account still issues a reusable `auth` token.

The JSON methods accept an OAuth token in the `access_token` parameter, but
`getzip` answers `1000 Log in required` for it. The probe therefore tries to
exchange the OAuth token for a session token with `userinfo?getauth=1`, and then
falls back to sending the OAuth token in `auth`. Both are refused, so the OAuth
buttons cannot reach file contents; use Direct login for that.

Do not pass `logout=1` alongside `getauth=1`. It invalidates the token the same
request asks for. Removing it was tried and made no difference here: this account
issues no session token for password login regardless.

Otherwise paste an OAuth access token into the probe. One way to obtain it is to
sign in to pCloud in the extension build and read `pcloud-oauth` from
`chrome.storage.session` in that tab's console. The token is held in memory only
and the input is cleared when it is used.
