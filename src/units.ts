/**
 * 现实单位（秒、分钟）与核的无量纲单位（圈）之间的换算。
 *
 * 为什么要单独一个文件：`cli.ts`（出文章数据）和 `web/KettlePlayer.vue`（小玩意）
 * 都要做这步换算。如果各写一遍，两边一旦有一丁点差别，同一个种子在文章和
 * 小玩意里就会给出不同的历史，而读者复现不出来时根本无从察觉。
 * 所以换算和模拟核一样，只允许有一份。
 */
import type { SimParams } from './sim.ts';

/** 秒 → 圈。 */
export const toLoops = (seconds: number, loopSeconds: number): number =>
  seconds / loopSeconds;

/** 「平均每 N 秒一次」→ 圈⁻¹ 的速率。 */
export const rateToLoops = (everySeconds: number, loopSeconds: number): number =>
  loopSeconds / everySeconds;

/** 圈 → 分钟，打印和出图用。 */
export const toMinutes = (loops: number, loopSeconds: number): number =>
  (loops * loopSeconds) / 60;

/** 读者能直接理解的一组量。 */
export interface RealWorldSpec {
  /** 传送带空载一圈多少秒。40 座回转寿司店实测 450。 */
  loopSeconds: number;
  seats: number;
  kettles: number;
  /** 每位客人平均多久产生一次需求，秒。 */
  demandEverySeconds: number;
  /** 单次占用（倒汤 / 夹姜）多少秒。 */
  tauSeconds: number;
  /** 预演多长时间，秒。 */
  durationSeconds: number;
  /** 上座率，默认满座。 */
  occupancy?: number;
  /** 帧快照间隔，单位圈。省略则按 `targetFrames` 反推。 */
  frameDt?: number;
  /** 省略 frameDt 时的目标帧数。 */
  targetFrames?: number;
  /** 服务员每隔多少秒重新摊开一次；省略或 0 表示不重整。 */
  resetEverySeconds?: number;
}

/**
 * 把现实单位翻成 `simulate()` 要的参数。
 *
 * `frameDt` 只决定快照密度，不影响历史：核是事件驱动的，且每个座位有独立的
 * 随机流，两者都与帧无关。所以播放器可以用自己的帧密度，仍复现文章那一段。
 */
export function toSimParams(spec: RealWorldSpec): Partial<SimParams> {
  const { loopSeconds } = spec;
  const duration = toLoops(spec.durationSeconds, loopSeconds);
  const frameDt =
    spec.frameDt ?? Math.max(0.002, duration / (spec.targetFrames ?? 2400));
  const params: Partial<SimParams> = {
    seats: spec.seats,
    kettles: spec.kettles,
    occupancy: spec.occupancy ?? 1,
    lambda: rateToLoops(spec.demandEverySeconds, loopSeconds),
    tau: toLoops(spec.tauSeconds, loopSeconds),
    duration,
    frameDt,
  };
  if (spec.resetEverySeconds) {
    params.resetPeriod = toLoops(spec.resetEverySeconds, loopSeconds);
  }
  return params;
}
