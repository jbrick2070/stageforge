import { XMLBuilder, XMLParser } from 'fast-xml-parser';

/**
 * Guarded XML for MVR/GDTF. Uses fast-xml-parser (MIT, no DOM) so the same code runs in the
 * browser, the sandboxed Electron renderer and Node tests. Untrusted archives are common, so
 * DTDs are rejected, entities are not expanded and every document has size, depth and element caps.
 */

export const MAX_XML_BYTES = 32 * 1024 * 1024;
export const MAX_XML_DEPTH = 64;
export const MAX_XML_ELEMENTS = 500_000;

export type XmlNode = Record<string, unknown>;

/** Elements that may repeat; they always parse as arrays so readers need no special cases. */
const LISTS = new Set([
  'Layer', 'Fixture', 'Truss', 'VideoScreen', 'SceneObject', 'FocusPoint', 'GroupObject', 'Support', 'Projector',
  'Address', 'Geometry3D', 'Symbol', 'Symdef', 'Data', 'Class', 'Position', 'Source', 'Mapping', 'MappingDefinition', 'Connection',
  'CustomCommand', 'Overwrite', 'Alignment', 'Protocol',
  'DMXMode', 'DMXChannel', 'LogicalChannel', 'ChannelFunction', 'ChannelSet', 'Attribute', 'FeatureGroup', 'Feature',
  'ActivationGroup', 'Geometry', 'Axis', 'Beam', 'Laser', 'Display', 'Model', 'Revision', 'GeometryReference', 'Break',
  'Wheel', 'WheelSlot', 'Emitter', 'ColorSpace',
]);

/** Strip XML 1.0 illegal control characters (C0 except TAB/LF/CR, plus U+FFFE/U+FFFF). */
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

/**
 * Strip leading UTF-8 BOM, trailing NUL bytes, and NUL bytes inside XML text/attribute values
 * in O(N). Rejects UTF-16 payloads decoded as UTF-8 and NULs embedded inside tag/attribute names.
 */
export function stripXmlBomAndTrailingNuls(source: string): string {
  if (source.charCodeAt(0) === 0xfffe) {
    throw new Error('UTF-16 XML documents are not supported; save as UTF-8.');
  }
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let end = source.length;
  while (end > start && source.charCodeAt(end - 1) === 0) end--;
  const trimmed = (start === 0 && end === source.length ? source : source.slice(start, end)).trimEnd();
  if (trimmed.indexOf('\u0000') < 0) return trimmed;
  // Detect UTF-16LE/BE XML decoded as UTF-8 (interleaved NUL bytes throughout the header).
  const sampleEnd = Math.min(trimmed.length, 256);
  let nuls = 0;
  let nonNuls = 0;
  for (let i = 0; i < sampleEnd; i++) {
    if (trimmed.charCodeAt(i) === 0) nuls++;
    else nonNuls++;
  }
  if (nonNuls > 0 && nuls >= Math.min(4, nonNuls) && nuls / (nuls + nonNuls) >= 0.25) {
    throw new Error('UTF-16 XML documents are not supported; save as UTF-8.');
  }
  let out = '';
  let inTag = false;
  let quote = 0;
  let chunkStart = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed.charCodeAt(i);
    if (ch === 0) {
      if (inTag && !quote) throw new Error('Invalid XML document.');
      if (i > chunkStart) out += trimmed.slice(chunkStart, i);
      chunkStart = i + 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = 0;
    } else if (inTag) {
      if (ch === 34 /* '"' */ || ch === 39 /* "'" */) quote = ch;
      else if (ch === 62 /* '>' */) inTag = false;
    } else if (ch === 60 /* '<' */) {
      if (trimmed.startsWith('<!--', i)) {
        const endComment = trimmed.indexOf('-->', i + 4);
        if (endComment >= 0) {
          out += trimmed.slice(chunkStart, endComment + 3).replaceAll('\u0000', '');
          chunkStart = endComment + 3;
          i = endComment + 2;
          continue;
        }
      } else if (trimmed.startsWith('<![CDATA[', i)) {
        const endCdata = trimmed.indexOf(']]>', i + 9);
        if (endCdata >= 0) {
          out += trimmed.slice(chunkStart, endCdata + 3).replaceAll('\u0000', '');
          chunkStart = endCdata + 3;
          i = endCdata + 2;
          continue;
        }
      }
      inTag = true;
    }
  }
  if (chunkStart < trimmed.length) out += trimmed.slice(chunkStart);
  return out;
}

/**
 * Fast linear pre-scan to cap XML nesting depth and total element count before the recursive
 * parser builds JS objects. Ignores comments, CDATA, processing instructions and attribute quotes.
 */
