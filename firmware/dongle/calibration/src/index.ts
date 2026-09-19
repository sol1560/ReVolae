import { z } from "zod";

export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
export const sampleSchema = z.object({
  delta: pointSchema,
  from: pointSchema,
  to: pointSchema,
});

export type Point = z.infer<typeof pointSchema>;
export type CalibrationSample = z.infer<typeof sampleSchema>;
export type CurvePoint = { input: number; output: number };
export type CalibrationModel = {
  width: number;
  height: number;
  curve: CurvePoint[];
  maxReport: number;
};
export type Delta = { dx: number; dy: number };

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * 按发送增量的长度分桶并取观测位移中位数。边缘撞墙的样本会低估位移，
 * 因而先剔除终点贴边的样本，再用单调约束消除少量截图噪声。
 */
export function fitCalibration(
  rawSamples: CalibrationSample[],
  screen: { width: number; height: number },
): CalibrationModel {
  const samples = z.array(sampleSchema).min(4).parse(rawSamples);
  const dimensions = z.object({ width: z.number().positive(), height: z.number().positive() }).parse(screen);
  const buckets = new Map<number, number[]>();
  for (const sample of samples) {
    const input = Math.hypot(sample.delta.x, sample.delta.y);
    const output = Math.hypot(sample.to.x - sample.from.x, sample.to.y - sample.from.y);
    const atEdge = sample.to.x <= 0 || sample.to.y <= 0 ||
      sample.to.x >= dimensions.width - 1 || sample.to.y >= dimensions.height - 1;
    if (!atEdge && input > 0 && output > 0) {
      const key = Math.round(input * 1000) / 1000;
      buckets.set(key, [...(buckets.get(key) ?? []), output]);
    }
  }
  if (buckets.size < 3) throw new Error("至少需要三个未撞墙的不同增量幅度");
  let previous = 0;
  const curve = [...buckets.entries()].sort(([a], [b]) => a - b).map(([input, values]) => {
    const output = Math.max(previous, median(values));
    previous = output;
    return { input, output };
  });
  return { ...dimensions, curve, maxReport: curve.at(-1)!.input };
}

export function displacement(input: number, model: CalibrationModel): number {
  if (input <= 0) return 0;
  const points = [{ input: 0, output: 0 }, ...model.curve];
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1]!;
    const right = points[index]!;
    if (input <= right.input) {
      const fraction = (input - left.input) / (right.input - left.input);
      return left.output + fraction * (right.output - left.output);
    }
  }
  const last = points.at(-1)!;
  return input * last.output / last.input;
}

function chooseDelta(error: Point, model: CalibrationModel): Delta & { px: number; py: number } {
  const wanted = Math.hypot(error.x, error.y);
  if (!wanted) return { dx: 0, dy: 0, px: 0, py: 0 };
  let low = 0;
  let high = model.maxReport;
  for (let iteration = 0; iteration < 24; iteration++) {
    const middle = (low + high) / 2;
    if (displacement(middle, model) < wanted) low = middle;
    else high = middle;
  }
  const proposedX = error.x / wanted * high;
  const proposedY = error.y / wanted * high;
  let best: (Delta & { px: number; py: number; error: number }) | undefined;
  for (let dx = Math.floor(proposedX) - 2; dx <= Math.ceil(proposedX) + 2; dx++) {
    for (let dy = Math.floor(proposedY) - 2; dy <= Math.ceil(proposedY) + 2; dy++) {
      const length = Math.hypot(dx, dy);
      if (!length || length > model.maxReport + 0.001) continue;
      const gain = displacement(length, model) / length;
      const px = dx * gain;
      const py = dy * gain;
      const candidate = { dx, dy, px, py, error: Math.hypot(error.x - px, error.y - py) };
      if (!best || candidate.error < best.error) best = candidate;
    }
  }
  if (!best) {
    return Math.abs(error.x) >= Math.abs(error.y)
      ? { dx: Math.sign(error.x), dy: 0, px: Math.sign(error.x) * displacement(1, model), py: 0 }
      : { dx: 0, dy: Math.sign(error.y), px: 0, py: Math.sign(error.y) * displacement(1, model) };
  }
  return best;
}

/** 把已知指针位置到绝对目标点转换为一串有界相对 HID 增量。 */
export function toDeltas(fromXY: Point, toXY: Point, model: CalibrationModel): Delta[] {
  pointSchema.parse(fromXY);
  pointSchema.parse(toXY);
  const target = {
    x: Math.max(0, Math.min(model.width - 1, toXY.x)),
    y: Math.max(0, Math.min(model.height - 1, toXY.y)),
  };
  let predicted = {
    x: Math.max(0, Math.min(model.width - 1, fromXY.x)),
    y: Math.max(0, Math.min(model.height - 1, fromXY.y)),
  };
  const result: Delta[] = [];
  for (let iteration = 0; iteration < 64; iteration++) {
    const error = { x: target.x - predicted.x, y: target.y - predicted.y };
    if (Math.hypot(error.x, error.y) <= 0.75) break;
    const move = chooseDelta(error, model);
    result.push({ dx: move.dx, dy: move.dy });
    predicted = {
      x: Math.max(0, Math.min(model.width - 1, predicted.x + move.px)),
      y: Math.max(0, Math.min(model.height - 1, predicted.y + move.py)),
    };
  }
  return result;
}

/**
 * 不信任当前指针位置时，先连续往左上发送足够多的增量，让两轴撞墙归零，
 * 再按模型走到目标。调用方必须整批发送，期间不能插入其它鼠标动作。
 */
export function homeAndMove(toXY: Point, model: CalibrationModel): Delta[] {
  const component = Math.max(1, Math.floor(model.maxReport / Math.SQRT2));
  const perReport = displacement(Math.hypot(component, component), model) / Math.SQRT2;
  const count = Math.ceil(Math.max(model.width, model.height) / perReport) + 2;
  return [
    ...Array.from({ length: count }, () => ({ dx: -component, dy: -component })),
    ...toDeltas({ x: 0, y: 0 }, toXY, model),
  ];
}
