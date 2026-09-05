import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { indexProgram } from "./ast.js";

const exec = promisify(execFile);

export function isIndexablePath(file: string) {
  return (
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) &&
    !/(?:^|\/)(?:node_modules|dist|build|coverage|vendor)\//.test(file) &&
    !/\.d\.[cm]?ts$/.test(file)
  );
}

/** Indexes existing tracked and unignored JS/TS files in a local Git checkout. */
export async function indexRepository(directory: string) {
  const { stdout: gitRoot } = await exec("git", [
    "-C",
    resolve(directory),
    "rev-parse",
    "--show-toplevel",
  ]);
  const root = gitRoot.trim();
  const { stdout } = await exec(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  const candidates = [...new Set(stdout.split("\0"))].filter(isIndexablePath).sort();
  const paths = new Set<string>();
  for (const file of candidates) {
    const path = join(root, file);
    try {
      if ((await lstat(path)).isFile()) paths.add(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    let directory = dirname(path);
    let config = "";
    while (true) {
      config =
        ["tsconfig.json", "jsconfig.json"]
          .map((name) => join(directory, name))
          .find(ts.sys.fileExists) ?? "";
      if (config || directory === root) break;
      directory = dirname(directory);
    }
    const files = groups.get(config) ?? [];
    files.push(path);
    groups.set(config, files);
  }
  const result: ReturnType<typeof indexProgram> = {
    files: [],
    symbols: [],
    imports: [],
    calls: [],
    diagnostics: [],
  };
  for (const [config, files] of groups) {
    let options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.Latest,
      jsx: ts.JsxEmit.Preserve,
    };
    if (config) {
      const read = ts.readConfigFile(config, ts.sys.readFile);
      if (read.error)
        throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config));
      const errors = parsed.errors.filter((error) => error.code !== 18003);
      if (errors.length)
        throw new Error(
          errors
            .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
            .join("\n"),
        );
      options = { ...options, ...parsed.options };
    }
    const program = ts.createProgram(files, { ...options, allowJs: true, noEmit: true });
    const indexed = indexProgram(program, root, paths);
    const ownFiles = new Set(
      files.map((file) => file.slice(root.length + 1).replaceAll("\\", "/")),
    );
    result.files.push(...indexed.files.filter((file) => ownFiles.has(file)));
    result.symbols.push(...indexed.symbols.filter((symbol) => ownFiles.has(symbol.file)));
    result.imports.push(...indexed.imports.filter((entry) => ownFiles.has(entry.file)));
    result.calls.push(...indexed.calls.filter((entry) => ownFiles.has(entry.file)));
    result.diagnostics.push(...indexed.diagnostics.filter((entry) => ownFiles.has(entry.file)));
  }
  const ids = new Set(result.symbols.map((symbol) => symbol.id));
  for (const call of result.calls) if (call.target && !ids.has(call.target)) delete call.target;
  result.files.sort();
  return { version: 1, ...result };
}