function checkXmlComplexity(text: string, maxDepth = MAX_XML_DEPTH, maxElements = MAX_XML_ELEMENTS): void {
  let depth = 0;
  let elements = 0;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) !== 60 /* '<' */) continue;
    const next = text.charCodeAt(i + 1);
    if (next === 33 /* '!' */) {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end < 0) throw new Error('Invalid XML document.');
        i = end + 2;
      } else if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9);
        if (end < 0) throw new Error('Invalid XML document.');
        i = end + 2;
      }
      continue;
    }
    if (next === 63 /* '?' */) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) throw new Error('Invalid XML document.');
      i = end + 1;
      continue;
    }
    const closing = next === 47 /* '/' */;
    // Advance to the matching '>' while skipping quoted attribute values.
    let j = i + (closing ? 2 : 1);
    let quote = 0;
    while (j < len) {
      const ch = text.charCodeAt(j);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 /* '"' */ || ch === 39 /* "'" */) {
        quote = ch;
      } else if (ch === 62 /* '>' */) {
        break;
      }
      j++;
    }
    if (j >= len) throw new Error('Invalid XML document.');
    if (closing) {
      depth = Math.max(0, depth - 1);
    } else {
      if (++elements > maxElements) throw new Error('This XML document has too many elements.');
      const selfClosing = text.charCodeAt(j - 1) === 47 /* '/' */;
      if (!selfClosing && ++depth > maxDepth) {
        throw new Error(`This XML document is nested more than ${maxDepth} levels deep.`);
      }
    }
    i = j;
  }
}

export interface ParseXmlLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxElements?: number;
}

export function parseXml(source: string, limits?: ParseXmlLimits): XmlNode {
  const maxBytes = Math.min(MAX_XML_BYTES, limits?.maxBytes ?? MAX_XML_BYTES);
  const maxDepth = Math.min(MAX_XML_DEPTH, limits?.maxDepth ?? MAX_XML_DEPTH);
  const maxElements = Math.min(MAX_XML_ELEMENTS, limits?.maxElements ?? MAX_XML_ELEMENTS);
  // Fast-fail before scanning or encoding if the raw string cannot possibly fit under the byte cap
  // (UTF-16 code units <= UTF-8 bytes for ASCII, and 1 UTF-16 unit >= 1 UTF-8 byte except surrogates
  // where 2 units = 4 bytes, so source.length > maxBytes * 2 is always over the cap).
  if (source.length > maxBytes * 2) throw new Error('This XML document is too large.');
  // Real-world MA library files can end with NUL bytes after the closing tag.
  const text = stripXmlBomAndTrailingNuls(source);
  if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
    throw new Error('This XML document is too large.');
  }
  // Reject a DTD anywhere, even inside a comment or CDATA: stripping those first can be fooled by
  // overlapping sections, and real MVR and GDTF files never mention a DTD.
  if (/<!(DOCTYPE|ENTITY)/i.test(text)) throw new Error('XML documents with a DTD are unsupported.');
  checkXmlComplexity(text, maxDepth, maxElements);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    parseTagValue: false,
    // Only the predefined XML entities and character references decode: DTDs (and so custom
    // or recursive entities) are rejected above.
    processEntities: true,
    htmlEntities: false,
    trimValues: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    isArray: (name) => LISTS.has(name),
  });
  let doc: unknown;
  try {
    doc = parser.parse(text, true);
  } catch {
    throw new Error('Invalid XML document.');
  }
  if (!doc || typeof doc !== 'object') throw new Error('Invalid XML document.');
  return doc as XmlNode;
}

const BUILDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
  processEntities: true,
};

export function buildXml(root: XmlNode): string {
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n' + builder.build(root);
  return xml.replace(ILLEGAL_XML_CHARS, '');
}

/** Serialize a single parsed element node into a clean standalone XML fragment (no XML declaration). */
export function buildXmlFragment(tag: string, node: unknown): string {
  const builder = new XMLBuilder({ ...BUILDER_OPTIONS, format: false });
  return builder.build({ [tag]: node }).replace(ILLEGAL_XML_CHARS, '').trim();
}

/** Read a child list regardless of whether the parser produced one item or many. */
export function list(node: unknown, key: string): XmlNode[] {
  if (!node || typeof node !== 'object') return [];
  const value = (node as XmlNode)[key];
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).filter((v): v is XmlNode => !!v && typeof v === 'object');
}

export function child(node: unknown, key: string): XmlNode | undefined {
  return list(node, key)[0];
}

export function attr(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const value = (node as XmlNode)['@_' + key];
  const raw = typeof value === 'string' ? value : value === undefined ? undefined : String(value);
  return raw === undefined ? undefined : raw.replace(ILLEGAL_XML_CHARS, '');
}

/** Text content of a simple element such as <GDTFSpec>file.gdtf</GDTFSpec>. */
export function text(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const value = (node as XmlNode)[key];
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null) return undefined;
  if (typeof first === 'object') {
    const inner = (first as XmlNode)['#text'];
    return inner === undefined ? undefined : String(inner).replace(ILLEGAL_XML_CHARS, '');
  }
  return String(first).replace(ILLEGAL_XML_CHARS, '');
}
