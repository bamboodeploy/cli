# @bamboodeploy/cli

Scan and code-sign Windows binaries (`.exe`, `.msi`) from any build pipeline. One command, no certificate, no HSM, no Windows VM.

```bash
npx github:bamboodeploy/cli sign dist/myapp.exe
```

Upload, sign with a trusted certificate, download the signed file in place. Works on Windows, macOS, and Linux runners.

Install globally to get the `bamboo` command: `npm install -g github:bamboodeploy/cli`. In Windows PowerShell with scripts blocked, use `npx.cmd` and `npm.cmd`.

## Setup

1. Create an API key in the [Bamboo Deploy dashboard](https://www.bamboodeploy.com/dashboard/) under **API Keys**.
2. Export it as `BAMBOO_API_KEY` (or put `BAMBOO_API_KEY=bd_live_...` in a `.bamboorc` in your project or home dir).
3. After your first reviewed build, ask Bamboo to enable **Auto-sign** on your account so clean builds sign in about two minutes instead of waiting for manual review.

Signing needs a Premium subscription ($45 per quarter). Scanning is free.

## Commands

```bash
bamboo sign <file> [--out path] [--timeout 900]   # sign, replace in place by default
bamboo scan <file> [--json] [--fail-on-findings]  # free: scan report + SmartScreen readiness
bamboo status [app-id]                            # list uploads, or one app's scan + sign state
bamboo delete <app-id>
bamboo config                                     # show which key and API base are in use
```

Exit codes: `0` ok, `1` error, `2` Premium required, `3` publisher verification required, `4` timeout or waiting for review, `5` scan findings (with `--fail-on-findings`).

## In a build script

```json
{
  "scripts": {
    "dist": "electron-builder --win && bamboo sign dist/MyApp-Setup.exe"
  }
}
```

For electron-builder there is a hook package that signs every Windows artifact automatically: [`electron-builder-bamboo-sign`](https://github.com/bamboodeploy/electron-builder-bamboo-sign).

## Programmatic use

```js
const { signFile, scanFile } = require('@bamboodeploy/cli');
await signFile('dist/app.exe', { out: 'dist/app-signed.exe', log: console.error });
const { report, summary } = await scanFile('dist/app.exe');
```

## CI

- GitHub Actions: [`bamboodeploy/sign-action@v2`](https://github.com/bamboodeploy/sign-action)
- GitLab, Azure Pipelines, CircleCI, Jenkins, AppVeyor: [docs](https://www.bamboodeploy.com/docs/#ci)

## License

MIT
