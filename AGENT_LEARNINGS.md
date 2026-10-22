# Agent Learnings

External memory for coding agents working on this repository.

Read this file before you plan or edit. Append one line when you get something wrong.
It is plain Markdown on purpose: it diffs, reviews and commits like code.

## Rules for this file

- **Read it first.** Load this file before planning or editing. Every entry is a
  standing instruction for this repository.
- **Write on mistakes, not on success.** Add an entry when a tool call failed, an
  assumption turned out to be wrong, the user corrected you, or an approach was
  replaced by one that worked.
- **One rule per line.** Write the rule, not the story of how it happened.
- **Be concrete.** Name the file, command, flag or path the rule is about.
- **No secrets.** Never record API keys, tokens, credentials or personal data.
- **Append, do not rewrite.** Add new lines at the end. Remove a line only when the
  rule no longer applies.

## Format

```
- [category] (YYYY-MM-DD) Rule a future agent should follow.
```

Categories:

| Category    | Meaning                                            |
|-------------|----------------------------------------------------|
| `mistake`   | Something done wrong that must not be repeated.    |
| `pitfall`   | A trap in this codebase that surprises people.     |
| `approach`  | A technique that worked — reuse it.                |

## Lessons

- [pitfall] (2026-10-22) The test files import from `dist/`, not `src/` — run `npm run build` before `node --test tests/<file>.test.mjs`, otherwise you are testing the previous build.
- [pitfall] (2026-10-22) On Windows the `bash` tool is Git Bash/MSYS, never cmd.exe — use POSIX syntax and `/dev/null`; `>nul` creates a literal file named `nul`.
- [approach] (2026-10-22) `npm run lint` (oxlint) is much faster than `npm run typecheck` — use it to catch syntax errors before paying for the full strict TypeScript pass.
