# Rulesets

Reusable GitHub ruleset definitions. Apply to any repo with:

```sh
# Create new ruleset
gh api -X POST repos/OWNER/REPO/rulesets --input .github/rulesets/protect-main.json

# Update existing ruleset (needs ruleset id)
gh api -X PUT repos/OWNER/REPO/rulesets/RULESET_ID --input .github/rulesets/protect-main.json
```

## Files

| File | Target | Purpose |
|---|---|---|
| `protect-main.json` | default branch | Block delete/force-push/creation, require PR (conversation resolution), require `build` + `actionlint` status checks (strict) |
| `protect-release-tags.json` | `refs/tags/v*` | Block delete / update / non-fast-forward on release tags. Tag creation allowed so release workflow can publish. |

## Notes

- `protect-main.json` requires status checks named `build` and `actionlint`. Rename in the file if your workflow job names differ.
- No `required_signatures` — keeps CLI commits from CI (e.g. tag creation) working. Remove this caveat once your release flow signs commits.
- No `bypass_actors` — nothing can skip these rules, including the repo owner.
