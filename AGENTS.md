# Repository development instructions

## Toolchain

- This repository uses `mise` to install and run development tools.
- Do not run `mise activate` or depend on shell activation.
- Always run toolchain commands through `mise exec --`, for example:
  - `mise exec -- python build.py --podium`
  - `mise exec -- npm test`
  - `mise exec -- npx playwright test`
- Run `mise install` after changing `.mise.toml`.
- Install Python development dependencies with
  `mise exec -- python -m pip install -r requirements-dev.txt`.
- Install JavaScript dependencies with `mise exec -- npm install`.
- Keep tool versions declared in `.mise.toml` and JavaScript dependencies locked in
  `package-lock.json`.

## Tests

- Browser tests use Playwright and must not contact real cloud-storage APIs.
- Mock all cloud API requests in automated tests. A test must fail on unexpected
  external network access.
- Never commit OAuth access tokens, account credentials, or other secrets.
- Real-provider OAuth and API checks use a dedicated test account and the manual
  release checklist.
