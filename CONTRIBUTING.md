# Contributing

Bug reports, feature requests and pull requests are welcome at
<https://github.com/dirkwa/signalk-backup-server>.

Before opening a pull request, run the full local chain:

```bash
npm run format && npm run build:all
```

## Keeping your branch up to date

Rebase onto `main` rather than merging `main` into your branch. With
`upstream` pointing at this repository
(`git remote add upstream https://github.com/dirkwa/signalk-backup-server.git`):

```bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease --force-if-includes
```

A rebased branch shows reviewers only your changes, and every commit stays a
conventional commit; a merge of `main` adds neither. `--force-with-lease
--force-if-includes` refuses to overwrite commits on your branch that you
have not seen, even if a background fetch has updated your remote-tracking
branch in the meantime (Git 2.30 or later). If a
rebase gets stuck on conflicts, say so in the pull request and we will
rebase it for you.

## Contributor license grant

By submitting a pull request or patch, you grant Dirk Wahrheit a perpetual,
worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce,
modify, publish, sublicense and distribute your contribution, and to relicense
it under any terms, including as part of signalk-backup-server releases. You confirm
that you have the right to grant this.
