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
 *   argument is `'json'` (also through any `as` or `<T>` assertion, such as
 *   `'json' as const` or `'json' as 'json'`, in parentheses, or a template
 *   literal) or an options object with a `type` property (named,
 *   quoted or computed, in any position, before or after a spread) set to
 *   `'json'`, with ANY type argument or none: KV values are read as text and
 *   parsed locally, so a parse error never quotes the value
 * - `json-generic`: `.json<T>()`, T not `unknown`
 * - `req-json-generic`: `c.req.json<T>()`, T not `unknown`
 * - `req-json-untyped`: `c.req.json()` with no type argument (implicit any);
 *   write `c.req.json<unknown>()`
 * - `json-await-as`: `.json()` (also after `.catch(…)`, with or without
 *   `await` and parentheses) cast with `as T` or `<T>`, T not `unknown`,
 *   also through a chain of assertions (`as unknown as T`): a chain is
 *   flagged when any assertion in it names a type other than `unknown`
 * - `json-parse-as`: `JSON.parse(…)` cast the same way
 * - `json-annotated`: an argument-free `.json()` (also after `.catch(…)`) as
 *   the initializer of a binding whose type annotation is not `unknown`
 *   (`const`/`let`/`var`, destructuring too, a parameter default, a class
 *   field), or assigned with `=`, `??=`, `||=` or `&&=` to a variable or
 *   parameter whose nearest declaration in the same file carries such an
 *   annotation. `.json()` returns `any`, so the annotation is an unchecked
 *   cast. `c.json(body)` and other calls with arguments are not reads. The
 *   value is looked for through parentheses, `await`, `!`, `satisfies`,
 *   `??`, `||`, `&&` and both branches of a conditional, since each can hand
 *   the read to the binding
 * - `json-parse-annotated`: `JSON.parse(…)` in the same positions
 *
 * A union with `unknown` in it counts as `unknown` (TypeScript collapses it
 * to `unknown`), parenthesised or not, unless `any` is in it too (then it is
 * `any`). A declaration in a `switch` is found
 * in its whole case block, the scope of a `let` or `const` there. Not seen
 * (no type checker):
 * property assignments (`this.x = …`, `obj.x = …`), object literal
 * properties, a hoisted `var` declared in a nested block, a destructured
 * declaration of an assigned name, and a `return r.json()` from a function
 * with a declared return type.
 *
 * D1 `.first<T>()` / `.all<T>()` rows are this Worker's own schema and are
 * out of scope, except JSON columns, which are parsed with a schema.
 *
 * A vetted case carries a `// boundary-ok: <reason>` line comment on the
 * line of the read's own token, the `.json`, `JSON.parse` or KV `.get` the
 * finding reports (anywhere on that line, after any token), or on the line
 * immediately before it, and not inside a function or a call's argument list
 * nested in the read's receiver: such a comment documents that nested code,
 * never the read. Nothing further away counts, and nothing is inherited from
 * an enclosing statement or function. A multi-line member chain is vetted by
 * a marker on the line before its `.json<T>()`.
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

/** `node` without parentheses, `await`, `!`, `satisfies` and ANY `as` or `<T>` assertion. */
function unwrapAssertions(node) {
  let current = unwrap(node);
  while (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = unwrap(current.expression);
  }
  return current;
}

/** Whether `node` is the string `json` (a string or template literal), through any assertion. */
function isJsonString(node) {
  const value = unwrapAssertions(node);
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

/** The members of a type, through parentheses and nested unions. */
function unionMembers(type) {
  let current = type;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  return ts.isUnionTypeNode(current) ? current.types.flatMap(unionMembers) : [current];
}

/**
 * Whether a type node reads as unknown: `unknown`, or a union with `unknown`
 * among its members (TypeScript collapses `unknown | T` to `unknown`), nested
 * unions and parentheses included, unless `any` is a member too: `any`
 * absorbs `unknown`, so such a union is `any`.
 */
function isUnknownType(type) {
  const members = unionMembers(type);
  return (
    members.some(member => member.kind === ts.SyntaxKind.UnknownKeyword) &&
    !members.some(member => member.kind === ts.SyntaxKind.AnyKeyword)
  );
}

/** Whether `node` is an `as` or `<T>` type assertion. */
const isAssertion = node => ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);

/** Whether an `as` or `<T>` assertion is `as const`. */
const isConstAssertion = node =>
  ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === 'const';

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
 * The real `// boundary-ok: <reason>` comments, as `{ pos, line }` (0-based
 * line): every comment range in the leading and trailing trivia of every
 * token of the parsed file. Text inside a token (a string, a template
 * literal, a regular expression) is never trivia, so it is never seen here.
 */
function markers(source) {
  const text = source.text;
  const seen = new Set();
  const found = [];
  const collect = ranges => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      if (
        range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
        EXEMPTION.test(text.slice(range.pos, range.end))
      ) {
        found.push({ pos: range.pos, line: source.getLineAndCharacterOfPosition(range.pos).line });
      }
    }
  };
  const walk = node => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) walk(child);
  };
  walk(source);
  return found;
}

/**
 * The spans inside a read's RECEIVER that belong to other code: every
 * function-like node and every call's argument list nested in it (the `x` of
 * `x.json()`, the `kv` of `kv.get(…)`). A marker there documents that code,
 * never the read.
 */
