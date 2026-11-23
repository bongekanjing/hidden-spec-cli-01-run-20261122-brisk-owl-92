# mend

One command-line tool that reads the four edit formats AI coding agents write — unified
diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor
calls — and applies them to a tree of files, all or nothing.

Built for make.fun's `hidden-spec-cli-01-run-20261122`: `SPEC.md` is the whole
specification, and this implementation follows it sentence by sentence.

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bongekanjing/hidden-spec-cli-01-run-20261122-brisk-owl-92/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bongekanjing/hidden-spec-cli-01-run-20261122-brisk-owl-92/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Bounty page: <https://make.fun/bounty/hidden-spec-cli-01-run-20261122>

## What it does

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- **Format detection** (`auto`): V4A marker, then a leading `[`/`{` for JSON, then a
  `<<<<<<< SEARCH` line, then `diff --git` or a `---`/`+++` pair.
- **Three matching tiers**: exact, trailing whitespace ignored, then indentation ignored.
  At tier 2 the replacement is re-indented onto the file's own indentation, so a patch
  whose indentation drifted still lands correctly.
- **Unified diffs**: sections by `diff --git` or `---`/`+++`, `rename from`/`to`,
  `new file mode`/`deleted file mode`, `/dev/null`, `a/`/`b/` stripping, `\` no-newline
  markers, and hunks placed at the occurrence nearest their stated line number with the
  running offset carried across hunks.
- **SEARCH/REPLACE**: blocks applied in order, the path inherited from the previous block
  when a block names none, ambiguity reported rather than guessed.
- **V4A**: add, delete, update, `*** Move to:`, anchored chunks with a forward-only cursor,
  and `*** End of File` chunks that must end at the last line.
- **JSON**: array or JSON Lines, `create`/`str_replace`/`insert`, CRLF files read and
  written back as CRLF.
- **Atomic**: every edit is tried and every failure reported; if any failed, no file is
  written. `--check` reports the same thing and writes nothing. Moves print as
  `R <old> -> <new>` and sort by the new path.

## The practice set

`check.ts` runs the 100 public practice checks against `main.ts`:

```
node check.ts practice.json
```

All 100 pass. `runner.ts` is the kit's trial runner, unchanged: it is how the graded
instance runs this file inside the sandbox.

## Layout

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's runner (kept as it is).
- `check.ts` — the practice checker.
- `SPEC.md` — the specification this implements.

## License

MIT — see `LICENSE`.
