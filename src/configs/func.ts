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
