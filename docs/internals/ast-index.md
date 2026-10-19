# AST index

`pnpm pr index [repository-path] --output /tmp/auto-review-index.json` indexes a local Git working tree. Without `--output`, the CLI writes JSON to stdout. The repository defaults to the AutoReview workspace. Relative repository and output paths resolve from the workspace root, matching the snapshot command. Absolute paths can target another checkout.

The command reads tracked and unignored files, including local edits and new files. Deleted files, symbolic links, declaration files, and directories named `node_modules`, `dist`, `build`, `coverage`, or `vendor` are skipped. It does not check out a PR or fetch GitHub data. It covers TypeScript and JavaScript, including JSX, TSX, and CommonJS/ES module filename variants.

`apps/cli/src/ast.ts` exposes `walkAst` for source-order traversal with optional subtree pruning and `indexProgram` for extracting review context. The implementation uses the TypeScript compiler API already used by the project. `repository-index.ts` handles Git and filesystem access. Files use the nearest `tsconfig.json` or `jsconfig.json` within the repository for compiler options, including import aliases. Git selects files even when the config excludes them, so tests and configuration code remain available to a reviewer.

The version 1 JSON contains:

- `files`: repository-relative source paths.
- `symbols`: functions, anonymous callbacks, classes, methods, accessors, variables, properties, interfaces, aliases, and enums. Each has an ID, name, syntax kind, source range, and optional enclosing declaration ID.
- `imports`: static imports and re-exports, with a target file when it belongs to the index.
- `calls`: calls and constructor expressions, with the enclosing function and target declaration when the compiler can resolve it. Top-level calls have no caller.
- `diagnostics`: syntax errors with file and line. Malformed files retain the compiler's recovered syntax tree.

Paths use forward slashes. Lines are one-based and inclusive. Offsets are zero-based UTF-16 positions with an exclusive end, matching TypeScript and JavaScript string slicing. IDs combine path and start offset. They are stable for an unchanged checkout, but should not be reused after edits. Rebuild the index for each review.

A caller or callee query can filter `calls` by `target` or `caller` and look up IDs in `symbols`. `parent` links connect nested functions and declarations. Calls inside an arrow function belong to the arrow, whose parent may be its variable declaration.

This is static context, not a complete runtime call graph. External or unresolved calls retain their expression and source location without a target. Dynamic dispatch, callback invocation, JSX rendering, CommonJS require dependencies, dynamic imports, inheritance, and general read/write references are not modeled as edges. Semantic type errors are not reported. The index is independent of the PR snapshot. The [local reviewer](reviewer.md) uses it to select source context for Codex. The separate [offline detector scope inventory](detector-scopes.md) experiments with bounded primary regions and same-file lexical references; it is not used by the production reviewer.
