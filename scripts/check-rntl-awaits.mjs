#!/usr/bin/env node
/**
 * Fail when an `apps/mobile` test drops a promise from React Native Testing
 * Library 14's async API (H23, #1070).
 *
 * N550 (#1002) moved 120 test files to RNTL 14, where `render`, `renderHook`,
 * `fireEvent` and its members, `act`, `rerender` and `unmount` all return
 * promises. A dropped one is not a type error: `fireEvent.press(button);` as a
 * bare statement type-checks the same whether `press` returns `void` or
 * `Promise<void>`. During that migration `tsc --noEmit` read 0 errors while
 * 1,058 call sites were still unawaited, so the typechecker is blind to this
 * by construction. The suite is not a reliable backstop either: an unawaited
 * event lets the next assertion run before the state it checks is committed,
 * which usually fails and sometimes passes. F51 (#1101) was one of those.
 *
 * # What it flags
 *
 * An EXPRESSION STATEMENT (the call's value is thrown away) whose call is:
 *   - an RNTL import from ASYNC_CALLS, e.g. `render(...)`, `act(...)`, `waitFor(...)`;
 *   - `fireEvent(...)` or `fireEvent.<anything>(...)`;
 *   - `screen.rerender/unmount/findBy*(...)`;
 *   - `userEvent.<method>(...)` (other than `setup`), and any method of a
 *     session from `userEvent.setup()`: `const user = userEvent.setup(); user.press(el);`;
 *   - `rerender/unmount/findBy*` taken from a render result, destructured
 *     (`const { rerender } = await render(...)`) or as `view.rerender(...)`;
 *   - a TEST-LOCAL HELPER that wraps any of the above: a named function that is
 *     `async`, or that returns one of these calls. That includes helpers
 *     exported from another test file and imported relatively.
 *
 * # What it deliberately does NOT flag
 *
 *   - The app's own functions. A test may leave one of those pending on
 *     purpose: `lib/__tests__/shareCard.test.ts` calls `shareCard(...)` against
 *     a `shareAsync` mocked never to settle. A blanket "no floating promises"
 *     rule would demand an `await` there and hang the test. That is why this is
 *     scoped to RNTL symbols rather than being `@typescript-eslint/no-floating-promises`,
 *     which also needs typed linting that `apps/mobile` does not have.
 *   - A call whose promise is used: awaited, returned, assigned, or passed on.
 *
 * # The escape hatch, which needs a reason
 *
 * A line comment `// rntl-await-ok: <why>` on the flagged line or the line
 * above it. The reason is required, because a bare marker is the tick-box this
 * check exists to replace. The live case is firing two presses in ONE tick to
 * prove a double-tap guard. `void` alone is not an escape: it discards the
 * promise just as silently.
 *
 * # What it cannot see
 *
 * It is syntactic (TypeScript's parser, no type checker), so it knows names,
 * not types. A promise laundered through `.then(...)`, an alias
 * (`const press = fireEvent.press`), or a helper passed in as an argument goes
 * unseen. It runs its own SELF_TEST cases first, both kinds, and refuses to
 * scan if any is wrong, so a parser that finds nothing cannot pass silently.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE = join(ROOT, 'apps/mobile');
const ts = createRequire(join(MOBILE, 'package.json'))('typescript');

const RNTL = '@testing-library/react-native';
/** RNTL exports whose call returns a promise under RNTL 14. */
const ASYNC_CALLS = new Set(['render', 'renderHook', 'act', 'waitFor', 'waitForElementToBeRemoved']);
/** RNTL exports where the export itself and every member call is async. */
const ASYNC_NAMESPACES = new Set(['fireEvent']);
/** RNTL's userEvent: every method but `setup` is async, and so is every method of the session `setup()` returns. */
const USER_EVENT = 'userEvent';
/** Async methods on `screen` and on a render result. */
const ASYNC_METHOD = /^(rerender|unmount|find(All)?By\w+)$/;
const OPT_OUT = /\/\/\s*rntl-await-ok:\s*\S/;

