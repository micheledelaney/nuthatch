import type { FmFile, FmObject, LayoutTriggerInfo } from "@/types/ddr";
import type { FileParse } from "../context";
import { attr, child, displayText, isRecord, textAttr } from "../xmlUtils";
import { objectUid } from "../uid";
import { scanRefs } from "../refs/scanRefs";
import { newObject } from "./catalogItems";
import { scriptTriggers } from "./common";

/** On/off file options in <Metadata>: [element, its True/False attribute, attribute key]. */
const FILE_OPTION_FLAGS: ReadonlyArray<readonly [string, string, string]> = [
  // File Options ▸ Open.
  ["SavePassword", "keychain", "allowStoredCredentials"],
  ["SavePassword", "requireMobile", "requirePasscode"],
  ["ShowSignInFields", "enable", "showSignInFields"],
  // Sharing settings: the file is left out of these file lists.
  ["HideClientSharing", "enable", "hiddenInLaunchCenter"],
  ["HideWebDirectSharing", "enable", "hiddenOnWebDirectHomepage"],
];

/** The object standing for the file itself: its File Options, file-access
 * settings, default menu set, and its own script triggers. */
export function makeFileObject(file: FmFile, containerNode: unknown, metadata: unknown): FmObject {
  const { attributes, triggers } = fileMetadata(metadata);
  return newObject(file, {
    uid: objectUid(file.uid, "file", file.uid),
    type: "file",
    id: file.uid,
    name: file.name,
    attributes: { ...attributes, ...fileAccessOptions(containerNode), ...defaultMenuSet(containerNode) },
    text: file.name,
    ...(triggers.length ? { detail: { kind: "file", triggers } } : {}),
  });
}

/**
 * File-level dependencies (script triggers, default layout, menu set) live in
 * the <Metadata> block, scanned against the file object itself — so a trigger
 * parameter's calc references resolve too. The file's default menu set sits in
 * the menu-set catalog, not <Metadata> (see defaultMenuSet); "[Standard
 * FileMaker Menus]" is skipped as a pseudo set.
 */
export function addFileRefs(fp: FileParse, containerNode: Record<string, unknown>, metadata: unknown): void {
  scanRefs(fp, metadata, fp.fileObject);
  const menuSetCatalog = containerNode["CustomMenuSetCatalog"];
  if (isRecord(menuSetCatalog) && menuSetCatalog["CustomMenuSetReference"] != null) {
    scanRefs(fp, { CustomMenuSetReference: menuSetCatalog["CustomMenuSetReference"] }, fp.fileObject);
  }
}

function yesNo(value: string): string {
  return value === "True" ? "Yes" : "No";
}

/**
 * File Options, from the <Metadata><AddAction> block beside <Structure>: the
 * file's own script triggers, plus the high-signal scalar options (auto-login
 * account, encryption, minimum version, stored credentials, sharing visibility)
 * lifted into `attributes` for display. The trigger script references are
 * wired separately by scanning this block (addFileRefs).
 */
function fileMetadata(metadata: unknown): { attributes: Record<string, string>; triggers: LayoutTriggerInfo[] } {
  const add = child(metadata, "AddAction");
  const attributes: Record<string, string> = {};
  if (isRecord(add)) {
    // Auto-login: the file opens straight into this account, no sign-in dialog.
    // The account lives under <AccountName> (older export) or <UserName> (newer).
    // Read only the account, never the sibling password the DDR stores in clear.
    const login = child(add, "Login");
    if (isRecord(login)) {
      const account = displayText(login["AccountName"]) || displayText(login["UserName"]);
      attributes.autoLogin = account ? `Account “${account}”` : "Guest account";
    }
    // Encryption at rest: type 0 means none.
    const encryption = attr(child(add, "Encryption"), "type");
    if (encryption != null) attributes.encryption = encryption === "0" ? "None" : "Enabled";
    // Minimum FileMaker version allowed to open the file.
    const minVersion = attr(child(add, "Minimum"), "version");
    if (minVersion) attributes.minimumVersion = minVersion;
    // Sign-in and sharing switches (absent from some exports, so only set when present).
    for (const [element, flag, key] of FILE_OPTION_FLAGS) {
      const value = attr(child(add, element), flag);
      if (value != null) attributes[key] = yesNo(value);
    }
  }
  return { attributes, triggers: scriptTriggers(isRecord(add) ? add["ScriptTriggers"] : undefined) };
}

/**
 * Manage Security ▸ File Access: whether other files need authorization to
 * reference this one, and whether authorized files must share its host. Both
 * are attributes of the <FileAccessCatalog> itself (in <Structure>), not of the
 * authorized-file entries under it.
 */
function fileAccessOptions(containerNode: unknown): Record<string, string> {
  const catalog = child(containerNode, "FileAccessCatalog");
  const required = attr(catalog, "required");
  const sameHost = attr(catalog, "sameHost");
  return {
    ...(required != null ? { requireFileAuthorization: yesNo(required) } : {}),
    ...(sameHost != null ? { authorizedFilesSameHost: yesNo(sameHost) } : {}),
  };
}

/**
 * The file's default menu set (Manage ▸ Custom Menus ▸ "Default menu set for
 * this file"): a <CustomMenuSetReference> directly under <CustomMenuSetCatalog>
 * (in <Structure>), beside the menu sets themselves.
 */
function defaultMenuSet(containerNode: unknown): Record<string, string> {
  const name = textAttr(child(child(containerNode, "CustomMenuSetCatalog"), "CustomMenuSetReference"), "name");
  return name ? { defaultMenuSet: name } : {};
}
