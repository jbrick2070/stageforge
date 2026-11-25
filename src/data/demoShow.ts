// All positions refer to the audible sixteenth-note clock, in 4/4.

export const DEMO_SECTION_ROLES = [
  'intro',
  'groove',
  'build',
  'drop',
  'breakdown',
  'rebuild',
  'finale',
  'outro',
] as const;

export type DemoSectionId = (typeof DEMO_SECTION_ROLES)[number];

export interface DemoSection {
  readonly role: DemoSectionId;
  readonly label: string;
  readonly bars: number;
}

export interface CompiledDemoSection extends DemoSection {
  readonly index: number;
  readonly startBar: number;
  readonly startStep: number;
  readonly steps: number;
}

export interface DemoTimeline {
  readonly sections: readonly CompiledDemoSection[];
  readonly totalBars: number;
  readonly totalSteps: number;
  readonly leadingIntroBars: number;
  readonly leadingIntroSteps: number;
  readonly openingBlackoutBars: number;
}

export const DEFAULT_DEMO_SECTIONS: readonly DemoSection[] = Object.freeze([
  Object.freeze({ role: 'intro', label: 'Walk-on', bars: 8 }),
  Object.freeze({ role: 'groove', label: 'First groove', bars: 8 }),
  Object.freeze({ role: 'build', label: 'Build', bars: 8 }),
  Object.freeze({ role: 'drop', label: 'First drop', bars: 8 }),
  Object.freeze({ role: 'breakdown', label: 'Breakdown', bars: 8 }),
  Object.freeze({ role: 'rebuild', label: 'Rebuild', bars: 8 }),
  Object.freeze({ role: 'finale', label: 'Finale', bars: 12 }),
  Object.freeze({ role: 'outro', label: 'Curtain call', bars: 4 }),
]);

export const DEMO_TOTAL_BARS = DEFAULT_DEMO_SECTIONS.reduce((total, s) => total + s.bars, 0);
export const DEMO_TOTAL_STEPS = DEMO_TOTAL_BARS * 16;

// Virtual opening-timeline step used once no leading intro blackout/reveal applies.
export const OPENING_DONE_STEP = 1_000_000;
const INTRO_REVEAL_STEPS = 128; // 8 bars
const INTRO_BLACKOUT_STEPS = 32; // 2 bars in the default 8-bar intro

export function compileDemoTimeline(sections: readonly DemoSection[]): DemoTimeline {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new RangeError('Demo timeline requires at least one section.');
  }
  const compiled: CompiledDemoSection[] = [];
  let startBar = 0;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!Number.isInteger(section.bars) || section.bars < 1) {
      throw new RangeError(`Demo section "${section.label}" must have a positive integer bar count.`);
    }
    const steps = section.bars * 16;
    compiled.push(Object.freeze({
      role: section.role,
      label: section.label,
      bars: section.bars,
      index: i,
      startBar,
      startStep: startBar * 16,
      steps,
    }));
    startBar += section.bars;
  }
  const totalBars = startBar;
  const totalSteps = totalBars * 16;
  const leadingIntroBars = compiled[0].role === 'intro' ? compiled[0].bars : 0;
  const leadingIntroSteps = leadingIntroBars * 16;
  const introScale = leadingIntroSteps > 0 ? Math.max(1, INTRO_REVEAL_STEPS / leadingIntroSteps) : 1;
  const openingBlackoutBars = leadingIntroSteps > 0
    ? Math.max(1, Math.ceil((INTRO_BLACKOUT_STEPS / introScale) / 16))
    : 0;

  return Object.freeze({
    sections: Object.freeze(compiled),
    totalBars,
    totalSteps,
    leadingIntroBars,
    leadingIntroSteps,
    openingBlackoutBars,
  });
}

export const DEFAULT_DEMO_TIMELINE: DemoTimeline = compileDemoTimeline(DEFAULT_DEMO_SECTIONS);

export interface DemoPosition {
  sectionId: DemoSectionId;
  sectionIndex: number;
  label: string;
  bar: number;
  barInSection: number;
  sectionBars: number;
  sectionProgress: number;
  stepInBar: number;
  stepInSection: number;
  step: number;
  totalBars: number;
  totalSteps: number;
  openingStep: number;
  openingBlackoutBars: number;
  /** True only for the one-time opening intro occurrence (`sectionIndex === 0 && role === 'intro'`). */
  isOpening: boolean;
  /** True only for the immediate post-intro transition groove (`sectionIndex === 1 && leadingIntroSteps > 0 && role === 'groove'`). */
  isOpeningTransition: boolean;
  finished: boolean;
  beforeDownbeat?: boolean;
}

function isTimeline(value: readonly DemoSection[] | DemoTimeline): value is DemoTimeline {
  return !Array.isArray(value);
}

function computeOpeningStep(step: number, timeline: DemoTimeline): number {
  const { leadingIntroSteps } = timeline;
  if (leadingIntroSteps === 0) return OPENING_DONE_STEP;
  // Exact identity when leading intro matches the 8-bar (128-step) synth reveal.
  if (leadingIntroSteps === INTRO_REVEAL_STEPS) return step;
  if (step < leadingIntroSteps) {
    // Shorter intro compresses the 8-bar reveal; longer intro plays the 8-bar reveal then holds at 128.
    return leadingIntroSteps < INTRO_REVEAL_STEPS
      ? step * (INTRO_REVEAL_STEPS / leadingIntroSteps)
      : Math.min(INTRO_REVEAL_STEPS, step);
  }
  return INTRO_REVEAL_STEPS + (step - leadingIntroSteps);
}

export function getDemoPosition(
  absoluteStep: number,
  sectionsOrTimeline: readonly DemoSection[] | DemoTimeline = DEFAULT_DEMO_TIMELINE,
): DemoPosition {
  const timeline = isTimeline(sectionsOrTimeline)
    ? sectionsOrTimeline
    : sectionsOrTimeline === DEFAULT_DEMO_SECTIONS
      ? DEFAULT_DEMO_TIMELINE
      : compileDemoTimeline(sectionsOrTimeline);

  const finiteStep = Number.isFinite(absoluteStep) ? absoluteStep : 0;
  const step = Math.max(0, Math.min(timeline.totalSteps, finiteStep));
  const bar = Math.min(timeline.totalBars - 1, Math.floor(step / 16));
  const openingStep = computeOpeningStep(step, timeline);

  for (const section of timeline.sections) {
    if (bar < section.startBar + section.bars) {
      return {
        sectionId: section.role,
        sectionIndex: section.index,
        label: section.label,
        bar,
        barInSection: bar - section.startBar,
        sectionBars: section.bars,
        sectionProgress: (step / 16 - section.startBar) / section.bars,
        stepInBar: Math.min(15, Math.floor(step - bar * 16)),
        stepInSection: step - section.startStep,
        step,
        totalBars: timeline.totalBars,
        totalSteps: timeline.totalSteps,
        openingStep,
        openingBlackoutBars: timeline.openingBlackoutBars,
        isOpening: section.index === 0 && section.role === 'intro',
        isOpeningTransition: section.index === 1 && timeline.leadingIntroSteps > 0 && section.role === 'groove',
        finished: step === timeline.totalSteps,
      };
    }
  }
  throw new RangeError('Invalid demo position');
}