function calleePath(expr) {
  const parts = [];
  let e = expr;
  while (ts.isPropertyAccessExpression(e)) {
    parts.unshift(e.name.text);
    e = e.expression;
  }
  if (!ts.isIdentifier(e)) return null;
  parts.unshift(e.text);
  return parts;
}

function unwrap(expr) {
  let e = expr;
  while (e && (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression?.(e) || ts.isNonNullExpression(e))) e = e.expression;
  return e;
}

/** First pass over one file: its RNTL imports, its helper declarations, its relative imports. */
function collect(sf) {
  const rntl = new Map(); // local name -> RNTL export name
  const namespaces = new Set();
  const relImports = []; // { local, imported, spec }
  const decls = []; // { name, node, exported }
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const nb = st.importClause.namedBindings;
      if (spec === RNTL) {
        if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) rntl.set(el.name.text, (el.propertyName ?? el.name).text);
      } else if (spec.startsWith('.') && nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) relImports.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, spec });
      }
    }
  }
  const visit = (node) => {
    const exported = !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(node) && node.name) decls.push({ name: node.name.text, fn: node, exported });
    if (ts.isVariableStatement(node)) {
      const ex = !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          decls.push({ name: d.name.text, fn: d.initializer, exported: ex });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { rntl, namespaces, relImports, decls };
}

function makeCtx(info, importedHelpers) {
  return { ...info, helpers: new Set(importedHelpers), resultVars: new Set(), resultFns: new Set(), userVars: new Set() };
}

function isAsyncRntlCall(call, ctx) {
  if (!ts.isCallExpression(call)) return false;
  const path = calleePath(call.expression);
  if (!path) return false;
  let [head, ...rest] = path;
  let exported;
  if (ctx.namespaces.has(head) && rest.length) {
    // `import * as RNTL` — `RNTL.fireEvent.press(...)` names the export one level down.
    head = rest[0];
    rest = rest.slice(1);
    exported = head;
  } else {
    exported = ctx.rntl.get(head);
  }
  if (rest.length === 0) {
    if (exported && (ASYNC_CALLS.has(exported) || ASYNC_NAMESPACES.has(exported))) return true;
    if (ctx.resultFns.has(head) || ctx.helpers.has(head)) return true;
    return false;
  }
  if (exported && ASYNC_NAMESPACES.has(exported)) return true;
  if (rest.length === 1 && exported === USER_EVENT && rest[0] !== 'setup') return true;
  if (rest.length === 1 && ctx.userVars.has(head)) return true;
  if (rest.length === 1 && ASYNC_METHOD.test(rest[0])) {
    if (exported === 'screen' || ctx.resultVars.has(head)) return true;
  }
  return false;
}

/** Bind names that hold a render result, so `rerender(...)` and `view.unmount()` are recognised. */
function isUserEventSetup(call, ctx) {
  if (!ts.isCallExpression(call)) return false;
  const path = calleePath(call.expression);
  if (!path) return false;
  const [head, ...rest] = ctx.namespaces.has(path[0]) ? path.slice(1) : path;
  const exported = ctx.namespaces.has(path[0]) ? head : ctx.rntl.get(head);
  return exported === USER_EVENT && rest.length === 1 && rest[0] === 'setup';
}

