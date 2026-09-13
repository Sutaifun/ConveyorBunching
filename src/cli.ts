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
  timeToBunching,
  type SimParams,
  type SimResult,
  type Summary,
} from './sim.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

/**
 * 空载转一圈的秒数。40 座的回转寿司店实测约 7.5 分钟（2026-08-29 现场观察）；
 * 若带长约 40 m 则合 8.9 cm/s，正落在回转寿司常见的 6–10 cm/s 区间。
 * 回转火锅的带速没有实测，暂借用同一值，见指导第 3.4 节。
 */
const LOOP_SECONDS = 450;

/** 秒 → 圈。 */
const toLoops = (seconds: number): number => seconds / LOOP_SECONDS;
/** 「平均每 N 秒一次」→ 圈^-1 的速率。 */
const rateToLoops = (everySeconds: number): number => LOOP_SECONDS / everySeconds;
/** 圈 → 分钟，出图和打印用。 */
const toMinutes = (loops: number): number => (loops * LOOP_SECONDS) / 60;

const MEAL_LOOPS = (90 * 60) / LOOP_SECONDS; // 一顿饭 90 分钟 = 12 圈
const SERVICE_LOOPS = (180 * 60) / LOOP_SECONDS; // 一个晚市 3 小时 = 24 圈

/** 场景 A：回转火锅，六把加汤壶。见指导第 3.4 节。 */
const SCENE_A: Partial<SimParams> = {
  seats: 40,
  kettles: 6,
  occupancy: 1,
  lambda: rateToLoops(10 * 60), // 每人约每 10 分钟加一次汤
  tau: toLoops(10), // 倒一次汤约 10 秒
  duration: SERVICE_LOOPS,
  frameDt: 0.02,
};

