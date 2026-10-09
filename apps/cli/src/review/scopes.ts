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
    // Adjacent source ranges can be represented once without hiding a gap or inventing code.
    const compact = (ranges: Range[]) => {
      const merged: Range[] = [];
      for (const entry of [...ranges].sort((a, b) => a.start - b.start)) {
        const previous = merged.at(-1);
        if (previous && entry.start <= previous.end)
          merged[merged.length - 1] = range(previous.start, Math.max(previous.end, entry.end));
        else merged.push(entry);
      }
      return merged;
    };
    const units: Array<{ ranges: Range[]; enclosing?: Range; label: string }> = [];
    const bodyOf = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.body;
      if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return;
      const initializer = node.declarationList.declarations[0]?.initializer;
      const callable = initializer && ts.isCallExpression(initializer)
        ? initializer.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
        : initializer;
      if (callable && (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) && ts.isBlock(callable.body))
        return callable.body;
    };
    const partition = (node: ts.Node, enclosing?: Range) => {
      const own = range(node.getStart(source), node.getEnd());
      const children = ts.isClassDeclaration(node) ? node.members : bodyOf(node)?.statements;
      if (size(own) <= primaryLimit || !children?.length) {
        units.push({ ranges: [own], enclosing, label: ts.SyntaxKind[node.kind] });
        return;
      }
      // Preserve wrapper/dependency-array text separately, with explicit holes for its body statements.
      const residual: Range[] = [];
      let cursor = own.start;
      for (const statement of children) {
        const start = statement.getStart(source);
        if (start > cursor) residual.push(range(cursor, start));
        partition(statement, own);
        cursor = statement.getEnd();
      }
      if (cursor < own.end) residual.push(range(cursor, own.end));
      units.push({ ranges: residual, enclosing, label: "parent residual (body statements omitted)" });
    };
    let cursor = 0;
    const trivia: Range[] = [];
    for (const statement of source.statements) {
      if (statement.getStart(source) > cursor) trivia.push(range(cursor, statement.getStart(source)));
      partition(statement);
      cursor = statement.getEnd();
    }
    if (cursor < text.length) trivia.push(range(cursor, text.length));
    if (trivia.length) units.push({ ranges: trivia, label: "parent residual (top-level trivia)" });

    const identifiers: Array<{ node: ts.Identifier; symbol: ts.Symbol }> = [];
    const unresolvedIdentifiers: ts.Identifier[] = [];
    walkAst(source, (node) => {
      if (!ts.isIdentifier(node)) return;
      const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
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
    // Inline callbacks belong to their JSX consumer; nested handlers retain captured state.
    const excerpt = (node: ts.Node) => {
      let statement: ts.Node = node;
      let consumer: ts.Node | undefined;
      for (let parent = node.parent; parent && parent !== source; parent = parent.parent) {
        if (ts.isJsxSelfClosingElement(parent) || ts.isJsxElement(parent)) {
          if (consumer) break;
          consumer = parent;
          continue;
        }
        if (consumer) {
          if (ts.isJsxExpression(parent) || ts.isConditionalExpression(parent) || ts.isBinaryExpression(parent) ||
              ts.isReturnStatement(parent) || ts.isIfStatement(parent) || ts.isParenthesizedExpression(parent)) {
            consumer = parent;
            continue;
          }
          break;
        }
        if (ts.isFunctionLike(parent)) {
          if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
              (ts.isCallExpression(parent.parent) || ts.isVariableDeclaration(parent.parent) || ts.isJsxExpression(parent.parent))) continue;
          if (ts.isFunctionDeclaration(parent) && parent.parent !== source) return range(parent.getStart(source), parent.getEnd());
          break;
        }
        if (ts.isStatement(parent)) statement = parent;
      }
      const selected = consumer ?? statement;
      return range(selected.getStart(source), selected.getEnd());
    };
    const assigned = new Set<number>();
    const targeted = units.sort((a, b) =>
      Number(a.label.startsWith("parent residual")) - Number(b.label.startsWith("parent residual")) ||
      a.ranges[0]!.start - b.ranges[0]!.start,
    ).map((unit) => {
      const touched = change.reviewLines.filter((line) =>
        unit.ranges.some((entry) => line >= entry.startLine && line <= entry.endLine));
      const anchors = touched.filter((line) => !assigned.has(line));
      for (const anchor of anchors) assigned.add(anchor);
      return { ...unit, anchors, touched };
    }).filter((unit) => unit.touched.length).sort((a, b) => a.ranges[0]!.start - b.ranges[0]!.start);
    const groups: Array<typeof targeted> = [];
    for (const unit of targeted) {
      const previous = groups.at(-1);
      if (previous && size(compact([...previous, unit].flatMap((entry) => entry.ranges))) <= primaryLimit)
        previous.push(unit);
      else groups.push([unit]);
    }
    const scopes = groups.map((group, index) => {
      const primary = compact(group.flatMap((unit) => unit.ranges));
      const inside = (node: ts.Node) => primary.some((entry) => node.getStart(source) >= entry.start && node.getEnd() <= entry.end);
      const symbols = new Set(identifiers.filter(({ node }) => inside(node)).map(({ symbol }) => symbol));
      for (const symbol of [...symbols]) for (const sibling of bindings.get(symbol) ?? []) symbols.add(sibling);
      const requests: Array<Range & { reason: string }> = [];
      const preferred = new Set<string>();
      const imported = new Set<ts.Symbol>();
      const unresolved = new Set(unresolvedIdentifiers.filter(inside).map((node) => node.text));
      for (const symbol of symbols) {
        const declarations = symbol.declarations?.filter((node) => node.getSourceFile() === source) ?? [];
        if (declarations.some((node) => ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)))
          imported.add(symbol);
        if (!declarations.length || imported.has(symbol)) unresolved.add(symbol.name);
        for (const declaration of declarations) {
          const entry = excerpt(declaration);
          requests.push({ ...entry, reason: `declaration of ${symbol.name}` });
          if ((ts.isFunctionDeclaration(declaration) && declaration.parent !== source) || (ts.isVariableDeclaration(declaration) && declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer) ||
               (ts.isCallExpression(declaration.initializer) && declaration.initializer.arguments.some((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))))))
            preferred.add(`${entry.start}:${entry.end}`);
        }
      }
      for (const { node, symbol } of identifiers)
        // Other uses of the same import are not consumers of this scope's changed behavior.
        if (symbols.has(symbol) && !imported.has(symbol) && !inside(node)) {
          const entry = excerpt(node);
          requests.push({ ...entry, reason: `reference to ${symbol.name}` });
          if (symbol.declarations?.some(inside)) preferred.add(`${entry.start}:${entry.end}`);
        }
      const supporting: typeof requests = [];
      const omitted: Array<{ start: number; end: number; startLine: number; endLine: number; reason: string }> = [];
      const enclosing = [...new Map(group.flatMap((unit) => unit.enclosing ? [[unit.enclosing.start, {
        startLine: unit.enclosing.startLine, endLine: unit.enclosing.endLine,
        note: "Primary ranges are excerpts, not a contiguous body. Intervening source is omitted unless separately supplied.",
      }] as const] : [])).values()];
      const payload = {
        file: change.file, anchors: group.flatMap((unit) => unit.anchors),
        relatedChangedLines: [...new Set(group.flatMap((unit) => unit.touched))].sort((a, b) => a - b),
        primary, enclosing, supporting,
      };
      // Consumers and complete handlers precede incidental reads; trimming retains this priority.
      const priority = (entry: Range) => {
        const fragment = ts.createSourceFile(change.file, entry.text, ts.ScriptTarget.Latest, true);
        let related = false;
        walkAst(fragment, (node) => {
          if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isFunctionLike(node)) related = true;
        });
        return related && preferred.has(`${entry.start}:${entry.end}`) ? 0 : related ? 1 : 2;
      };
      const priorities = new Map(requests.map((entry) => [entry, priority(entry)]));
      for (const request of requests.sort((a, b) => priorities.get(a)! - priorities.get(b)! || a.text.length - b.text.length || a.start - b.start)) {
        if ([...primary, ...supporting].some((entry) => entry.start <= request.start && entry.end >= request.end)) continue;
        if (size(request) > primaryLimit && primary.some((entry) => request.start <= entry.start && request.end >= entry.end)) {
          omitted.push({ start: request.start, end: request.end, startLine: request.startLine, endLine: request.endLine, reason: request.reason });
          continue;
        }
        if (omitted.some((entry) => entry.start === request.start && entry.end === request.end)) continue;
        const next = supporting.filter((entry) => !(request.start <= entry.start && request.end >= entry.end));
        next.push(request);
        if (size({ ...payload, supporting: next }) > payloadLimit) {
          omitted.push({ start: request.start, end: request.end, startLine: request.startLine, endLine: request.endLine, reason: request.reason });
          continue;
        }
        supporting.splice(0, supporting.length, ...next);
      }
      return {
        id: `${change.file}:${index + 1}`, payload, characters: size(payload),
        oversized: size(primary) > primaryLimit || size(payload) > payloadLimit,
        omitted: omitted.filter((entry) => !compact([...primary, ...supporting]).some((covered) => covered.start <= entry.start && covered.end >= entry.end)),
        unresolved: [...unresolved].sort(),
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
    boundedHeadCoverage: files.every((file) => !file.unavailable && !file.unowned.length && !file.diagnostics.length && file.scopes.every((scope) => !scope.oversized)),
    files,
  };
}
