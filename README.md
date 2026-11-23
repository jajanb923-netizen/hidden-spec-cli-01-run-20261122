# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jajanb923-netizen/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jajanb923-netizen/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format, built for the
[make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
it applies edits written as a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, or text-editor tool calls as JSON, to a
tree of text files — finding the lines each edit names even when the model
drifted their whitespace or indentation, and changing every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory; when absent
  or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library alone; nothing is installed.

## Behaviour

Edits are found at the first of three matching tiers: exact lines, lines
equal once trailing spaces and tabs are removed, then lines equal once
leading and trailing spaces and tabs are removed. Unified hunks take the
occurrence nearest the hunk's line number; SEARCH/REPLACE blocks fail as
ambiguous when their old lines occur more than once; V4A chunks walk a
cursor with anchors and end-of-file anchoring. A failed edit changes
nothing and the edits after it still run; when any edit failed, no file is
written (exit 1). On success the tool prints one line per changed path
(`A`, `D`, `M`, or `R old -> new` for a move) and `ok: <n> files`.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (kept as shipped).
- `check.ts` — runs the kit's 100 public practice checks on `main.ts`.
- `SPEC.md` — the specification the CLI implements.

## Practice

    node check.ts <kit>/program/generator/practice.json

100 of 100 practice checks pass (practice score 1000).
