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
