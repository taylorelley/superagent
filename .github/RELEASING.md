# Releasing

Releases are automatic. Every push to `main` that passes the Tests workflow is
released by `.github/workflows/release.yml`. Nobody bumps a version by hand.

## Version scheme

Superagent uses CalVer: `YYYY.M.MICRO`.

- `YYYY` — the UTC year of the release.
- `M` — the UTC month, **without** a leading zero (`2026.3.0`, not
  `2026.03.0`). npm requires `package.json` versions to be valid semver, and
  semver forbids leading zeros.
- `MICRO` — starts at `0` each month and goes up by one per release.

So November 2026's releases are `2026.11.0`, `2026.11.1`, …, and December
starts again at `2026.12.0`. The tag is the version with a `v` prefix
(`v2026.11.0`). Every CalVer version sorts above the old `0.x` line, so the
plugin's update check (`.opencode/lib/update-check.js`) needs no special case.

`scripts/next-version.sh` picks the number: one more than the highest of this
month's `vYYYY.M.*` tags and `package.json`'s own version. Set
`RELEASE_DATE=YYYY-MM` to try it against another month.

## What a release does

1. Waits for the Tests workflow to succeed on a push to `main`.
2. Stands down if `main` has moved past the tested commit — the newer push
   gets its own release, which includes this one.
3. Runs `scripts/bump-version.sh <version>` and `npm version` (for
   `package-lock.json`), and commits `Release v<version> [skip ci]` to `main`.
4. Tags that commit `v<version>` and pushes the commit and tag atomically.
5. Publishes a GitHub Release with notes generated from the merged PRs.

Releases run one at a time, so two merges never claim the same number.

## Skipping a release

Put `[skip release]` in the merge commit message (for a squash merge, the
commit title or body). The change ships with the next release.

## Protected `main`

The default `GITHUB_TOKEN` cannot push to a branch that requires pull
requests or status checks. If `main` is protected, create a `RELEASE_TOKEN`
repository secret — a fine-grained personal access token or GitHub App token
with **Contents: read and write** on this repository that is allowed to bypass
the protection — and the workflow uses it instead. The `[skip ci]` in the bump
commit keeps a token-authored push from starting another Tests run, and so
another release.