function bindResults(sf, ctx) {
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && isUserEventSetup(unwrap(node.initializer), ctx)) {
      ctx.userVars.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (init && ts.isCallExpression(init) && isAsyncRntlCall(init, ctx)) {
        if (ts.isIdentifier(node.name)) ctx.resultVars.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const prop = (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name);
            if (ts.isIdentifier(prop) && ASYNC_METHOD.test(prop.text) && ts.isIdentifier(el.name)) ctx.resultFns.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** A helper wraps RNTL when it is async and calls RNTL, or returns an RNTL call. Iterated to a fixpoint. */
function findHelpers(ctx) {
  let changed = true;
  const out = new Set();
  while (changed) {
    changed = false;
    for (const d of ctx.decls) {
      if (ctx.helpers.has(d.name)) continue;
      const fn = d.fn;
      const isAsync = !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      let wraps = false;
      if (fn.body && !ts.isBlock(fn.body)) {
        wraps = isAsyncRntlCall(unwrap(fn.body), ctx);
      } else if (fn.body) {
        const visit = (node) => {
          if (wraps) return;
          if (node !== fn && (ts.isFunctionLike(node))) return; // a nested callback is its own scope
          if (ts.isReturnStatement(node) && node.expression && isAsyncRntlCall(unwrap(node.expression), ctx)) wraps = true;
          if (isAsync && ts.isCallExpression(node) && isAsyncRntlCall(node, ctx)) wraps = true;
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(fn.body, visit);
      }
      if (wraps) {
        ctx.helpers.add(d.name);
        if (d.exported) out.add(d.name);
        changed = true;
      }
    }
  }
  return out;
}

function flag(sf, ctx, text) {
  const lines = text.split('\n');
  const found = [];
  const awaited = { n: 0 };
  const visit = (node) => {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(unwrap(node.expression)) && isAsyncRntlCall(unwrap(node.expression), ctx)) awaited.n++;
    if (ts.isExpressionStatement(node)) {
      let e = node.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isVoidExpression(e)) e = unwrap(e.expression);
      if (ts.isCallExpression(e) && isAsyncRntlCall(e, ctx)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const here = lines[line] ?? '';
        const above = lines[line - 1] ?? '';
        if (!OPT_OUT.test(here) && !OPT_OUT.test(above)) found.push({ line: line + 1, code: here.trim() });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { found, awaited: awaited.n };
}

function parse(name, text) {
  const kind = name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
}

/** Analyse a set of files together, so helpers exported from one test file count where they are imported. */
export function analyse(files) {
  const parsed = files.map(({ name, text }) => ({ name, text, sf: parse(name, text) }));
  for (const p of parsed) p.info = collect(p.sf);
  const byPath = new Map(parsed.map((p) => [p.name, p]));
  const exportedHelpers = new Map(); // file -> Set
  const resolveSpec = (from, spec) => {
    const base = resolve(dirname(from), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) if (byPath.has(c)) return c;
    return null;
  };
  // Helpers that import helpers settle over several passes, and how many depends
  // on the order files are read in. So this runs to a real fixpoint rather than
  // a fixed count: a fixed count silently misses a chain one hop longer than it,
  // read in the unlucky order. The cap exists only to fail loudly.
  for (let round = 0; ; round++) {
    let changed = false;
    for (const p of parsed) {
      const imported = [];
      for (const r of p.info.relImports) {
        const target = resolveSpec(p.name, r.spec);
        if (target && exportedHelpers.get(target)?.has(r.imported)) imported.push(r.local);
      }
      const ctx = makeCtx(p.info, imported);
      const prev = exportedHelpers.get(p.name);
      const next = findHelpers(ctx);
      if (!prev || prev.size !== next.size || [...next].some((n) => !prev.has(n))) changed = true;
      exportedHelpers.set(p.name, next);
      p.ctx = ctx;
    }
    if (!changed) break;
    if (round > 100) throw new Error('check-rntl-awaits: cross-file helper propagation did not converge in 100 passes');
  }
  const results = [];
  for (const p of parsed) {
    bindResults(p.sf, p.ctx);
    findHelpers(p.ctx);
    const { found, awaited } = flag(p.sf, p.ctx, p.text);
    results.push({ name: p.name, found, awaited, importsRntl: p.info.rntl.size > 0 || p.info.namespaces.size > 0 });
  }
  return results;
}

const SELF_TEST = [
  ['bare render', `import { render } from '${RNTL}';\ntest('x', async () => {\n  render(<A />);\n});`, [3]],
  ['bare fireEvent.press', `import { fireEvent, screen } from '${RNTL}';\ntest('x', async () => {\n  fireEvent.press(screen.getByText('a'));\n});`, [3]],
  ['bare fireEvent(el, ev)', `import { fireEvent } from '${RNTL}';\ntest('x', async () => {\n  fireEvent(el, 'press');\n});`, [3]],
  ['bare act', `import { act } from '${RNTL}';\ntest('x', async () => {\n  act(() => {});\n});`, [3]],
  ['bare waitFor', `import { waitFor } from '${RNTL}';\ntest('x', async () => {\n  waitFor(() => expect(1).toBe(1));\n});`, [3]],
  ['destructured rerender', `import { render } from '${RNTL}';\ntest('x', async () => {\n  const { rerender, unmount } = await render(<A />);\n  rerender(<B />);\n  unmount();\n});`, [4, 5]],
  ['result variable', `import { render } from '${RNTL}';\ntest('x', async () => {\n  const view = await render(<A />);\n  view.unmount();\n});`, [4]],
  ['screen.unmount and findBy', `import { screen } from '${RNTL}';\ntest('x', async () => {\n  screen.unmount();\n  screen.findByText('a');\n});`, [3, 4]],
  ['local helper that returns render', `import { render } from '${RNTL}';\nfunction mount() { return render(<A />); }\ntest('x', async () => {\n  mount();\n});`, [4]],
  ['async arrow helper, and a helper calling it', `import { fireEvent } from '${RNTL}';\nconst tap = async (el) => { fireEvent.press(el); };\nasync function tapTwice(el) { await tap(el); await tap(el); }\ntest('x', async () => {\n  tapTwice(el);\n});`, [2, 5]],
  ['an unawaited userEvent session method', `import { userEvent } from '${RNTL}';\ntest('x', async () => {\n  const user = userEvent.setup();\n  user.press(el);\n  await user.type(el, 'a');\n});`, [4]],
  ['a direct userEvent call, but not setup', `import { userEvent } from '${RNTL}';\ntest('x', async () => {\n  userEvent.setup();\n  userEvent.press(el);\n});`, [4]],
  ['void does not escape', `import { fireEvent } from '${RNTL}';\ntest('x', async () => {\n  void fireEvent.press(el);\n});`, [3]],
  ['awaited, returned and assigned are fine', `import { render, fireEvent, act } from '${RNTL}';\ntest('x', async () => {\n  await render(<A />);\n  await fireEvent.press(el);\n  const p = act(() => {});\n  await p;\n  return waitForIt();\n});\nfunction waitForIt() { return 1; }`, []],
  ["the app's own never-settling promise is left alone", `import { shareCard } from '../shareCard';\nit('does not release before shareAsync settles', async () => {\n  shareAsync.mockReturnValue(new Promise(() => {}));\n  shareCard({ current: {} } as never);\n});`, []],
  ['namespace import', `import * as RNTL from '${RNTL}';\ntest('x', async () => {\n  RNTL.fireEvent.press(el);\n  await RNTL.render(<A />);\n});`, [3]],
  ["a same-named function that is not RNTL's", `import { render } from './myRenderer';\ntest('x', () => {\n  render(tree);\n});`, []],
  ['escape hatch with a reason, on the line or above', `import { fireEvent } from '${RNTL}';\ntest('x', async () => {\n  // rntl-await-ok: two presses in one tick prove the double-tap guard\n  fireEvent.press(a);\n  fireEvent.press(b); // rntl-await-ok: same tick as the one above\n});`, []],
  ['a marker with no reason is not an escape', `import { fireEvent } from '${RNTL}';\ntest('x', async () => {\n  fireEvent.press(a); // rntl-await-ok:\n});`, [3]],
  ['a non-async helper that only presses is flagged inside, not at its call', `import { fireEvent } from '${RNTL}';\nfunction press(el) { fireEvent.press(el); }\ntest('x', async () => {\n  press(el);\n});`, [2]],
];

/** A four-hop helper chain across files, handed over dependents-first: the order a fixed pass count gets wrong. */
const CHAIN = [
  ['/selftest/chain/t.test.tsx', `import { d } from './d';\ntest('x', async () => {\n  d();\n});`],
  ['/selftest/chain/d.ts', `import { c } from './c';\nexport async function d() { await c(); }`],
  ['/selftest/chain/c.ts', `import { b } from './b';\nexport async function c() { await b(); }`],
  ['/selftest/chain/b.ts', `import { a } from './a';\nexport async function b() { await a(); }`],
  ['/selftest/chain/a.ts', `import { render } from '${RNTL}';\nexport function a() { return render(tree); }`],
];

function selfTest() {
  const wrong = [];
  const chain = analyse(CHAIN.map(([name, text]) => ({ name, text })));
  const flagged = chain.find((r) => r.name.endsWith('t.test.tsx')).found.map((f) => f.line);
  if (JSON.stringify(flagged) !== '[3]') wrong.push(`  four-hop cross-file chain, read dependents-first: expected lines [3], flagged ${JSON.stringify(flagged)}`);
  for (const [label, src, expected] of SELF_TEST) {
    const [r] = analyse([{ name: `/selftest/${label.replace(/\W+/g, '_')}.test.tsx`, text: src }]);
    const got = r.found.map((f) => f.line);
    if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`  ${label}: expected lines ${JSON.stringify(expected)}, flagged ${JSON.stringify(got)}`);
  }
  return wrong;
}

function testFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.') || ent.name === 'ios' || ent.name === 'android') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) testFiles(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name) && (p.includes(`${'/'}__tests__${'/'}`) || /\.test\.(ts|tsx)$/.test(ent.name))) out.push(p);
  }
  return out;
}

function main() {
  const wrong = selfTest();
  if (wrong.length) {
    console.error(`check-rntl-awaits: the self-test disagrees with itself, so the scan is not trustworthy:\n${wrong.join('\n')}`);
    process.exit(1);
  }
  if (!existsSync(MOBILE)) {
    console.error('check-rntl-awaits: apps/mobile not found');
    process.exit(1);
  }
  const paths = testFiles(MOBILE);
  const results = analyse(paths.map((p) => ({ name: p, text: readFileSync(p, 'utf8') })));
  const rntlFiles = results.filter((r) => r.importsRntl).length;
  const awaited = results.reduce((n, r) => n + r.awaited, 0);
  // Positive control on the real tree: a scan that recognised no RNTL call at
  // all has stopped reading RNTL, not proven there is nothing to find.
  if (rntlFiles === 0 || awaited === 0) {
    console.error(`check-rntl-awaits: scanned ${paths.length} test files and recognised ${awaited} awaited RNTL calls in ${rntlFiles} RNTL files. That is the scan failing, not a clean tree.`);
    process.exit(1);
  }
  const bad = results.flatMap((r) => r.found.map((f) => `  ${relative(ROOT, r.name)}:${f.line}  ${f.code}`));
  if (bad.length) {
    console.error(
      `check-rntl-awaits: ${bad.length} unawaited RNTL 14 call(s). Each drops a promise, so the next assertion can run before the state it checks is committed:\n${bad.join('\n')}\n\n` +
        `Await it. If dropping it is the point (two presses in one tick), put \`// rntl-await-ok: <why>\` on that line or the one above. \`void\` is not enough.`,
    );
    process.exit(1);
  }
  console.log(`check-rntl-awaits: ${SELF_TEST.length + 1} self-test cases agree; ${paths.length} test files, ${rntlFiles} import RNTL, ${awaited} awaited RNTL calls, 0 unawaited`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
