Automated export of console-authored catalog content. See
[`.github/workflows/content-snapshot.yml`](.github/workflows/content-snapshot.yml)
for why it exists.

**This is a backup, not a publish.** The content is already live to athletes,
served from the database the moment it was saved in the console. What this
decides is whether a *fresh* environment would have it, and whether it survives
losing the database. Merging changes nothing an athlete sees.

**CI does not run on this PR.** A pull request opened with the default
`GITHUB_TOKEN` deliberately does not trigger other workflows. The snapshot job
therefore validates its own output before opening this — it runs the same seed
validation (`SeedData()` over the written files) that a deploy would, and
refuses to open the PR if the export cannot seed. The green tick you are used to
will not appear here; the check already happened upstream.

Force-updated on every run that finds changes, so this stays one PR rather than
becoming one a day.

After it merges **and deploys**, run:

```bash
cd backend && go run ./cmd/exportcontent -adopt
```

That hands the exported rows back to the deploy (`source` returns to `seed`), so
the seeder owns them again. Doing it before the deploy is the one ordering that
breaks: it would give the deploy rows whose content it does not yet carry, and
the next release would re-seed the old text over them.
