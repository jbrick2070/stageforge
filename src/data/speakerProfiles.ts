export type SpeakerProfileId = 'touring' | 'k2';

export interface SpeakerCabinetSpec {
  label: string;
  /** Cabinet envelope in metres, before array splay or monitor rotation. */
  width: number;
  height: number;
  depth: number;
  drivers: string;
  url: string | null;
}

export interface SpeakerProfile {
  name: string;
  array: SpeakerCabinetSpec;
  sub: SpeakerCabinetSpec;
  monitor: SpeakerCabinetSpec;
}

export const SPEAKER_PROFILES: Record<SpeakerProfileId, SpeakerProfile> = {
  touring: {
    name: 'Touring PA',
    array: { label: 'Touring line array', width: 1.40, height: 0.42, depth: 0.71,
      drivers: 'Twin low-frequency cones and a central waveguide', url: null },
    sub: { label: 'Dual-18″ subwoofer', width: 1.42, height: 0.90, depth: 0.98,
      drivers: 'Two 18″ woofers', url: null },
    monitor: { label: 'Coaxial monitor wedge', width: 0.62, height: 0.61, depth: 0.73,
      drivers: 'Coaxial woofer and horn', url: null },
  },
  k2: {
    name: 'L-Acoustics K2 system',
    array: { label: 'K2', width: 1.338, height: 0.354, depth: 0.400,
      drivers: '2 × 12″ LF, 4 × 6.5″ MF, 2 × 3″ HF',
      url: 'https://www.l-acoustics.com/products/k2/' },
    sub: { label: 'KS28', width: 1.340, height: 0.550, depth: 0.719,
      drivers: '2 × 18″ LF, bass-reflex enclosure',
      url: 'https://www.l-acoustics.com/products/ks28/' },
    monitor: { label: 'X12', width: 0.430, height: 0.496, depth: 0.375,
      drivers: '12″ LF with a coaxial 3″ HF driver',
      url: 'https://www.l-acoustics.com/products/x12/' },
  },
};
