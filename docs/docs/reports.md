---
sidebar_position: 7
title: Creating violation reports
displayed_sidebar: tutorialSidebar
---

`Sheriff` can generate violation reports in various formats, which is useful for integrating with CI/CD pipelines or for manual review. Reports can be generated in JSON and JUnit format.

Reports are generated when `sheriff verify` is executed with the `--format` flag.

## Defining the reporters

Pass `--format` with a comma-separated list of formats to `sheriff verify`:

```bash
npx sheriff verify src/main.ts --format json
npx sheriff verify src/main.ts --format json,junit
```

Supported formats are `json` and `junit`.

## Custom directory where reports are written to

By default reports are written to the `reports` directory relative to the current working directory. Override it with `--output`:

```bash
npx sheriff verify src/main.ts --format junit --output build/sheriff
```

The report files are named `violations.json` / `violations.xml`. When multiple entry points are configured, each project's report is written to a sub-directory named after the entry point.

## What the reports contain

Reports include all three violation categories: encapsulation violations, dependency-rule violations and external-rule violations. The JUnit report emits one `<testcase>` per violation with `name="encapsulation"`, `name="dependency-rule"` or `name="external-rule"`.

## Regenerating reports on file changes (watch mode)

Combine `--watch` with `--format`/`--output` to keep the reports in sync while you work:

```bash
npx sheriff verify src/main.ts --watch --format junit --output reports
```

Sheriff watches the project, re-runs the verification on every relevant change (re-analyzing only the affected files via its cache) and rewrites the report files in place. Each rewritten report is a complete, valid report reflecting the latest verification result.
