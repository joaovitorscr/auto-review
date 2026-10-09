import ts from "typescript";
import { walkAst } from "../ast.js";

// Shared callees are comparison leads, not proof that two implementations are equivalent.
function operations(node: ts.Node, source: ts.SourceFile) {
  const names = new Set<string>();
  walkAst(node, (child) => {
    if (ts.isCallExpression(child) && !child.expression.getText(source).startsWith("use"))
      names.add(child.expression.getText(source));
    if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
      const name = child.tagName.getText(source);
      if (/^[A-Z]/.test(name)) names.add(name);
    }
  });
  return names;
}

/** Find complete base declarations that use operations present in a rewritten head scope. */
export function baseComparisons(file: string, before: string, head: string[]) {
  const source = ts.createSourceFile(file, before, ts.ScriptTarget.Latest, true);
  const wanted = new Set(head.flatMap((text) => {
    const fragment = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return [...operations(fragment, fragment)];
  }));
  const declarations = source.statements.filter((node) => ts.isFunctionDeclaration(node) || ts.isVariableStatement(node));
  const counts = new Map<string, number>();
  for (const node of declarations)
    for (const name of operations(node, source)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return declarations.flatMap((node) => {
    if (!ts.isFunctionDeclaration(node) && !ts.isVariableStatement(node)) return [];
    const shared = [...operations(node, source)].filter((name) => wanted.has(name));
    if (!shared.length) return [];
    return [{
      score: shared.reduce((sum, name) => sum + 1 / counts.get(name)!, 0),
      file, revision: "base" as const,
      startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      endLine: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1,
      text: node.getText(source),
      reason: `Comparison lead, not established equivalence: shared operations ${shared.join(", ")}`,
    }];
  }).sort((a, b) => b.score - a.score || a.text.length - b.text.length || a.startLine - b.startLine)
    .map(({ score: _score, ...entry }) => entry);
}
