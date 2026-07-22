# Matter CLI

Official private distribution channel for the Matter CLI.

- Product: https://matter.markets
- Source: https://github.com/Matter-Markets/matter
- Distribution: GitHub Releases in this repository
- npm registry: not used

## Install the latest release

Node.js 20 or newer and an authenticated GitHub CLI are required while this repository is private.

```sh
mkdir matter-cli-release
cd matter-cli-release
gh release download --repo Matter-Markets/matter-cli --pattern '*.tgz' --pattern 'SHA256SUMS'
sha256sum -c SHA256SUMS
npm install --global ./matterhq-cli-*.tgz
matter --version
```

PowerShell integrity check:

```powershell
Get-FileHash .\matterhq-cli-*.tgz -Algorithm SHA256
Get-Content .\SHA256SUMS
```

The release archive is npm-compatible for local installation, but it is downloaded from GitHub and is never published to the npm registry.

## Release contents

Each versioned release contains:

- `matterhq-cli-<version>.tgz`
- `SHA256SUMS`

The package provides the `matter`, `matterd`, and `matter-harness` executables.

## Security

Do not download Matter artifacts from mirrors or third-party package registries. Verify the checksum from the same GitHub Release before installation.
