/**
 * Boundary-read gate (v1.38.0, "Validate at the boundary").
 *
 * Data that crosses a trust or storage boundary (KV, R2, D1 JSON columns,
 * remote fetches, request bodies, stored strings) is read as `unknown` and
 * validated before use. A type argument or an `as` cast on the read itself
 * only TELLS the compiler the shape; nothing checks it. This gate parses each
 * production file (not tests) with the TypeScript compiler and fails on any
 * of these patterns, and only these; it is not a proof that every read is
 * checked:
 *
 * - `kv-get-json`: a `.get(…)` or `.getWithMetadata(…)` whose second
 *   argument is `'json'` (also `'json' as const`, in parentheses, or a
 *   template literal) or an options object with a `type` property (named,
 *   quoted or computed, in any position, before or after a spread) set to
 *   `'json'`, with ANY type argument or none: KV values are read as text and
 *   parsed locally, so a parse error never quotes the value
 * - `json-generic`: `.json<T>()`, T not `unknown`
 * - `req-json-generic`: `c.req.json<T>()`, T not `unknown`
 * - `req-json-untyped`: `c.req.json()` with no type argument (implicit any);
 *   write `c.req.json<unknown>()`
 * - `json-await-as`: `.json()` (also after `.catch(…)`, with or without
 *   `await` and parentheses) cast with `as T` or `<T>`, T not `unknown`
 * - `json-parse-as`: `JSON.parse(…)` cast the same way
 * - `json-annotated`: an argument-free `.json()` (also after `.catch(…)`) as
 *   the initializer of a binding whose type annotation is not `unknown`
 *   (`const`/`let`/`var`, destructuring too, a parameter default, a class
 *   field), or assigned with `=`, `??=`, `||=` or `&&=` to a variable or
 *   parameter whose nearest declaration in the same file carries such an
 *   annotation. `.json()` returns `any`, so the annotation is an unchecked
 *   cast. `c.json(body)` and other calls with arguments are not reads
 * - `json-parse-annotated`: `JSON.parse(…)` in the same positions
 *
 * `unknown`, also in a union with `null` and/or `undefined` (in any order,
 * parenthesised or not), counts as unknown. Not seen (no type checker):
 * property assignments (`this.x = …`, `obj.x = …`), object literal
 * properties, a hoisted `var` declared in a nested block, a destructured
 * declaration of an assigned name, and a `return r.json()` from a function
 * with a declared return type.
 *
 * D1 `.first<T>()` / `.all<T>()` rows are this Worker's own schema and are
 * out of scope, except JSON columns, which are parsed with a schema.
 *
 * A vetted case carries a `// boundary-ok: <reason>` line comment on the
 * same line as the start of the flagged read (anywhere on that line, after
 * any token) or on the line immediately before it; nothing further away
 * counts, and nothing is inherited from an enclosing statement or function.
 * Only real comments count: they are collected from the parsed source's
 * comment trivia (the leading and trailing comment ranges of every token),
 * never by matching raw lines, so the same text inside a string, template
 * literal, regular expression or block comment exempts nothing.
 *
 *   node scripts/check-boundary-reads.mjs     # exits 1 and lists file:line pattern
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Production source roots, relative to the repository. */
export const ROOTS = ['src', 'shared/src', 'mcp/src', 'admin/src'];

/** Generated sources hold prose, not reads. */
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'generated', 'test', '__tests__']);

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The exemption marker, with a non-empty reason. */
const EXEMPTION = /^\/\/\s*boundary-ok:\s*\S/;

/** Whether `path` (repository-relative, `/`-separated) is a production source file. */
export function isProductionSource(path) {
  if (!SOURCE.test(path) || TEST_FILE.test(path) || path.endsWith('.d.ts')) return false;
  return !path.split('/').some(part => EXCLUDED_DIRECTORIES.has(part));
}

/** `node` without parentheses, `await`, non-null `!`, `as const` and `satisfies`. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    } else if (
      (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) &&
      ts.isTypeReferenceNode(current.type) &&
      current.type.typeName.getText() === 'const'
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/** Whether `node` is the string `json` (a string or template literal). */
function isJsonString(node) {
  const value = unwrap(node);
  return (
    (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) &&
    value.text === 'json'
  );
}

