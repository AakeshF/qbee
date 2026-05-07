# Runbook — Ship a release

## Pre-release checklist

- [ ] All targeted phase tasks complete and verified
- [ ] Smoke test: chat against all three backends works
- [ ] Smoke test: open a real workspace, index it, query `@codebase`
- [ ] Version bumped in `package.json` (root) and `editor/package.json`
- [ ] CHANGELOG entry added
- [ ] No console errors in production build
- [ ] AppImage builds locally: `pnpm -w build && cd editor && yarn release:linux`

## Tagging

```sh
cd ~/projects/qbee
git tag -s v0.X.Y -m "v0.X.Y"   # signed tag
git push origin v0.X.Y
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`.

## CI release flow (what happens automatically)

1. Checkout, init editor submodule
2. `pnpm install`, `cd editor && yarn`
3. Build SPA, vendor into editor
4. `editor && yarn release:linux` for x64 and arm64
5. Sign AppImages with the GPG key from secrets
6. Upload to GitHub release page (auto-created from tag)

## After release

- [ ] Verify the release page has both AppImages + `.sig` files + checksums
- [ ] Download one, run on a clean machine, verify it launches and updates from the previous version
- [ ] Announce in README / Discord / etc.

## Hotfix flow

1. Branch `hotfix/v0.X.Y+1` from the release tag
2. Cherry-pick fixes
3. Tag `v0.X.Y+1`, push
4. Merge `hotfix/*` back into `main`
