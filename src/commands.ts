import get from "lodash/get";
import { Chainable, Dictionary } from ".";
import { canonicalize, lex } from "./parser";
import { instantiate } from "./variables";

declare var cy: Chainable;

/**
 * Anything that can be evaluated by evalMacros: strings, arrays of strings,
 * matrices of strings, etc up to infinite dimension.
 */
export type Evaluatable = string | Evaluatables;
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface Evaluatables extends Array<Evaluatable> {}

/**
 * Ways to alter the behavior of macro evaluation.
 */
interface EvalOptions {
  /**
   * If true, all strings are evaluated as macro expressions even
   * if they are not surrounded by braces (but strings containing
   * braces are still tolerated).
   */
  force?: boolean;
  /**
   * If true, strings consisting entirely of a macro expression
   * (including bare strings, with force:true) are not converted
   * to strings during evaluation; rather, they are replaced
   * by the bare JavaScript object resulting from the evaluation.
   */
  raw?: boolean;
}

/**
 * Test whether an Evaluatable can be map'd, forEach'd, etc.
 */
function isSequence(input: Evaluatable): input is string[] {
  return Array.isArray(input);
}

/**
 * Test whether a string consists entirely of a macro expression.
 */
const isExpr = (input: string) => input.startsWith("{");

/**
 * Recursively lex all strings in an Evaluatable, adding every distinct macro
 * expression encountered to a map of string-to-boolean. The expressions are
 * not canonicalized, manipulated or deduplicated; they appear in the same
 * order as in the input.
 *
 * If force is true, then lexing is skipped, i.e. then every string is
 * assumed to be a macro expression in its entirety even if it does not
 * contain surrounding curly braces.
 */
function findMacros(
  input: Evaluatable,
  macros: string[],
  force: boolean = false
) {
  if (isSequence(input)) {
    input.forEach(elem => findMacros(elem, macros, force));
  } else if (typeof input === "string") {
    if (force && !isExpr(input)) macros.push(input);
    lex(input, {
      onMacro: (expr: string) => macros.push(expr)
    });
  } else {
    throw new Error(
      `cypress-macros: cannot findMacros in a(n) '${typeof input}'`
    );
  }

  return macros;
}

/**
 * Given a dictionary of Cypress variables and another of macro variables,
 * replace all macro expressions with their evaluated value.
 *
 * @todo convert this function into an instantiable class to remove constants (cvars/mvars/force/raw) from call interface
 */
function replaceMacros(
  input: Evaluatable,
  cvars: Dictionary,
  mvars: Dictionary,
  force: boolean,
  raw: boolean
): any {
  if (isSequence(input)) {
    return input.map(elem => replaceMacros(elem, cvars, mvars, force, raw));
  } else if (typeof input === "string") {
    const fragments = new Array<string>();

    const onMacro = (expr: string) => {
      const [prefix, ...path] = expr.split(".");
      const name = canonicalize(prefix);
      let value = name.startsWith("$") ? mvars[name] : cvars[name];
      if (path.length > 0) value = get(value, path);
      fragments.push(value);
    };

    if (force && !isExpr(input)) onMacro(input);
    else
      lex(input, {
        onMacro,
        onText: (text: string) => fragments.push(text)
      });

    if (raw && fragments.length === 1) return fragments[0];
    return fragments.join("");
  }
  throw new Error(
    `cypress-macros: cannot findMacros in a(n) '${typeof input}'`
  );
}

/**
 * Call cy.get on each element of names; resolve with a lookup table that maps
 * each name to its value. The list is non deduplicated; if a name appears
 * more than once, it will be gotten multiple times (which is probably
 * useless).
 *
 * This method is error prone and cannot deal with macro variables, compound
 * expressions and numerous other cases; it will be removed. Please use
 * `evalMacros()` with `{force:true, raw:true}` as a replacement for this
 * command.
 *
 * @deprecated will be removed in 2.0
 */
export function getAllByName(names: string[]): Chainable {
  let chain = cy;
  const values = {};
  names.forEach(name => {
    chain = chain
      .get(name, { log: false })
      .then(value => (values[name] = value));
  });
  return chain.then(() => values);
}

/**
 * Replace all macro expressions in the input with their values; resolve
 * with a copy of input where all macros have been replaced.
 *
 * Input may be a simple string, or a string array of any dimension
 * (e.g. string[], string[][], and so forth).
 *
 * @see EvalOptions for information on options.
 *
 * @example interpolate macros into a string
 *   cy.evalMacros('Hello, {user.name}') # => 'Hello, Alice'
 *
 * @example evaluate whole macro expressions as strings
 *   cy.evalMacros(['user.name', 'user.age'], {force:true}) # => ['Alice', '12']
 *
 * @example evaluate whole expressions as JavaScript values
 *   cy.evalMacros(['user.name', 'user.age'], {force:true, raw:true}) # => ['Alice', 12]
 */
export function evalMacros(
  input: Evaluatable,
  options: EvalOptions = {}
): Chainable {
  const force = options.force || false;
  const raw = options.raw || false;

  const macros = new Array<string>();
  findMacros(input, macros, force);

  const prefixes = {};
  macros.forEach(macro => {
    const dot = macro.indexOf(".");
    const prefix = canonicalize(dot > 0 ? macro.slice(0, dot) : macro);
    prefixes[prefix] = true;
  });

  const cvarNames = Object.keys(prefixes).filter(k => k.startsWith("@"));

  return getAllByName(cvarNames).then((cvars: Dictionary) => {
    const mvars = instantiate();
    return replaceMacros(input, cvars, mvars, force, raw);
  });
}