/** A property's name as text: an identifier, or a quoted, numeric or computed literal key. */
function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrap(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
  return undefined;
}

/**
 * Whether a KV read's second argument asks for JSON: `'json'`, or an options
 * object with ANY `type: 'json'` property, wherever it stands among the others
 * and however its key is spelt.
 */
function readsJson(argument) {
  if (argument === undefined) return false;
  if (isJsonString(argument)) return true;
  const value = unwrap(argument);
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some(
    property =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === 'type' &&
      isJsonString(property.initializer),
  );
}

/** Whether a type node is `null` or `undefined`. */
const isNullish = member =>
  member.kind === ts.SyntaxKind.UndefinedKeyword ||
  (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword);

/**
 * Whether a type node reads as unknown: `unknown`, or `unknown` in a union
 * whose other members are only `null` and `undefined` (any order, nested
 * unions and parentheses included).
 */
function isUnknownType(type) {
  const members = [];
  const flatten = node => {
    let current = node;
    while (ts.isParenthesizedTypeNode(current)) current = current.type;
    if (ts.isUnionTypeNode(current)) current.types.forEach(flatten);
    else members.push(current);
  };
  flatten(type);
  return (
    members.some(member => member.kind === ts.SyntaxKind.UnknownKeyword) &&
    members.every(member => member.kind === ts.SyntaxKind.UnknownKeyword || isNullish(member))
  );
}

/** `x.name(…)`: the property name of a call on a member, else undefined. */
function calledMember(call) {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

/** The `.json(…)` call `node` is, or that a `.catch(…)` is chained on, else undefined. */
function jsonCall(node) {
  const value = unwrap(node);
  if (!ts.isCallExpression(value)) return undefined;
  if (calledMember(value) === 'json') return value;
  if (calledMember(value) === 'catch') return jsonCall(value.expression.expression);
  return undefined;
}

/** Whether `node` is a `JSON.parse(…)` call. */
function isJsonParse(node) {
  const value = unwrap(node);
  return (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'parse' &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === 'JSON'
  );
}

/** Whether a `.json` call is on a request (`c.req.json`, `req.json`). */
function onRequest(call) {
  const target = call.expression.expression;
  return (
    (ts.isPropertyAccessExpression(target) && target.name.text === 'req') ||
    (ts.isIdentifier(target) && target.text === 'req')
  );
}

/** The script kind for a file name. */
function scriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * The 0-based lines holding a real `// boundary-ok: <reason>` comment: every
 * comment range in the leading and trailing trivia of every token of the
 * parsed file. Text inside a token (a string, a template literal, a regular
 * expression) is never trivia, so it is never seen here.
 */
function markerLines(source) {
  const text = source.text;
  const seen = new Set();
  const lines = new Set();
  const collect = ranges => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      if (
        range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
        EXEMPTION.test(text.slice(range.pos, range.end))
      ) {
        lines.add(source.getLineAndCharacterOfPosition(range.pos).line);
      }
    }
  };
  const walk = node => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) walk(child);
  };
  walk(source);
  return lines;
}

/** The `.json()` call `node` is, argument-free (also under a `.catch(…)`), else undefined. */
function argumentFreeJsonCall(node) {
  const json = jsonCall(node);
  return json && json.arguments.length === 0 ? json : undefined;
}

/** The finding for an untyped JSON read initialising or assigned to an annotated binding. */
function annotatedJsonRead(value) {
  const json = argumentFreeJsonCall(value);
  if (json && (json.typeArguments ?? []).length === 0) {
    return { node: json.expression.name, pattern: 'json-annotated' };
  }
  if (isJsonParse(value)) {
    return { node: unwrap(value).expression, pattern: 'json-parse-annotated' };
  }
  return undefined;
}

/** The statements a scope node holds directly, if it holds any. */
function scopeStatements(node) {
  if (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  ) {
    return node.statements;
  }
  return [];
}

