# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Agbercoder/mend-fast/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Agbercoder/mend-fast/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` reads a patch in one of four
formats — unified diff, SEARCH/REPLACE blocks, V4A patches, or JSON tool
calls — finds the lines each edit names at the first of three matching tiers,
and writes every change or none, printing what it changed or why it failed.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a file, or `-` / omitted for stdin. `--format` is one of
`auto` (the default), `unified`, `search-replace`, `v4a`, `json`.
`--check` reports what would change without writing anything.
`--strict` matches lines exactly, at tier 0 only.

Exit 0 lists the changed files (`A`, `D`, `M`, or `R old -> new`) and ends
with `ok: N files`. Exit 1 reports each failed edit and ends with
`failed: K of N edits`, and nothing is written. Exit 2 is a usage, missing
patch, format, or parse error, one line.

## Matching

An edit's old lines are found at the first tier with an occurrence:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed, with the new lines re-indented to the file's indentation.

Unified hunks take the occurrence nearest the hunk's line number;
SEARCH/REPLACE blocks require exactly one occurrence; V4A chunks take the
first occurrence at or after the cursor, or the one ending at the last line
for an end-of-file chunk.

## Requirements

Node 22 and its standard library only — nothing installed, no network,
deterministic.
