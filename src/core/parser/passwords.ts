/**
 * Passwords never reach the parse result. FileMaker writes one into an export
 * in the clear wherever a developer typed it: a step's password (Re-Login, Add
 * Account, Reset Account Password, Change Password, Send Mail's SMTP one), both
 * in the step's XML (`<Parameter type="Password">`, `<SMTP><Password>`) and in
 * its rendered StepText. What's cut is the typed text of the password's
 * formula — its string literals and comments, or the whole of a bare number —
 * so its code stays: `Password: $pw` shows as is. The auto-login password and
 * an account's stored one aren't formulas, and are left out whole.
 *
 * Only what's kept is cut: the reference passes still read the full text while
 * a file is parsed.
 */
import { inertSpans } from "./calcLiterals";

/** What shows in place of a password's typed text: Nuthatch left it out, and
 * it's still in the FileMaker file. */
export const PASSWORD_NOT_STORED = "‹not stored by Nuthatch›";

/** The elements that hold a password: a step's (Send Mail's SMTP one, a
 * formula), the auto-login one, an account's stored one. */
export const PASSWORD_ELEMENTS: ReadonlySet<string> = new Set(["Password", "PasswordEncrypted", "INSECURE_PASSWORD"]);

/** Whether a `<Parameter type>` is a step's password (Re-Login's, Add
 * Account's …). */
export function isPasswordParameterType(type: unknown): boolean {
  return typeof type === "string" && /password/i.test(type);
}

/** A formula that is nothing but a number: a password typed as digits. */
const BARE_NUMBER_RE = /^\s*\d+(?:\.\d+)?\s*$/;

/**
 * `text` with the typed text of each password formula replaced by
 * PASSWORD_NOT_STORED: matched as written, and as a step's rendered text shows
 * it (a line break as a newline, any other control character as a space). An
 * empty literal holds nothing, and is left as it is.
 */
export function withoutPasswordText(text: string, formulas: readonly string[]): string {
  const spans = new Set(formulas.flatMap((formula) => (BARE_NUMBER_RE.test(formula) ? [formula.trim()] : inertSpans(formula))));
  spans.delete('""');
  let out = text;
  // Longest first: a comment can hold a literal that's also typed on its own.
  for (const span of [...spans].sort((a, b) => b.length - a.length)) {
    for (const form of new Set([span, span.replace(/\r\n?/g, "\n"), span.replace(/[\0-\t\v-\x1f]/g, " ")])) {
      out = out.split(form).join(PASSWORD_NOT_STORED);
    }
  }
  return out;
}