function foreignSpans(read) {
  const receiver =
    read && ts.isCallExpression(read) && ts.isPropertyAccessExpression(read.expression)
      ? read.expression.expression
      : undefined;
  const spans = [];
  const visit = node => {
    if (ts.isFunctionLike(node)) spans.push([node.pos, node.end]);
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      spans.push([node.arguments.pos, node.arguments.end]);
    }
    ts.forEachChild(node, visit);
  };
  if (receiver) visit(receiver);
  return spans;
}

/** The `.json()` call `node` is, argument-free (also under a `.catch(…)`), else undefined. */
function argumentFreeJsonCall(node) {
  const json = jsonCall(node);
  return json && json.arguments.length === 0 ? json : undefined;
}

/** The operators an initialiser or assignment can hand either operand through. */
const LOGICAL = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

/**
 * The findings for untyped JSON reads initialising or assigned to an
 * annotated binding: an argument-free `.json()` or `JSON.parse(…)`, looked
 * for through `??`, `||`, `&&` and both branches of a conditional (and
 * parentheses, `await`, `!`, `satisfies`), since each hands the read's value
 * to the binding.
 */
function annotatedJsonReads(expression) {
  const value = unwrap(expression);
  if (ts.isBinaryExpression(value) && LOGICAL.has(value.operatorToken.kind)) {
    return [...annotatedJsonReads(value.left), ...annotatedJsonReads(value.right)];
  }
  if (ts.isConditionalExpression(value)) {
    return [...annotatedJsonReads(value.whenTrue), ...annotatedJsonReads(value.whenFalse)];
  }
  const json = argumentFreeJsonCall(value);
  if (json && (json.typeArguments ?? []).length === 0) {
    return [{ node: json.expression.name, read: json, pattern: 'json-annotated' }];
  }
  if (isJsonParse(value)) {
    return [{ node: value.expression, read: value, pattern: 'json-parse-annotated' }];
  }
  return [];
}

/**
 * The statements a scope node holds directly, if it holds any. A `switch`'s
 * case block is ONE scope for `let` and `const`: a declaration in one clause
 * is seen from every other.
 */
function scopeStatements(node) {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
    return node.statements;
  }
  if (ts.isCaseBlock(node)) return node.clauses.flatMap(clause => [...clause.statements]);
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

/**
 * The nearest ancestor of `node` that is not a wrapper `unwrap` looks
 * through (parentheses, `await`, `!`, `satisfies`): what the value of `node`
 * flows into.
 */
function unwrapParentsOf(node) {
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAwaitExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent))
  ) {
    parent = parent.parent;
  }
  return parent;
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
  let found;
  // `node` is the read's own token (`.json`, `JSON.parse`, KV `.get`), which
  // is reported; `read` is the read expression. A marker on the token's line
  // or the line before vets the read, unless it sits in a function or a
  // call's arguments inside the read's receiver
  const add = (node, read, pattern) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    found ??= markers(source);
    const near = found.filter(marker => marker.line === line || marker.line === line - 1);
    if (near.length > 0) {
      const spans = foreignSpans(read);
      const owns = marker => !spans.some(([start, end]) => marker.pos >= start && marker.pos < end);
      if (near.some(owns)) return;
    }
    findings.push({ line: line + 1, pattern });
  };

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const member = calledMember(node);
      if ((member === 'get' || member === 'getWithMetadata') && readsJson(node.arguments[1])) {
        add(node.expression.name, node, 'kv-get-json');
      }
      if (member === 'json') {
        const types = node.typeArguments ?? [];
        if (types.length > 0 && !types.every(isUnknownType)) {
          add(node.expression.name, node, onRequest(node) ? 'req-json-generic' : 'json-generic');
        } else if (types.length === 0 && onRequest(node)) {
          add(node.expression.name, node, 'req-json-untyped');
        }
      }
    }
    // A chain of assertions is judged once, from its outermost one: a read
    // under it (through parentheses, `await`, `!`, `satisfies` and every
    // inner assertion) is flagged when any assertion in the chain names a
    // type other than `unknown` or `const` (`as unknown as T` included)
    if (isAssertion(node) && !isAssertion(unwrapParentsOf(node))) {
      let typed = false;
      let inner = node;
      while (isAssertion(inner)) {
        if (!isConstAssertion(inner) && !isUnknownType(inner.type)) typed = true;
        inner = unwrap(inner.expression);
      }
      if (typed) {
        const json = jsonCall(inner);
        if (json) add(json.expression.name, json, 'json-await-as');
        else if (isJsonParse(inner)) add(inner.expression, inner, 'json-parse-as');
      }
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) &&
      node.type &&
      node.initializer &&
      !isUnknownType(node.type)
    ) {
      for (const read of annotatedJsonReads(node.initializer))
        add(read.node, read.read, read.pattern);
    }
    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENTS.has(node.operatorToken.kind) &&
      ts.isIdentifier(node.left)
    ) {
      // The right-hand side first: a declaration is resolved only for a read
      const reads = annotatedJsonReads(node.right);
      if (reads.length > 0) {
        const type = declaredType(node.left);
        if (type && !isUnknownType(type)) {
          for (const read of reads) add(read.node, read.read, read.pattern);
        }
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
