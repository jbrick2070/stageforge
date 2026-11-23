// All positions refer to the audible sixteenth-note clock, in 4/4.
const sections = [
  { id: 'intro', label: 'Walk-on', bars: 8 },
  { id: 'groove', label: 'First groove', bars: 8 },
  { id: 'build', label: 'Build', bars: 8 },
  { id: 'drop', label: 'First drop', bars: 8 },
  { id: 'breakdown', label: 'Breakdown', bars: 8 },
  { id: 'rebuild', label: 'Rebuild', bars: 8 },
  { id: 'finale', label: 'Finale', bars: 12 },
  { id: 'outro', label: 'Curtain call', bars: 4 },
] as const;

export type DemoSectionId = typeof sections[number]['id'];
export const DEMO_TOTAL_BARS = sections.reduce((total, s) => total + s.bars, 0);
export const DEMO_TOTAL_STEPS = DEMO_TOTAL_BARS * 16;

export interface DemoPosition {
  sectionId: DemoSectionId;
  label: string;
  bar: number;
  barInSection: number;
  sectionBars: number;
  sectionProgress: number;
  stepInBar: number;
  step: number;
  finished: boolean;
}

export function getDemoPosition(absoluteStep: number): DemoPosition {
  const step = Math.max(0, Math.min(DEMO_TOTAL_STEPS, absoluteStep));
  const bar = Math.min(DEMO_TOTAL_BARS - 1, Math.floor(step / 16));
  let startBar = 0;
  for (const section of sections) {
    if (bar < startBar + section.bars) {
      return {
        sectionId: section.id, label: section.label, bar, barInSection: bar - startBar,
        sectionBars: section.bars, sectionProgress: (step / 16 - startBar) / section.bars,
        stepInBar: Math.min(15, Math.floor(step - bar * 16)), step,
        finished: step === DEMO_TOTAL_STEPS,
      };
    }
    startBar += section.bars;
  }
  throw new RangeError('Invalid demo position');
}
