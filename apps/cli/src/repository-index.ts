import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
 * `focus` (repository-relative paths) limits the index to those files, the files whose import
 * specifiers name them, and the files they import: what one-hop review context needs, without
 * type-checking the rest of a large repository.
 * Unresolvable tsconfig files fall back to default options and are listed in `configErrors`.
 */
/**
 * The focus files plus files whose import specifiers end in a focus file's name, a cheap text
 * superset of their importers. What the focus files import is added from the compiled program.
 */
async function focusFiles(root: string, repositoryFiles: string[], focus: string[]) {
  const files = new Set(focus.filter((file) => isIndexablePath(file) && repositoryFiles.includes(file)));
  const names = new Set(
    [...files].map((file) => {
      const name = basename(file).replace(/\.[^.]+$/, "");
      return name === "index" ? basename(dirname(file)) : name;
    }),
  );
  const patterns = [...names].flatMap((name) =>
    ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].flatMap((extension) => [`/${name}${extension}"`, `/${name}${extension}'`]),
  );
  if (patterns.length) {
    const { stdout } = await exec("git", ["-C", root, "grep", "-l", "-F", ...patterns.flatMap((pattern) => ["-e", pattern]), "--"], {
      maxBuffer: 50 * 1024 * 1024,
    }).catch((error: { code?: number; stdout?: string }) => {
      // git grep exits 1 when nothing matches.
      if (error.code === 1) return { stdout: "" };
      throw error;
    });
    for (const file of stdout.split("\n")) if (file) files.add(file);
  }
  return [...files];
}

export async function indexRepository(
  directory: string,
  options: { dependencyRoot?: string; focus?: string[] } = {},
) {
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
  const candidates = (options.focus ? await focusFiles(root, repositoryFiles, options.focus) : repositoryFiles)
    .filter(isIndexablePath)
    .sort();
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
  // Files already indexed by an earlier tsconfig group, so a shared dependency is not indexed twice.
  const indexed = new Set<string>();
  const focus = options.focus && new Set(options.focus.map((file) => join(root, file)));
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
    const own = new Set(files.filter((file) => !indexed.has(file)));
    if (focus) {
      // Add the repository files a focus file imports, as the compiler resolved them.
      const checker = program.getTypeChecker();
      for (const file of files) {
        if (!focus.has(file)) continue;
        for (const statement of program.getSourceFile(file)?.statements ?? []) {
          const specifier =
            ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
          const target = specifier && checker.getSymbolAtLocation(specifier)?.declarations?.[0]?.getSourceFile().fileName;
          if (target?.startsWith(`${root}/`) && isIndexablePath(target.slice(root.length + 1)) && !indexed.has(target)) own.add(target);
        }
      }
    }
    for (const file of own) indexed.add(file);
    const indexedProgram = indexProgram(program, root, own);
    const ownFiles = new Set(
      [...own].map((file) => file.slice(root.length + 1).replaceAll("\\", "/")),
    );
    // Appended one by one: spreading a large repository's symbols into push() overflows the call stack.
    for (const file of indexedProgram.files) if (ownFiles.has(file)) result.files.push(file);
    for (const symbol of indexedProgram.symbols) if (ownFiles.has(symbol.file)) result.symbols.push(symbol);
    for (const entry of indexedProgram.imports) if (ownFiles.has(entry.file)) result.imports.push(entry);
    for (const entry of indexedProgram.calls) if (ownFiles.has(entry.file)) result.calls.push(entry);
    for (const entry of indexedProgram.diagnostics) if (ownFiles.has(entry.file)) result.diagnostics.push(entry);
  }
  const ids = new Set(result.symbols.map((symbol) => symbol.id));
  for (const call of result.calls) if (call.target && !ids.has(call.target)) delete call.target;
  result.files.sort();
  return { version: 1, ...result, configErrors };
}
