import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";

type Activate = (e: MouseEvent | KeyboardEvent) => void;

interface PressableOptions {
  /** Open/closed, for a header that toggles a section. */
  expanded?: boolean;
  /** The selected item of a list. */
  current?: boolean;
  /** Not clickable right now: no role, no tab stop. */
  inert?: boolean;
}

/** Whether a key press on `e` should act as a click on the element itself
 * (not on something inside it that handles its own keys). */
function isActivation(e: KeyboardEvent): boolean {
  return e.target === e.currentTarget && (e.key === "Enter" || e.key === " ");
}

/** Props that make a non-button element (a row, a header) work from the
 * keyboard: a tab stop that Enter and Space activate, with the open/selected
 * state announced. */
export function pressable(onActivate: Activate, options: PressableOptions = {}) {
  if (options.inert) return {};
  return { ...keyPressable(onActivate, options), onClick: onActivate };
}

/** Like pressable, for an element inside a row that already handles the
 * mouse click: adds only the tab stop and the key activation. */
export function keyPressable(onActivate: Activate, options: PressableOptions = {}) {
  if (options.inert) return {};
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-expanded": options.expanded,
    "aria-current": options.current ? ("true" as const) : undefined,
    onKeyDown: (e: KeyboardEvent) => {
      if (!isActivation(e)) return;
      e.preventDefault();
      onActivate(e);
    },
  };
}

/** Arrow / Home / End move between the tabs of a tab strip and select the
 * one they land on. Put on the `role="tablist"` element. */
export function onTabListKeyDown(e: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')];
  const index = tabs.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  const last = tabs.length - 1;
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowRight" ? (index + 1) % tabs.length : (index + last) % tabs.length;
  const target = tabs[next];
  e.preventDefault();
  target?.focus();
  target?.click();
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** For a modal: keeps Tab inside it, puts focus in it when it opens (unless
 * something inside already took it), and gives focus back to whatever had it
 * before when it closes. Attach the returned ref to the dialog element. */
export function useModalFocus<T extends HTMLElement>(active = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) focusableIn(root)[0]?.focus();
    // Capture phase: some dialogs stop key events from bubbling.
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== "Tab" || !el) return;
      const items = focusableIn(el);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return e.preventDefault();
      const outside = !el.contains(document.activeElement);
      if (e.shiftKey && (outside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [active]);
  return ref;
}