/**
 * The type annotation of the nearest declaration of `identifier`'s name in
 * the same file (a variable declared directly in an enclosing scope, a
 * parameter of an enclosing function, a `for` or `catch` variable), or
 * undefined (no annotation, or no declaration found). Shallow, without a
 * type checker: destructured names and hoisted `var`s in nested blocks are
 * not resolved.
 */
function declaredType(identifier) {
  const name = identifier.text;
  const matches = declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === name;
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    const declarations = [];
    if (ts.isFunctionLike(scope)) declarations.push(...scope.parameters);
    if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      declarations.push(scope.variableDeclaration);
    }
    if (
      (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer)
    ) {
      declarations.push(...scope.initializer.declarations);
    }
    for (const statement of scopeStatements(scope)) {
      if (ts.isVariableStatement(statement)) {
        declarations.push(...statement.declarationList.declarations);
      }
    }
    const declaration = declarations.find(matches);
    if (declaration) return declaration.type;
  }
  return undefined;
}

/** Assignment operators an annotated binding can receive a read through. */
const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** Every finding in one file's text, as {line, pattern}. */
export function findBoundaryReads(text, fileName = 'source.ts') {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const findings = [];
  const vetted = markerLines(source);
  const add = (node, pattern) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (vetted.has(line) || vetted.has(line - 1)) return;
    findings.push({ line: line + 1, pattern });
  };

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const member = calledMember(node);
      if ((member === 'get' || member === 'getWithMetadata') && readsJson(node.arguments[1])) {
        add(node.expression.name, 'kv-get-json');
      }
      if (member === 'json') {
        const types = node.typeArguments ?? [];
        if (types.length > 0 && !types.every(isUnknownType)) {
          add(node.expression.name, onRequest(node) ? 'req-json-generic' : 'json-generic');
        } else if (types.length === 0 && onRequest(node)) {
          add(node.expression.name, 'req-json-untyped');
        }
      }
    }
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      !isUnknownType(node.type)
    ) {
      const isConst = ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === 'const';
      if (!isConst) {
        const json = jsonCall(node.expression);
        if (json) add(json.expression.name, 'json-await-as');
        else if (isJsonParse(node.expression)) {
          add(unwrap(node.expression).expression, 'json-parse-as');
        }
      }
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) &&
      node.type &&
      node.initializer &&
      !isUnknownType(node.type)
    ) {
      const read = annotatedJsonRead(node.initializer);
      if (read) add(read.node, read.pattern);
    }
    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENTS.has(node.operatorToken.kind) &&
      ts.isIdentifier(node.left)
    ) {
      // The right-hand side first: a declaration is resolved only for a read
      const read = annotatedJsonRead(node.right);
      if (read) {
        const type = declaredType(node.left);
        if (type && !isUnknownType(type)) add(read.node, read.pattern);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return findings.toSorted((a, b) => a.line - b.line || a.pattern.localeCompare(b.pattern));
}

/** Production files under the roots, repository-relative with `/`. */
export function productionFiles(repoRoot, roots = ROOTS) {
  const files = [];
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(name)) walk(path);
        continue;
      }
      const relativePath = relative(repoRoot, path).split(sep).join('/');
      if (isProductionSource(relativePath)) files.push(relativePath);
    }
  };
  for (const root of roots) walk(resolve(repoRoot, root));
  return files.toSorted();
}

/** All findings in the repository, as `file:line pattern` lines. */
export function checkBoundaryReads(repoRoot, roots = ROOTS) {
  const lines = [];
  for (const file of productionFiles(repoRoot, roots)) {
    for (const { line, pattern } of findBoundaryReads(
      readFileSync(resolve(repoRoot, file), 'utf8'),
      file,
    )) {
      lines.push(`${file}:${line} ${pattern}`);
    }
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const findings = checkBoundaryReads(repoRoot);
  if (findings.length > 0) {
    console.error(
      `Boundary reads must be read as unknown and validated; ${findings.length} finding(s):`,
    );
    for (const finding of findings) console.error(`  ${finding}`);
    console.error('Validate the value, or mark a vetted case with // boundary-ok: <reason>.');
    process.exitCode = 1;
  } else {
    console.log('Boundary reads: none unvalidated.');
  }
}
