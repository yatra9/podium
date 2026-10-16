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
