import { XMLParser } from "fast-xml-parser";
import { ATTR_PREFIX } from "./xmlUtils";

/** The one parser configuration every FMSaveAsXML document (and each streamed
 * layout) is read with. */
export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Large FileMaker exports contain thousands of character entities in calc
  // text; we treat text verbatim, so skip entity expansion (faster, and avoids
  // the parser's billion-laughs guard tripping on legitimate large files).
  processEntities: false,
});
