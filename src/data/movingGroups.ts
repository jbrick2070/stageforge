import type { HeadGroup, HeadLook, MovingGroups, ShowState } from '../types/show';

export function headLook(state: ShowState, group: HeadGroup): HeadLook {
  const override = state.movingGroups?.[group];
  return override ? { ...state, ...override } : state;
}

// An edit addressed to All takes over just the changed attributes on both groups.
export function applyDeskPatch(state: ShowState, patch: Partial<ShowState>): ShowState {
  const next = { ...state, ...patch };
  if (patch.movingGroups !== undefined || !state.movingGroups) return next;
  const remaining: MovingGroups = {};
  let changed = false;
  for (const group of ['beam', 'wash'] as const) {
    const fields = state.movingGroups[group];
    if (!fields) continue;
    const entries = Object.entries(fields).filter(([key]) => !Object.hasOwn(patch, key));
    if (entries.length !== Object.keys(fields).length) changed = true;
    if (entries.length) remaining[group] = Object.fromEntries(entries);
  }
  // An explicit empty object also clears overrides in a recorded delta.
  if (changed) next.movingGroups = remaining;
  return next;
}
