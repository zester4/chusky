import ts from "typescript";

/** Test-only instrumentation: no probe, branch or failure hook enters production. */
export function missionAwaitTransformer(boundaries, displayFilename = (filename) => filename) {
  return (context) => {
      const visit = (node) => {
        if (!ts.isAwaitExpression(node)) return ts.visitEachChild(node, visit, context);
        const original = node.getSourceFile();
        const { line, character } = original.getLineAndCharacterOfPosition(node.getStart(original));
        const id = `${displayFilename(original.fileName)}:${line + 1}:${character + 1}`;
        boundaries.push(id);
        const expression = ts.visitNode(node.expression, visit);
        return context.factory.updateAwaitExpression(node, context.factory.createCallExpression(
          context.factory.createPropertyAccessExpression(context.factory.createIdentifier("globalThis"), "__missionAwait"),
          undefined, [context.factory.createStringLiteral(id), context.factory.createArrowFunction(
            [context.factory.createModifier(ts.SyntaxKind.AsyncKeyword)], undefined, [], undefined,
            context.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), expression,
          )],
        ));
      };
      return (file) => ts.visitNode(file, visit);
  };
}

export function instrumentMissionAwaits(source, filename) {
  const boundaries = [];
  const transformed = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    transformers: { before: [missionAwaitTransformer(boundaries)] },
  });
  return { source: transformed.outputText, boundaries };
}
