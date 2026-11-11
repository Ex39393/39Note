import type { ReadingTheme } from '../themes';

export const EMPTY_READER_AMBIENT_EFFECT_BY_THEME = {
  original: 'paper-window',
  'soft-gray': 'frosted-reflections',
  mint: 'water-caustics',
  dark: 'white-dust',
  midnight: 'aurora-curtains',
  twilight: 'tyndall-dust',
  dawn: 'sunrise-clouds',
  sea: 'subsurface-light',
  bay: 'coastal-horizon',
  bright: 'cherry-sky',
} as const satisfies Record<ReadingTheme, string>;

export type EmptyReaderDustDepth = 'far' | 'middle' | 'near';

export interface EmptyReaderDustMote {
  id: string;
  x: number;
  y: number;
  size: number;
  opacity: number;
}

export interface EmptyReaderDustGroup {
  id: string;
  depth: EmptyReaderDustDepth;
  duration: number;
  delay: number;
  compactHidden: boolean;
  motion: {
    start: readonly [number, number];
    middle: readonly [number, number];
    end: readonly [number, number];
  };
  motes: readonly EmptyReaderDustMote[];
}

interface DustGroupPlan extends Omit<EmptyReaderDustGroup, 'motes'> {
  count: number;
  seed: number;
}

export const TWILIGHT_EMPTY_READER_MOTE_COUNT = 52;
export const DARK_EMPTY_READER_MOTE_COUNT = 44;

const TWILIGHT_GROUP_PLANS: readonly DustGroupPlan[] = [
  {
    id: 'twilight-far-a',
    depth: 'far',
    count: 10,
    seed: 0x39a101,
    duration: 29,
    delay: -17,
    compactHidden: false,
    motion: { start: [-1, 1], middle: [1, -1], end: [3, -3] },
  },
  {
    id: 'twilight-far-b',
    depth: 'far',
    count: 9,
    seed: 0x39a102,
    duration: 25,
    delay: -9,
    compactHidden: true,
    motion: { start: [1, -1], middle: [-2, 1], end: [-4, 2] },
  },
  {
    id: 'twilight-middle-a',
    depth: 'middle',
    count: 9,
    seed: 0x39a103,
    duration: 18,
    delay: -12,
    compactHidden: false,
    motion: { start: [-2, 1], middle: [1, -3], end: [5, -4] },
  },
  {
    id: 'twilight-middle-b',
    depth: 'middle',
    count: 8,
    seed: 0x39a104,
    duration: 15,
    delay: -5,
    compactHidden: true,
    motion: { start: [2, 2], middle: [-1, -2], end: [-5, -1] },
  },
  {
    id: 'twilight-near-a',
    depth: 'near',
    count: 8,
    seed: 0x39a105,
    duration: 11,
    delay: -7,
    compactHidden: false,
    motion: { start: [-3, 2], middle: [2, -4], end: [7, -6] },
  },
  {
    id: 'twilight-near-b',
    depth: 'near',
    count: 8,
    seed: 0x39a106,
    duration: 8.5,
    delay: -3,
    compactHidden: false,
    motion: { start: [3, -1], middle: [-4, 3], end: [-8, 5] },
  },
] as const;

const DARK_GROUP_PLANS: readonly DustGroupPlan[] = [
  {
    id: 'dark-far-a',
    depth: 'far',
    count: 8,
    seed: 0x39d201,
    duration: 31,
    delay: -19,
    compactHidden: false,
    motion: { start: [-1, -1], middle: [2, 1], end: [4, -2] },
  },
  {
    id: 'dark-far-b',
    depth: 'far',
    count: 8,
    seed: 0x39d202,
    duration: 26,
    delay: -8,
    compactHidden: true,
    motion: { start: [2, 1], middle: [-1, -2], end: [-5, 2] },
  },
  {
    id: 'dark-middle-a',
    depth: 'middle',
    count: 7,
    seed: 0x39d203,
    duration: 20,
    delay: -13,
    compactHidden: false,
    motion: { start: [-2, 2], middle: [3, -1], end: [5, -5] },
  },
  {
    id: 'dark-middle-b',
    depth: 'middle',
    count: 7,
    seed: 0x39d204,
    duration: 16,
    delay: -6,
    compactHidden: true,
    motion: { start: [1, -2], middle: [-3, 2], end: [-6, 4] },
  },
  {
    id: 'dark-near-a',
    depth: 'near',
    count: 7,
    seed: 0x39d205,
    duration: 12,
    delay: -7,
    compactHidden: false,
    motion: { start: [-3, 1], middle: [2, -4], end: [7, -3] },
  },
  {
    id: 'dark-near-b',
    depth: 'near',
    count: 7,
    seed: 0x39d206,
    duration: 9,
    delay: -4,
    compactHidden: false,
    motion: { start: [3, -2], middle: [-2, 3], end: [-7, 5] },
  },
] as const;

export const twilightEmptyReaderDustGroups = createDustGroups(TWILIGHT_GROUP_PLANS);
export const darkEmptyReaderDustGroups = createDustGroups(DARK_GROUP_PLANS);

function createDustGroups(
  plans: readonly DustGroupPlan[],
): readonly EmptyReaderDustGroup[] {
  return plans.map(({ count, seed, ...group }) => ({
    ...group,
    motes: createMotes(group.id, group.depth, count, seed),
  }));
}

function createMotes(
  groupId: string,
  depth: EmptyReaderDustDepth,
  count: number,
  seed: number,
): readonly EmptyReaderDustMote[] {
  const random = createSeededRandom(seed);
  const columns = Math.ceil(Math.sqrt(count * 1.45));
  const rows = Math.ceil(count / columns);
  const sizeRange =
    depth === 'far'
      ? ([0.8, 1.35] as const)
      : depth === 'middle'
        ? ([1.25, 2.15] as const)
        : ([2, 3.35] as const);
  const opacityRange =
    depth === 'far'
      ? ([0.32, 0.5] as const)
      : depth === 'middle'
        ? ([0.46, 0.68] as const)
        : ([0.62, 0.88] as const);

  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      id: `${groupId}-${index + 1}`,
      x: round(((column + 0.18 + random() * 0.64) / columns) * 100),
      y: round(((row + 0.16 + random() * 0.68) / rows) * 100),
      size: round(between(random, sizeRange[0], sizeRange[1])),
      opacity: round(between(random, opacityRange[0], opacityRange[1])),
    };
  });
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function between(random: () => number, minimum: number, maximum: number): number {
  return minimum + random() * (maximum - minimum);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
