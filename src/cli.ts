/**
 * Node 批处理：调用唯一模拟核，把结果写成 data/*.json 供 src/plot.py 出图。
 *
 * 用法：
 *   npm run sim              # 跑全部场景
 *   npm run sim -- scene-a   # 只跑一个
 *
 * 这里不画图、不实现物理。物理在 src/sim.ts。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PARAMS,
  gapCV,
  hashSeed,
  load,
  maxGapCV,
  mulberry32,
  randomGapCV,
  simulate,
  summarize,
  type SimParams,
  type SimResult,
  type Summary,
} from './sim.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

/** 场景 A 的默认参数，见指导第 3.4 节。空载一圈 = 100 秒。 */
const LOOP_SECONDS = 100;

const SCENE_A: Partial<SimParams> = {
  seats: 40,
  kettles: 6,
  occupancy: 1,
  lambda: 0.17, // 每人约每 10 分钟加一次汤
  tau: 0.1, // 倒一次汤约 10 秒
  duration: 240, // 约 6.7 小时；足够看清结团长成
  frameDt: 0.05,
};

/** 场景 B：回转寿司，一盒姜片。 */
const SCENE_B: Partial<SimParams> = {
  seats: 40,
  kettles: 1,
  occupancy: 1,
  lambda: 0.06,
  tau: 0.03,
  duration: 240,
  frameDt: 0.05,
};

const SEED_A = 20260830;
const SEED_B = 'ginger-1';

function round(x: number, digits = 5): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function write(name: string, payload: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(payload));
  console.log(`  → data/${name}.json`);
}

/**
 * 随机重投对照：把 K 个点均匀扔在圆周上，多次取平均。
 * 这是图上那条「随机也像扎堆」的参考线，用均值而不是均方根，
 * 因为仿真曲线画的也是逐帧 CV 的典型高度。
 */
function controlCV(k: number, samples = 4000, seed: string = 'control'): number {
  if (k < 2) return NaN;
  const rand = mulberry32(hashSeed(seed));
  let acc = 0;
  for (let i = 0; i < samples; i++) acc += randomGapCV(k, rand);
  return acc / samples;
}

/**
 * 折断棍子的解析值。K 个均匀随机点的间距是 Dirichlet(1,…,1)，
 * 于是 E[CV²] = (K-1)/(K+1)，即 CV 的均方根为 sqrt((K-1)/(K+1))。
 * 注意这是均方根，按 Jensen 不等式它略高于 CV 的均值；K→∞ 时两者都趋近 1。
 */
function controlCVRmsAnalytic(k: number): number {
  return k < 2 ? NaN : Math.sqrt((k - 1) / (k + 1));
}

function meta(r: SimResult, s: Summary) {
  const occ = r.occupied.filter(Boolean).length;
  return {
    params: r.params,
    seed: r.seed,
    loopSeconds: LOOP_SECONDS,
    occupiedSeats: occ,
    rho: round(load(r.params, occ), 4),
    controlCV: round(controlCV(r.params.kettles), 4),
    controlCVRmsAnalytic: round(controlCVRmsAnalytic(r.params.kettles), 4),
    maxCV: round(maxGapCV(r.params.kettles), 4),
    summary: {
      steadyCV: round(s.steadyCV, 4),
      steadyBunching: round(s.steadyBunching, 4),
      finalCV: round(s.finalCV, 4),
      meanWait: round(s.meanWait, 4),
      meanWaitSeconds: round(s.meanWait * LOOP_SECONDS, 2),
      p90Wait: round(s.p90Wait, 4),
      served: s.served,
      droppedDemands: s.droppedDemands,
      useImbalance: round(s.useImbalance, 3),
    },
  };
}

/** 主运行：帧 + CV 曲线，够画时空图。 */
function runScene(name: string, base: Partial<SimParams>, seed: number | string): SimResult {
  const r = simulate(base, seed);
  const s = summarize(r);
  write(name, {
    ...meta(r, s),
    times: r.times.map((t) => round(t, 4)),
    positions: r.positions.map((row) => row.map((p) => round(p))),
    states: r.states,
    gapCV: r.gapCV.map((c) => round(c, 4)),
    servedBySeat: r.servedBySeat,
    heldTimeBySeat: r.heldTimeBySeat.map((x) => round(x, 4)),
    usesByKettle: r.usesByKettle,
    waits: r.waits.map((w) => round(w, 4)),
    waitTimes: r.waitTimes.map((w) => round(w, 3)),
  });
  console.log(
    `  K=${r.params.kettles} ρ=${round(load(r.params, r.occupied.filter(Boolean).length), 3)} ` +
      `steadyCV=${round(s.steadyCV, 3)}（对照 ${round(controlCV(r.params.kettles), 3)}，` +
      `上限 ${round(maxGapCV(r.params.kettles), 3)}） ` +
      `结团指数=${round(s.steadyBunching, 3)} 平均等待=${round(s.meanWait * LOOP_SECONDS, 1)}s`,
  );
  return r;
}

