import { XMLBuilder, XMLParser } from 'fast-xml-parser';

/**
 * Guarded XML for MVR/GDTF. Uses fast-xml-parser (MIT, no DOM) so the same code runs in the
 * browser, the sandboxed Electron renderer and Node tests. Untrusted archives are common, so
 * DTDs are rejected, entities are not expanded and every document has a size cap.
 */

export const MAX_XML_BYTES = 32 * 1024 * 1024;

export type XmlNode = Record<string, unknown>;

/** Elements that may repeat; they always parse as arrays so readers need no special cases. */
const LISTS = new Set([
  'Layer', 'Fixture', 'Truss', 'VideoScreen', 'SceneObject', 'FocusPoint', 'GroupObject', 'Support', 'Projector',
  'Address', 'Geometry3D', 'Symbol', 'Symdef', 'Data', 'Class', 'Position', 'Source', 'Mapping', 'Connection',
  'DMXMode', 'DMXChannel', 'LogicalChannel', 'ChannelFunction', 'ChannelSet', 'Attribute', 'FeatureGroup', 'Feature',
  'ActivationGroup', 'Geometry', 'Axis', 'Beam', 'Model', 'Revision', 'GeometryReference', 'Break', 'Wheel',
]);

export function parseXml(source: string): XmlNode {
  // Real-world MA library files can end with NUL bytes after the closing tag.
  const text = source.replace(/^﻿/, '').replace(/\u0000+$/g, '').trimEnd();
  if (new TextEncoder().encode(text).length > MAX_XML_BYTES) throw new Error('This XML document is too large.');
  // Reject a DTD anywhere, even inside a comment or CDATA: stripping those first can be fooled by
  // overlapping sections, and real MVR and GDTF files never mention a DTD.
  if (/<!(DOCTYPE|ENTITY)/i.test(text)) throw new Error('XML documents with a DTD are unsupported.');
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
  const doc = parser.parse(text, true) as XmlNode;
  if (!doc || typeof doc !== 'object') throw new Error('Invalid XML document.');
  return doc;
}

export function buildXml(root: XmlNode): string {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
    processEntities: true,
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n' + builder.build(root);
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
  return typeof value === 'string' ? value : value === undefined ? undefined : String(value);
}

/** Text content of a simple element such as <GDTFSpec>file.gdtf</GDTFSpec>. */
export function text(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const value = (node as XmlNode)[key];
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null) return undefined;
  if (typeof first === 'object') {
    const inner = (first as XmlNode)['#text'];
    return inner === undefined ? undefined : String(inner);
  }
  return String(first);
}
