import ts from "typescript";
import { walkAst } from "../ast.js";
import type { Change } from "./context.js";

/** Offline head-only inventory. Not a detector payload: base evidence and patch slicing are absent. */
export function planDetectorScopes(
  changes: Change[],
  sources: ReadonlyMap<string, string>,
  options: { primaryCharacters?: number; payloadCharacters?: number; maxParts?: number } = {},
) {
  const primaryLimit = options.primaryCharacters ?? 12_000;
  const payloadLimit = options.payloadCharacters ?? 40_000;
  const maxParts = options.maxParts ?? 4;
  if (![primaryLimit, payloadLimit, maxParts].every((value) => Number.isInteger(value) && value > 0))
    throw new Error("Scope budgets must be positive integers.");
  const size = (value: unknown) => JSON.stringify(value).length;
  const files = changes.map((change) => {
    const text = sources.get(change.file);
    if (text === undefined)
      return { file: change.file, scopes: [], unowned: change.reviewLines, unavailable: true, diagnostics: [] as string[] };
    // A same-file checker gives lexical identity without loading dependencies or executing repository code.
    const filename = `/scope/${change.file}`;
    const settings = { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve };
    const host = ts.createCompilerHost(settings);
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    host.getSourceFile = (path) => path === filename ? source : undefined;
    host.fileExists = (path) => path === filename;
    host.readFile = (path) => path === filename ? text : undefined;
    const program = ts.createProgram([filename], settings, host);
    const checker = program.getTypeChecker();
    const range = (start: number, end: number) => ({
      start, end,
      startLine: source.getLineAndCharacterOfPosition(start).line + 1,
      endLine: source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1,
      text: text.slice(start, end),
    });
    type Range = ReturnType<typeof range>;
    const units: Array<{ ranges: Range[]; enclosing?: Range; label: string }> = [];
    const bodyOf = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node)) return node.body;
      if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return;
      const initializer = node.declarationList.declarations[0]?.initializer;
      const callable = initializer && ts.isCallExpression(initializer)
        ? initializer.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
        : initializer;
      if (callable && (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) && ts.isBlock(callable.body))
        return callable.body;
    };
    const partition = (node: ts.Statement, enclosing?: Range) => {
      const own = range(node.getStart(source), node.getEnd());
      const body = bodyOf(node);
      if (size(own) <= primaryLimit || !body?.statements.length) {
        units.push({ ranges: [own], enclosing, label: ts.SyntaxKind[node.kind] });
        return;
      }
      // Preserve wrapper/dependency-array text separately, with explicit holes for its body statements.
      const residual: Range[] = [];
      let cursor = own.start;
      for (const statement of body.statements) {
        const start = statement.getStart(source);
        if (start > cursor) residual.push(range(cursor, start));
        partition(statement, own);
        cursor = statement.getEnd();
      }
      if (cursor < own.end) residual.push(range(cursor, own.end));
      units.push({ ranges: residual, enclosing, label: "parent residual (body statements omitted)" });
    };
    for (const statement of source.statements) partition(statement);

    const identifiers: Array<{ node: ts.Identifier; symbol: ts.Symbol }> = [];
    const unresolvedIdentifiers: ts.Identifier[] = [];
    walkAst(source, (node) => {
      if (!ts.isIdentifier(node)) return;
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) identifiers.push({ node, symbol });
      else unresolvedIdentifiers.push(node);
    });
    // Never match references by spelling. Include sibling destructured bindings (e.g. value/setValue).
    const bindings = new Map<ts.Symbol, Set<ts.Symbol>>();
    walkAst(source, (node) => {
      if (!ts.isVariableDeclaration(node) || ts.isIdentifier(node.name)) return;
      const siblings = new Set<ts.Symbol>();
      walkAst(node.name, (child) => {
        if (ts.isIdentifier(child)) {
          const symbol = checker.getSymbolAtLocation(child);
          if (symbol) siblings.add(symbol);
        }
      });
      for (const symbol of siblings) bindings.set(symbol, siblings);
    });
    // The outer statement inside a function retains if/try/loop conditions and JSX render guards.
    const excerpt = (node: ts.Node) => {
      let statement: ts.Node = node;
      for (let parent = node.parent; parent && parent !== source; parent = parent.parent) {
        if (ts.isFunctionLike(parent) || (ts.isBlock(parent) && ts.isFunctionLike(parent.parent))) break;
        if (ts.isStatement(parent)) statement = parent;
      }
      return range(statement.getStart(source), statement.getEnd());
    };
    const assigned = new Set<number>();
    const targeted = units.sort((a, b) =>
      Number(a.label.startsWith("parent residual")) - Number(b.label.startsWith("parent residual")) ||
      a.ranges[0]!.start - b.ranges[0]!.start,
    ).map((unit) => {
      const anchors = change.reviewLines.filter((line) =>
        !assigned.has(line) && unit.ranges.some((entry) => line >= entry.startLine && line <= entry.endLine));
      for (const anchor of anchors) assigned.add(anchor);
      return { ...unit, anchors };
    }).filter((unit) => unit.anchors.length).sort((a, b) => a.ranges[0]!.start - b.ranges[0]!.start);
    const groups: Array<typeof targeted> = [];
    for (const unit of targeted) {
      const previous = groups.at(-1);
      if (previous && size([...previous, unit].flatMap((entry) => entry.ranges)) <= primaryLimit)
        previous.push(unit);
      else groups.push([unit]);
    }
    const scopes = groups.map((group, index) => {
      const primary = group.flatMap((unit) => unit.ranges);
      const inside = (node: ts.Node) => primary.some((entry) => node.getStart(source) >= entry.start && node.getEnd() <= entry.end);
      const symbols = new Set(identifiers.filter(({ node }) => inside(node)).map(({ symbol }) => symbol));
      for (const symbol of [...symbols]) for (const sibling of bindings.get(symbol) ?? []) symbols.add(sibling);
      const requests: Array<Range & { reason: string }> = [];
      const unresolved = new Set(unresolvedIdentifiers.filter(inside).map((node) => node.text));
      for (const symbol of symbols) {
        const declarations = symbol.declarations?.filter((node) => node.getSourceFile() === source) ?? [];
        if (!declarations.length || declarations.some((node) => ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)))
          unresolved.add(symbol.name);
        for (const declaration of declarations) requests.push({ ...excerpt(declaration), reason: `declaration of ${symbol.name}` });
      }
      for (const { node, symbol } of identifiers)
        if (symbols.has(symbol) && !inside(node)) requests.push({ ...excerpt(node), reason: `reference to ${symbol.name}` });
      const supporting: typeof requests = [];
      const omitted: Array<{ startLine: number; endLine: number; reason: string }> = [];
      const enclosing = group.flatMap((unit) => unit.enclosing ? [{
        startLine: unit.enclosing.startLine, endLine: unit.enclosing.endLine,
        note: "Primary ranges are excerpts, not a contiguous body. Intervening source is omitted unless separately supplied.",
      }] : []);
      const payload = {
        file: change.file, anchors: group.flatMap((unit) => unit.anchors), primary, enclosing, supporting,
      };
      // Prefer smaller complete statements; never truncate a condition or silently overflow the budget.
      for (const request of requests.sort((a, b) => a.text.length - b.text.length || a.start - b.start)) {
        if ([...primary, ...supporting].some((entry) => entry.start <= request.start && entry.end >= request.end)) continue;
        if (omitted.some((entry) => entry.startLine === request.startLine && entry.endLine === request.endLine)) continue;
        if (size({ ...payload, supporting: [...supporting, request] }) > payloadLimit) {
          omitted.push({ startLine: request.startLine, endLine: request.endLine, reason: request.reason });
          continue;
        }
        supporting.push(request);
      }
      return {
        id: `${change.file}:${index + 1}`, payload, characters: size(payload),
        oversized: size(primary) > primaryLimit || size(payload) > payloadLimit,
        omitted, unresolved: [...unresolved].sort(),
      };
    });
    return {
      file: change.file, scopes, unavailable: false,
      unowned: change.reviewLines.filter((line) => !assigned.has(line)),
      diagnostics: program.getSyntacticDiagnostics(source).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    };
  });
  const requiredParts = files.reduce((sum, file) => sum + file.scopes.length, 0);
  return {
    kind: "offline-head-scope-inventory" as const,
    modelReady: false as const,
    limitations: ["No scoped base evidence or patch fragments", "Same-file lexical references only; not dataflow or a complete consumer graph"],
    budgets: { primaryCharacters: primaryLimit, payloadCharacters: payloadLimit, maxParts },
    requiredParts, exceedsPartLimit: requiredParts > maxParts,
    coverageComplete: files.every((file) => !file.unavailable && !file.unowned.length && !file.diagnostics.length && file.scopes.every((scope) => !scope.oversized)),
    files,
  };
}