/** 场景 B：回转寿司，一盒姜片。 */
const SCENE_B: Partial<SimParams> = {
  seats: 40,
  kettles: 1,
  occupancy: 1,
  lambda: rateToLoops(15 * 60), // 每人约每 15 分钟想吃一次姜
  tau: toLoops(5), // 夹一次约 5 秒
  duration: SERVICE_LOOPS,
  frameDt: 0.02,
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
  const k = r.params.kettles;
  const ctrl = controlCV(k);
  // 「越过随机线」用归一化后的对照高度作阈值，才能跨 K 比较。
  const ctrlLevel = ctrl / maxGapCV(k);
  return {
    params: r.params,
    seed: r.seed,
    loopSeconds: LOOP_SECONDS,
    mealLoops: MEAL_LOOPS,
    serviceLoops: SERVICE_LOOPS,
    occupiedSeats: occ,
    rho: round(load(r.params, occ), 4),
    controlCV: round(ctrl, 4),
    controlCVRmsAnalytic: round(controlCVRmsAnalytic(k), 4),
    controlBunching: round(ctrlLevel, 4),
    maxCV: round(maxGapCV(k), 4),
    summary: {
      steadyCV: round(s.steadyCV, 4),
      steadyBunching: round(s.steadyBunching, 4),
      finalCV: round(s.finalCV, 4),
      meanWait: round(s.meanWait, 4),
      meanWaitSeconds: round(s.meanWait * LOOP_SECONDS, 2),
      p90Wait: round(s.p90Wait, 4),
      p90WaitSeconds: round(s.p90Wait * LOOP_SECONDS, 2),
      served: s.served,
      droppedDemands: s.droppedDemands,
      useImbalance: round(s.useImbalance, 3),
      crossControlMinutes: round(toMinutes(timeToBunching(r, ctrlLevel)), 2),
      halfMinutes: round(toMinutes(timeToBunching(r, 0.5)), 2),
      ninetyMinutes: round(toMinutes(timeToBunching(r, 0.9)), 2),
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
const mean = (a: number[]): number =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

function ensemble(base: Partial<SimParams>, seeds: Array<number | string>) {
  const cvs: number[] = [];
  const bunch: number[] = [];
  const waits: number[] = [];
  const imbalances: number[] = [];
  const tHalf: number[] = [];
  const tCtrl: number[] = [];
  let neverHalf = 0;

  const k = base.kettles ?? DEFAULT_PARAMS.kettles;
  const ctrlLevel = controlCV(k) / maxGapCV(k);

  for (const seed of seeds) {
    const r = simulate(base, seed);
    const s = summarize(r);
    if (Number.isFinite(s.steadyCV)) cvs.push(s.steadyCV);
    if (Number.isFinite(s.steadyBunching)) bunch.push(s.steadyBunching);
    if (Number.isFinite(s.meanWait)) waits.push(s.meanWait);
    imbalances.push(s.useImbalance);

    const th = timeToBunching(r, 0.5);
    if (Number.isFinite(th)) tHalf.push(th);
    else neverHalf += 1;
    const tc = timeToBunching(r, ctrlLevel);
    if (Number.isFinite(tc)) tCtrl.push(tc);
  }

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
    halfMinutes: round(toMinutes(mean(tHalf)), 2),
    crossControlMinutes: round(toMinutes(mean(tCtrl)), 2),
    /** 有多少个种子在整段模拟里都没到半程；>0 时上面的均值是有偏的。 */
    neverReachedHalf: neverHalf,
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

/**
 * 「多久才结团」扫描。
 *
 * 取代早先那张「稳态 CV 对 λ」的图：稳态 CV 对需求率几乎不敏感，
 * 因为聚团态是任何正需求率下的吸引子。需求率决定的是 **多快到**。
 * 所以横轴用读者能体会的「平均每隔几分钟加一次汤」，纵轴用到达时间（分钟）。
 *
 * 时长放宽到 8 小时，好让最冷清的那几档也有机会越过阈值；
 * 仍会在图上标出「一顿饭 90 分钟」这条线。
 */
function runTimeToBunch(): void {
  const intervalsMin = [2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120];
  const tauSeconds = [5, 10, 20];
  const duration = (8 * 3600) / LOOP_SECONDS; // 8 小时

  const series = tauSeconds.map((ts) => {
    const rows = intervalsMin.map((mins) => {
      const base = {
        ...SCENE_A,
        lambda: rateToLoops(mins * 60),
        tau: toLoops(ts),
        duration,
        frameDt: 0.02,
      };
      const e = ensemble(base, SWEEP_SEEDS);
      return {
        demandIntervalMinutes: mins,
        lambda: round(rateToLoops(mins * 60), 4),
        rho: round(load({ ...DEFAULT_PARAMS, ...base } as SimParams), 4),
        ...e,
      };
    });
    const desc = rows
      .map((r) => `${r.demandIntervalMinutes}分→${Number.isFinite(r.halfMinutes) ? `${r.halfMinutes}分` : '未到'}`)
      .join('  ');
    console.log(`  倒汤 ${ts}s：加汤间隔→结团半程用时  ${desc}`);
    return { tauSeconds: ts, tau: round(toLoops(ts), 5), rows };
  });

  write('time-to-bunch', {
    base: SCENE_A,
    seeds: SWEEP_SEEDS,
    loopSeconds: LOOP_SECONDS,
    mealMinutes: 90,
    durationHours: 8,
    controlCV: round(controlCV(SCENE_A.kettles!), 4),
    controlBunching: round(controlCV(SCENE_A.kettles!) / maxGapCV(SCENE_A.kettles!), 4),
    series,
  });
}

/** 服务员巡台：定期把壶重新摊开，能压回多少。周期按分钟给，便于正文引用。 */
function runReset(): void {
  const periodsMin = [0, 60, 30, 20, 10, 5];
  const rows = periodsMin.map((mins) => {
    const p = mins === 0 ? 0 : (mins * 60) / LOOP_SECONDS;
    const base = { ...SCENE_A, resetPeriod: p };
    const e = ensemble(base, SWEEP_SEEDS);
    console.log(
      `  ${mins === 0 ? '不重整   ' : `每 ${String(mins).padStart(2)} 分钟`} ` +
        `结团指数=${e.steadyBunching} 平均等待=${e.meanWaitSeconds}s`,
    );
    return { resetMinutes: mins, resetPeriod: round(p, 4), ...e };
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

  // 两个端点：均匀排布的 CV 是 0，全挤在一点是 sqrt(K-1)。
  const uniform = gapCV([0, 0.25, 0.5, 0.75]);
  if (Math.abs(uniform) > 1e-12) throw new Error(`均匀排布的 CV 应为 0，得到 ${uniform}`);
  const clumped = gapCV([0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
  if (Math.abs(clumped - maxGapCV(6)) > 1e-9) {
    throw new Error(`全挤一点的 CV 应为 ${maxGapCV(6)}，得到 ${clumped}`);
  }

  // 没有需求就不该有结团。这条挡住「核凭空造出聚集」这类最难发现的错。
  // 用空店（occupancy=0）而不是极小的 λ：前者确定地产生零需求，后者只是概率上如此。
  const idle = simulate({ ...SCENE_A, occupancy: 0, duration: 20 }, 'check-idle');
  const idleSummary = summarize(idle);
  if (idleSummary.served !== 0) {
    throw new Error(`λ=0 时不该有任何服务，得到 ${idleSummary.served} 次`);
  }
  const maxIdleCV = Math.max(...idle.gapCV);
  if (maxIdleCV > 1e-12) throw new Error(`λ=0 时 CV 应恒为 0，最大值却是 ${maxIdleCV}`);
  if (Number.isFinite(timeToBunching(idle, 0.5))) {
    throw new Error('λ=0 时不该达到半程结团');
  }

  // 结团时间必须随阈值单调：到九成不可能早于到半程。
  const tHalf = timeToBunching(a, 0.5);
  const tNinety = timeToBunching(a, 0.9);
  if (Number.isFinite(tNinety) && !(tNinety >= tHalf)) {
    throw new Error(`结团时间非单调：半程 ${tHalf} 圈，九成 ${tNinety} 圈`);
  }

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
  'time-to-bunch': runTimeToBunch,
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
