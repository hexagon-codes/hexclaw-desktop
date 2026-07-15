# Local private/large PDF fixtures

This directory keeps the **contract**, not the copyrighted or private payload.
The canonical textbook PDF is intentionally never copied into the repository.

## One-off verification with an explicit path

```sh
HEX_FIXTURE_TEXTBOOK_PDF='/absolute/path/to/textbook.pdf' \
  node tests/fixtures/local/verify-fixture.mjs \
  --manifest tests/fixtures/local/manifest.example.json
```

The command succeeds only after the PDF signature, SHA256, exact byte count,
and page count all match. It uses `pdfinfo` when available and falls back to
the native macOS `mdls` metadata command. Missing tools or metadata fail closed.

## Reusable machine-local manifest

Copy `manifest.example.json` to the ignored `manifest.json`, then replace only
the fixture `path` with the local absolute path. Run:

```sh
node tests/fixtures/local/verify-fixture.mjs
```

`manifest.json`, `files/`, and PDF payloads are ignored locally. Keep hashes and
other evidence in the tracked example only after independently recomputing them;
never commit a user home path or the source PDF.

## Contract regression

```sh
node --test tests/fixtures/local/contract.test.mjs
```
