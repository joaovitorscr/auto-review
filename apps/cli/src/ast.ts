import { relative } from "node:path";
import ts from "typescript";

/** Visits every syntax node in source order. Return false to skip a node's children. */
export function walkAst(node: ts.Node, visit: (node: ts.Node) => void | false): void {
  if (visit(node) === false) return;
  ts.forEachChild(node, (child) => walkAst(child, visit));
}

export function indexProgram(program: ts.Program, root: string, paths: ReadonlySet<string>) {
  const checker = program.getTypeChecker();
  const location = (node: ts.Node) => {
    const source = node.getSourceFile();
    const start = node.getStart(source);
    return {
      file: relative(root, source.fileName).replaceAll("\\", "/"),
      start,
      end: node.getEnd(),
      startLine: source.getLineAndCharacterOfPosition(start).line + 1,
      endLine: source.getLineAndCharacterOfPosition(Math.max(start, node.getEnd() - 1)).line + 1,
    };
  };
  const id = (node: ts.Node) => {
    const at = location(node);
    return `${at.file}:${at.start}`;
  };
  const declaration = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node)
    )
      return node;
    return undefined;
  };
  const symbols: Array<
    ReturnType<typeof location> & { id: string; name: string; kind: string; parent?: string }
  > = [];
  const imports: Array<ReturnType<typeof location> & { module: string; target?: string }> = [];
  const calls: Array<
    ReturnType<typeof location> & { expression: string; caller?: string; target?: string }
  > = [];
  const files = program.getSourceFiles().filter((source) => paths.has(source.fileName));
  const owner = (node: ts.Node, callable = false) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (declaration(parent) && (!callable || ts.isFunctionLike(parent))) return id(parent);
    }
    return undefined;
  };
  for (const source of files) {
    walkAst(source, (node) => {
      const declared = declaration(node);
      if (declared) {
        const name =
          "name" in declared && declared.name
            ? declared.name.getText(source)
            : ts.isConstructorDeclaration(declared)
              ? "constructor"
              : ts.isVariableDeclaration(declared.parent) ||
                  ts.isPropertyAssignment(declared.parent) ||
                  ts.isPropertyDeclaration(declared.parent)
                ? declared.parent.name.getText(source)
                : "<anonymous>";
        symbols.push({
          id: id(node),
          name,
          kind: ts.SyntaxKind[node.kind],
          ...location(node),
          parent: owner(node),
        });
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier);
        const target = moduleSymbol?.declarations?.find(ts.isSourceFile);
        imports.push({
          ...location(node),
          module: node.moduleSpecifier.text,
          target:
            target && paths.has(target.fileName)
              ? relative(root, target.fileName).replaceAll("\\", "/")
              : undefined,
        });
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        let symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol);
        const candidates = symbol?.declarations ?? [];
        const signature = checker.getResolvedSignature(node)?.declaration;
        const resolved =
          candidates.find(
            (candidate) => ts.isFunctionLike(candidate) && "body" in candidate && candidate.body,
          ) ??
          signature ??
          symbol?.valueDeclaration;
        let target = resolved;
        if (
          target &&
          ts.isVariableDeclaration(target) &&
          target.initializer &&
          (ts.isArrowFunction(target.initializer) || ts.isFunctionExpression(target.initializer))
        )
          target = target.initializer;
        calls.push({
          ...location(node),
          expression: node.expression.getText(source),
          caller: owner(node, true),
          target:
            target && paths.has(target.getSourceFile().fileName) && declaration(target)
              ? id(target)
              : undefined,
        });
      }
    });
  }
  const diagnostics = files.flatMap((source) =>
    program.getSyntacticDiagnostics(source).map((diagnostic) => ({
      file: relative(root, source.fileName).replaceAll("\\", "/"),
      line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    })),
  );
  return {
    files: files.map((source) => relative(root, source.fileName).replaceAll("\\", "/")),
    symbols,
    imports,
    calls,
    diagnostics,
  };
}
