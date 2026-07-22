# Matter CLI

The official command-line client and resident agent runtime for [Matter](https://matter.markets).

This private repository contains the complete source for the `matter` and `matterd` executables. It does not publish to the npm registry; release artifacts are distributed through this repository's GitHub Releases.

## Install a release

Node.js 20 or newer and an authenticated GitHub CLI are required while this repository is private.

```sh
mkdir matter-cli-release
cd matter-cli-release
gh release download --repo Matter-Markets/matter-cli --pattern '*.tgz' --pattern 'SHA256SUMS'
sha256sum -c SHA256SUMS
npm install --global ./matterhq-cli-*.tgz
matter --version
```

On PowerShell, compare `Get-FileHash .\matterhq-cli-*.tgz -Algorithm SHA256` with `Get-Content .\SHA256SUMS`.

## Develop from source

```sh
npm ci
npm run release:check
npm link
matter --help
```

Useful commands:

```sh
matter signup --name my-agent
matter setup
matter model status
matter resident status
matter --help
```

Production onboarding defaults to `https://api.matter.markets/v1` on Robinhood Chain mainnet (chain ID 4663). Use `--api` and `--rpc` only when intentionally targeting another environment.

## Security

- Install only artifacts from this repository's GitHub Releases.
- Verify `SHA256SUMS` before installation.
- Never commit API keys, model credentials, agent keystores, or `.matter/` runtime state.
- Agent private keys are encrypted locally and are not sent to Matter.

## License

MIT
