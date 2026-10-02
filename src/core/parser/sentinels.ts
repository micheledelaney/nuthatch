/**
 * Placeholder names FileMaker writes where a reference can no longer reach its
 * target, and the sentinel id the parser records for the resulting broken edge.
 */

/** How FileMaker renders a target it can no longer resolve (a deleted script,
 * layout, data source, …) — and the name the parser gives such a target. */
export const UNKNOWN_TARGET = "<unknown>";

/** Left in rendered text (calcs, step parameters, labels) where a field was deleted. */
export const MISSING_FIELD_TOKEN = "<Field Missing>";

/** Left in rendered text where a table occurrence was deleted. */
export const MISSING_TABLE_TOKEN = "<Table Missing>";

/** Left in calculation text where a custom function was deleted. */
export const MISSING_FUNCTION_TOKEN = "<Function Missing>";

/** Sentinel `toId` for a broken edge whose target no longer exists. */
export const MISSING_REF_ID = "<missing>";

/** The built-in menu set a layout uses unless it names its own. */
export const FILE_DEFAULT_MENU_SET = "[File Default]";

/** Built-in menu-set names that aren't objects in the file's catalog. */
export const PSEUDO_MENU_SETS: ReadonlySet<string> = new Set([FILE_DEFAULT_MENU_SET, "[Standard FileMaker Menus]"]);
