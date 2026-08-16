import { ValueTransformer } from 'typeorm';

export const bigintTransformer: ValueTransformer = {
  from: (value: string | number) =>
    typeof value === 'string' ? Number(value) : value,
  to: (value: number) => value,
};

export const decimalTransformer: ValueTransformer = {
  from: (value: string | number | null) => {
    if (value == null) return value;
    return typeof value === 'string' ? Number(value) : value;
  },
  to: (value: number | null) => value,
};

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
export const round = (value: number, mode: 'ceil' | 'floor' | number = 0) => {
  if (value == null) return value;

  if (mode === 'ceil') {
    return Math.ceil(value);
  }
  if (mode === 'floor') {
    return Math.floor(value);
  }

  const precision = typeof mode === 'number' ? mode : 0;
  const multiplier = Math.pow(10, precision);
  return Math.round(value * multiplier) / multiplier;
};

export function pickWeighted<T>(
  items: { weight: number; value: T }[],
  precision: number = 2,
  random: () => number = Math.random,
): [T, number] {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = random() * total;
  const bucket = Math.floor(
    round(r / total, precision) * Math.pow(10, precision),
  );
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return [item.value, bucket];
  }
  return [items[items.length - 1].value, bucket];
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(arr: T[], random: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function shuffleArraySeeded<T>(items: T[], seed: number): T[] {
  const copy = items.slice();
  shuffleInPlace(copy, mulberry32(seed));
  return copy;
}