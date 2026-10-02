import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
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

/**
 * Indexes existing tracked and unignored JS/TS files in a local Git checkout.
 * `dependencyRoot` is a checkout with installed packages, used when `directory` is a fresh worktree.
 * Unresolvable tsconfig files fall back to default options and are listed in `configErrors`.
 */
export async function indexRepository(directory: string, options: { dependencyRoot?: string } = {}) {
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
  const repositoryFiles = [...new Set(stdout.split("\0"))];
  const workspacePackages = new Map<string, string>();
  for (const file of repositoryFiles) {
    if (!file.endsWith("/package.json") || file.includes("node_modules/")) continue;
    try {
      const manifest: unknown = JSON.parse(await readFile(join(root, file), "utf8"));
      if (
        manifest &&
        typeof manifest === "object" &&
        "name" in manifest &&
        typeof manifest.name === "string"
      ) {
        workspacePackages.set(manifest.name, dirname(join(root, file)));
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
  }
  const dependencyRoot = options.dependencyRoot && resolve(options.dependencyRoot);
  const configPath = (path: string) => {
    if (ts.sys.fileExists(path)) return path;
    if (dependencyRoot && path.startsWith(`${root}/`) && path.includes("/node_modules/")) {
      const installed = join(dependencyRoot, path.slice(root.length + 1));
      if (ts.sys.fileExists(installed)) return installed;
    }
    for (const [name, directory] of workspacePackages) {
      const marker = `/node_modules/${name}/`;
      const offset = path.lastIndexOf(marker);
      if (offset !== -1) return join(directory, path.slice(offset + marker.length));
    }
    return path;
  };
  const configHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: (path) => ts.sys.fileExists(configPath(path)),
    readFile: (path) => ts.sys.readFile(configPath(path)),
  };
  const candidates = repositoryFiles.filter(isIndexablePath).sort();
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
  const configErrors: Array<{ config: string; message: string }> = [];
  for (const [config, files] of groups) {
    let options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.Latest,
      jsx: ts.JsxEmit.Preserve,
    };
    if (config) {
      const read = ts.readConfigFile(config, configHost.readFile);
      const parsed = read.error
        ? undefined
        : ts.parseJsonConfigFileContent(read.config, configHost, dirname(config));
      const errors = read.error
        ? [read.error]
        : parsed!.errors.filter((error) => error.code !== 18003);
      if (errors.length)
        configErrors.push({
          config: config.slice(root.length + 1),
          message: errors
            .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
            .join("\n"),
        });
      else options = { ...options, ...parsed!.options };
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
  return { version: 1, ...result, configErrors };
}
