# Repository instructions

## Before changing files

- Read this file and inspect the affected files and their encoding.
- On Windows, use PowerShell 7+ (`pwsh`) only.
- Set console output and input to UTF-8 without BOM before reading or writing text.
- Use `apply_patch` or an editor that guarantees UTF-8 without BOM.
- Do not use `Out-File`, shell redirection (`>`, `>>`), bulk regex overwrites, or tools with ambiguous encoding.
- Do not translate, normalize, or rewrite user-generated data, stored data, or imported content.

## Encoding policy

- Repository text is UTF-8 without BOM.
- Text must be NFC-normalized and must not contain U+FFFD.
- English is the canonical locale.
- Vietnamese translations are additive only; they may not remove English keys.
- Locale ICU placeholders must remain identical between locales.
- JSON files must parse successfully.
- Any UTF-8, NFC, BOM, JSON, ICU, or locale-parity failure is a stop condition. Report the exact file and error and do not continue editing.

## Hosting platforms stay unnamed

This repository is public, and it names no hosting platform it runs on or is
tested on. That covers anything that identifies one:

- product, vendor or service names, and the names of the sandbox or runtime
  underneath them;
- domains and hostnames, including their patterns and prefixes, and project
  numbers, regions, revision names or any other value copied from a real
  environment or its logs.

It applies everywhere that is committed or published: code, comments, tests
and fixtures, log and error messages, locale text, committed docs, commit
messages, branch names, pull request titles and descriptions, and review or
issue comments.

- Describe a host by what it does, not who runs it: "a container host that
  keeps its files in memory", "a platform's preview frame".
- Detect a host by generic signals: an open standard's variable, the mount
  table, an explicit `STM_*` override. Name the standard, never a vendor.
- In tests and examples use reserved names only: `*.example`,
  `*.hosted.example`, `*.example.invalid`, `123456789012`.
- Platform-specific notes belong in the gitignored `docs/` directory, never in
  a tracked file.
- Before every commit and pull request, read the diff, the message and the
  description for anything above, and remove it before continuing.

## Batch protocol

Work in small dependency-ordered batches. Before each batch, inspect the affected scope. After each batch:

1. Keep the change minimal.
2. Run the relevant tests, lint, and typecheck.
3. Run the UTF-8/BOM/NFC/JSON/locale/ICU gate.
4. Run `git diff --check`.
5. Report the result and any limitations.
6. Commit only after the batch passes and the user has reviewed it.
7. Stop before starting the next batch.

Never commit a failed batch or continue past an encoding gate failure.
