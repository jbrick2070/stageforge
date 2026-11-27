import { parseRigJson } from './rigImport';
import { makeShowFile, parseDesignContent, type DesignContent } from './showFile';
import { INITIAL_SHOW_STATE } from './presets';

export const SAVED_DESIGN_KEY = 'stageforge.design.v1';
const FORMAT = 'stageforge-local-design';
const VERSION = 1;
const MAX_STORAGE_LENGTH = 64 * 1024 * 1024;

export interface SavedDesignRecord {
  current: DesignContent;
  previous?: DesignContent;
}

export type SavedDesignRead =
  | { status: 'ready'; record: SavedDesignRecord }
  | { status: 'missing' | 'corrupt' | 'newer' | 'inaccessible' };

export function readSavedDesign(storage?: Pick<Storage, 'getItem'>): SavedDesignRead {
  let raw: string | null;
  try {
    raw = (storage ?? localStorage).getItem(SAVED_DESIGN_KEY);
  } catch {
    return { status: 'inaccessible' };
  }
  if (raw === null) return { status: 'missing' };
  if (raw.length > MAX_STORAGE_LENGTH) return { status: 'corrupt' };
  try {
    const value = JSON.parse(raw);
    if (value?.format !== FORMAT) {
      return { status: 'ready', record: { current: { rig: parseRigJson(raw) } } };
    }
    if (Number.isSafeInteger(value.version) && value.version > VERSION) return { status: 'newer' };
    if (value.version !== VERSION || Object.keys(value).some(key => !['format', 'version', 'current', 'previous'].includes(key))) {
      return { status: 'corrupt' };
    }
    const current = parseDesignContent(value.current);
    const previous = value.previous === undefined ? undefined : parseDesignContent(value.previous);
    return { status: 'ready', record: { current, previous } };
  } catch {
    return { status: 'corrupt' };
  }
}

export function writeSavedDesign(record: SavedDesignRecord, storage?: Pick<Storage, 'setItem'>) {
  const json = JSON.stringify({ format: FORMAT, version: VERSION, ...record });
  if (json.length > MAX_STORAGE_LENGTH) throw new Error('The local design is too large. Save Show JSON or a Show Bundle.');
  if (readSavedDesign({ getItem: () => json }).status !== 'ready') throw new Error('The local design is not valid for recovery.');
  (storage ?? localStorage).setItem(SAVED_DESIGN_KEY, json);
}

export function makeDesignRecoveryShow({ rig, stage, crowd }: DesignContent) {
  return makeShowFile(rig, [], INITIAL_SHOW_STATE, null, undefined, undefined, undefined, stage, undefined, crowd);
}
