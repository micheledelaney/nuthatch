import { createContext } from "react";

/**
 * Lets a workbench pane take over navigation for the ObjectPage inside it.
 * When provided, ObjectPage routes every reference click through this instead
 * of the store's `navigateFrom`, so the pane decides whether the click
 * navigates in place or (⇧-click) opens in the other pane.
 */
export const PaneNavContext = createContext<((uid: string, rowKey: string) => void) | null>(null);