/** 多种子平均，给扫描曲线降噪。 */
function ensemble(base: Partial<SimParams>, seeds: Array<number | string>) {
  const cvs: number[] = [];
  const bunch: number[] = [];
  const waits: number[] = [];
  const imbalances: number[] = [];
  for (const seed of seeds) {
    const s = summarize(simulate(base, seed));
    if (Number.isFinite(s.steadyCV)) cvs.push(s.steadyCV);
    if (Number.isFinite(s.steadyBunching)) bunch.push(s.steadyBunching);
    if (Number.isFinite(s.meanWait)) waits.push(s.meanWait);
    imbalances.push(s.useImbalance);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const cvMean = mean(cvs);
  return {
    steadyCV: round(cvMean, 4),
    steadyCVSpread: round(
      cvs.length > 1
        ? Math.sqrt(cvs.reduce((a, c) => a + (c - cvMean) ** 2, 0) / (cvs.length - 1))
        : 0,
      4,
    ),
    steadyBunching: round(mean(bunch), 4),
    meanWait: round(mean(waits), 4),
    meanWaitSeconds: round(mean(waits) * LOOP_SECONDS, 2),
    useImbalance: round(mean(imbalances), 3),
  };
}

const SWEEP_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** K 扫描：壶多壶少，结团差多少。 */
function runSweepK(): void {
  const ks = [1, 2, 3, 4, 6, 8, 12, 20];
  const rows = ks.map((k) => {
    const base = { ...SCENE_A, kettles: k };
    const e = ensemble(base, SWEEP_SEEDS);
    const ctrl = controlCV(k);
    console.log(
      `  K=${String(k).padStart(2)} CV=${e.steadyCV}（对照 ${round(ctrl, 3)}，上限 ${round(maxGapCV(k), 3)}） ` +
        `结团指数=${e.steadyBunching}（随机 ${round(ctrl / maxGapCV(k), 3)}） 等待=${e.meanWaitSeconds}s`,
    );
    return {
      kettles: k,
      rho: round(load({ ...DEFAULT_PARAMS, ...base } as SimParams), 4),
      controlCV: round(ctrl, 4),
      controlCVRmsAnalytic: round(controlCVRmsAnalytic(k), 4),
      maxCV: round(maxGapCV(k), 4),
      controlBunching: round(ctrl / maxGapCV(k), 4),
      ...e,
    };
  });

  // 顺便留几条 CV(t) 曲线，方便在一张图上叠不同 K。
  const traces = [1, 2, 6, 12].map((k) => {
    const r = simulate({ ...SCENE_A, kettles: k }, SEED_A);
    return {
      kettles: k,
      times: r.times.map((t) => round(t, 4)),
      gapCV: r.gapCV.map((c) => round(c, 4)),
    };
  });

  write('sweep-k', { base: SCENE_A, seeds: SWEEP_SEEDS, loopSeconds: LOOP_SECONDS, rows, traces });
}

/** 负荷扫描：需求多勤、倒汤多慢，才会挤成一坨。 */
function runSweepLoad(): void {
  const lambdas = [0.02, 0.04, 0.06, 0.09, 0.12, 0.17, 0.24, 0.34, 0.48, 0.68];
  const taus = [0.05, 0.1, 0.2];
  const series = taus.map((tau) => ({
    tau,
    tauSeconds: round(tau * LOOP_SECONDS, 1),
    rows: lambdas.map((lambda) => {
      const base = { ...SCENE_A, lambda, tau };
      const e = ensemble(base, SWEEP_SEEDS);
      return {
        lambda,
        rho: round(load({ ...DEFAULT_PARAMS, ...base } as SimParams), 4),
        ...e,
      };
    }),
  }));
  for (const s of series) {
    const desc = s.rows.map((r) => `${r.rho}:${r.steadyCV}`).join('  ');
    console.log(`  τ=${s.tauSeconds}s  ρ:CV = ${desc}`);
  }
  write('sweep-load', {
    base: SCENE_A,
    seeds: SWEEP_SEEDS,
    loopSeconds: LOOP_SECONDS,
    controlCV: round(controlCV(SCENE_A.kettles!), 4),
    series,
  });
}

/** 服务员巡台：定期把壶重新摊开，能压回多少。 */
function runReset(): void {
  const periods = [0, 60, 30, 15, 8];
  const rows = periods.map((p) => {
    const base = { ...SCENE_A, resetPeriod: p };
    const e = ensemble(base, SWEEP_SEEDS);
    console.log(
      `  重整周期=${p === 0 ? '不重整' : `${p} 圈`} steadyCV=${e.steadyCV} 等待=${e.meanWaitSeconds}s`,
    );
    return { resetPeriod: p, resetSeconds: p * LOOP_SECONDS, ...e };
  });
  write('reset', {
    base: SCENE_A,
    seeds: SWEEP_SEEDS,
    loopSeconds: LOOP_SECONDS,
    controlCV: round(controlCV(SCENE_A.kettles!), 4),
    rows,
  });
}

/** 场景 B 的两种需求分布：均匀 vs 某桌特别爱吃姜。 */
function runGinger(): void {
  const uniform = runScene('scene-b', SCENE_B, SEED_B);

  const hotSeat = 12;
  const skewed = simulate(
    { ...SCENE_B, lambdaOverrides: { [hotSeat]: SCENE_B.lambda! * 8 } },
    SEED_B,
  );
  const s = summarize(skewed);
  write('scene-b-skewed', {
    ...meta(skewed, s),
    hotSeat,
    times: skewed.times.map((t) => round(t, 4)),
    positions: skewed.positions.map((row) => row.map((p) => round(p))),
    states: skewed.states,
    servedBySeat: skewed.servedBySeat,
    heldTimeBySeat: skewed.heldTimeBySeat.map((x) => round(x, 4)),
    uniformServedBySeat: uniform.servedBySeat,
    uniformHeldTimeBySeat: uniform.heldTimeBySeat.map((x) => round(x, 4)),
  });
  console.log(`  第 ${hotSeat} 桌 λ×8：该桌服务 ${skewed.servedBySeat[hotSeat]} 次`);
}

/** 一个自检：同种子必须逐位可复现，这是读者能对上文章配图的前提。 */
function selfCheck(): void {
  const a = simulate({ ...SCENE_A, duration: 20 }, 'check');
  const b = simulate({ ...SCENE_A, duration: 20 }, 'check');
  const same =
    JSON.stringify(a.positions) === JSON.stringify(b.positions) &&
    JSON.stringify(a.waits) === JSON.stringify(b.waits);
  if (!same) throw new Error('同种子两次运行结果不一致，核里有非确定性');

  const c = simulate({ ...SCENE_A, duration: 20 }, 'check-2');
  if (JSON.stringify(a.positions) === JSON.stringify(c.positions)) {
    throw new Error('换种子结果没变，种子没接上随机流');
  }

  // 均匀分布的 CV 应为 0。
  const uniform = gapCV([0, 0.25, 0.5, 0.75]);
  if (Math.abs(uniform) > 1e-12) throw new Error(`均匀排布的 CV 应为 0，得到 ${uniform}`);

  // 折断棍子：经验均方根应贴近解析值 sqrt((K-1)/(K+1))。
  const k = 6;
  const rand = mulberry32(hashSeed('check-control'));
  const n = 200000;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const cv = randomGapCV(k, rand);
    sq += cv * cv;
  }
  const empRms = Math.sqrt(sq / n);
  const ana = controlCVRmsAnalytic(k);
  if (Math.abs(empRms - ana) > 0.01) {
    throw new Error(`随机对照 CV 均方根经验值 ${empRms} 与解析值 ${ana} 不符`);
  }
  console.log(
    `  自检通过（K=6 随机对照：均方根经验 ${round(empRms, 4)} / 解析 ${round(ana, 4)}，` +
      `均值 ${round(controlCV(k), 4)}）`,
  );
}

// ---------------------------------------------------------------- 入口

const SCENES: Record<string, () => void> = {
  check: selfCheck,
  'scene-a': () => {
    runScene('scene-a', SCENE_A, SEED_A);
  },
  ginger: runGinger,
  'sweep-k': runSweepK,
  'sweep-load': runSweepLoad,
  reset: runReset,
};

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const todo = requested.length ? requested : Object.keys(SCENES);

for (const name of todo) {
  const fn = SCENES[name];
  if (!fn) {
    console.error(`未知场景：${name}。可用：${Object.keys(SCENES).join(', ')}`);
    process.exit(1);
  }
  console.log(`\n[${name}]`);
  fn();
}
console.log('\n完成。接着跑 python src/plot.py');
