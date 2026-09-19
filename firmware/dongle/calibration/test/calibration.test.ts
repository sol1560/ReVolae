import { describe, expect, test } from "bun:test";
import { displacement, fitCalibration, homeAndMove, toDeltas, type CalibrationSample, type Delta, type Point } from "../src/index";

const width = 1024;
const height = 768;
const realCurve = [
  { input: 1, output: 0.7 }, { input: 2, output: 1.5 }, { input: 4, output: 3.4 },
  { input: 8, output: 7.8 }, { input: 12, output: 13.5 }, { input: 16, output: 20 },
  { input: 24, output: 34 }, { input: 32, output: 50 }, { input: 48, output: 82 },
  { input: 64, output: 118 }, { input: 80, output: 158 },
];

const fakeModel = { width, height, curve: realCurve, maxReport: 80 };

function apply(position: Point, moves: Delta[]): Point {
  let current = { ...position };
  for (const move of moves) {
    const length = Math.hypot(move.dx, move.dy);
    const gain = length ? displacement(length, fakeModel) / length : 0;
    current = {
      x: Math.max(0, Math.min(width - 1, current.x + move.dx * gain)),
      y: Math.max(0, Math.min(height - 1, current.y + move.dy * gain)),
    };
  }
  return current;
}

function samples(): CalibrationSample[] {
  const result: CalibrationSample[] = [];
  for (const point of realCurve) {
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const from = { x: 512, y: 384 };
      const delta = { x: ux! * point.input, y: uy! * point.input };
      const to = apply(from, [{ dx: delta.x, dy: delta.y }]);
      result.push({ delta, from, to });
    }
  }
  // 应被拟合器剔除的撞墙样本。
  result.push({ delta: { x: -80, y: 0 }, from: { x: 2, y: 20 }, to: { x: 0, y: 20 } });
  return result;
}

describe("iPad 相对指针校准", () => {
  const model = fitCalibration(samples(), { width, height });

  test("拟合曲线单调，且忽略撞墙样本", () => {
    expect(model.curve).toHaveLength(realCurve.length);
    expect(model.curve.every((point, index) => index === 0 || point.output >= model.curve[index - 1]!.output)).toBeTrue();
    expect(model.curve.at(-1)!.output).toBeCloseTo(158, 6);
  });

  test("100 个确定性随机目标的 P95 小于 4 px", () => {
    let seed = 0x1560;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const errors: number[] = [];
    for (let index = 0; index < 100; index++) {
      const from = { x: random() * (width - 1), y: random() * (height - 1) };
      const target = { x: random() * (width - 1), y: random() * (height - 1) };
      const actual = apply(from, toDeltas(from, target, model));
      errors.push(Math.hypot(actual.x - target.x, actual.y - target.y));
    }
    errors.sort((a, b) => a - b);
    const p50 = errors[49]!;
    const p95 = errors[94]!;
    console.log(`calibration error P50=${p50.toFixed(3)}px P95=${p95.toFixed(3)}px max=${errors.at(-1)!.toFixed(3)}px`);
    expect(p95).toBeLessThan(4);
  });

  test("目标越界会夹到屏幕边缘", () => {
    const actual = apply({ x: 500, y: 300 }, toDeltas({ x: 500, y: 300 }, { x: 4000, y: -50 }, model));
    expect(Math.abs(actual.x - (width - 1))).toBeLessThan(2);
    expect(actual.y).toBeLessThan(2);
  });

  test("归零序列从未知位置撞左上墙后到达目标", () => {
    for (const start of [{ x: 100, y: 100 }, { x: 1023, y: 767 }, { x: 900, y: 20 }]) {
      const target = { x: 777, y: 555 };
      const actual = apply(start, homeAndMove(target, model));
      expect(Math.hypot(actual.x - target.x, actual.y - target.y)).toBeLessThan(2);
    }
  });
});
