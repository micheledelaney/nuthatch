import type { FmObject } from "@/types/ddr";
import { child, displayText, isRecord, textAttr, withoutKey } from "../xmlUtils";

/**
 * A <Theme> names itself with a reverse-DNS id (`com.filemaker.theme.apex_blue`);
 * its friendly label lives in the `Display` attribute, so prefer that. The theme
 * also embeds a base64 preview <Image> that displayText would otherwise pull into
 * the searchable body — reset the text to the names so the model stays lean. The
 * useful design metadata (color scheme, swatch palette, base font size) lives
 * nested under <Metadata>; lift it so the inspector shows what the theme looks
 * like rather than just version/locale bookkeeping.
 */
export function annotateTheme(node: Record<string, unknown>, obj: FmObject): FmObject {
  const display = textAttr(node, "Display");
  const name = display || obj.name;
  // Now the object's title; don't repeat it as a raw property row.
  const attributes = display ? withoutKey(obj.attributes, "Display") : obj.attributes;
  return {
    ...obj,
    name,
    text: [name, obj.name].filter(Boolean).join(" "),
    attributes: { ...attributes, ...themeMetadata(child(node, "Metadata")) },
  };
}

function themeMetadata(metadata: unknown): Record<string, string> {
  if (!isRecord(metadata)) return {};
  const a: Record<string, string> = {};
  // colorScheme sits at the metadata root or under <charting>.
  const scheme =
    displayText(metadata["colorScheme"]) ||
    displayText(isRecord(metadata["charting"]) ? metadata["charting"]["colorScheme"] : undefined);
  if (scheme) a.colorScheme = scheme;
  const baseFont = displayText(isRecord(metadata["layoutbuilder"]) ? metadata["layoutbuilder"]["kBaseFontSize"] : undefined);
  if (baseFont) a.baseFontSize = baseFont;
  // The palette is <swatch1>..<swatchN> hex values; keep them in swatch order.
  const palette = child(metadata, "colorpalette");
  if (isRecord(palette)) {
    const swatches = Object.keys(palette)
      .filter((k) => /^swatch\d+$/.test(k))
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
      .map((k) => displayText(palette[k]))
      .filter(Boolean);
    if (swatches.length) a.palette = swatches.join(" ");
  }
  return a;
}
