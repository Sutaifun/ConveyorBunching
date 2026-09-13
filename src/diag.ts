/**
 * 临时诊断：把实测时标（40 座、一圈 7.5 分钟）代进去，看结论是否还站得住。
 * 结论抄进 docs 后删除本文件。
 */
import { simulate, maxGapCV } from './sim.ts';

const LOOP = 450; // 秒/圈，2026-08-30 回转寿司店实测
const toLoops = (seconds: number) => seconds / LOOP;
const rateToLoops = (perSeconds: number) => LOOP / perSeconds; // 「每 N 秒一次」→ 圈^-1

console.log(`一圈 ${LOOP}s = ${(LOOP / 60).toFixed(1)} 分钟`);
console.log(`一顿饭 90 分钟 = ${(5400 / LOOP).toFixed(1)} 圈；一个晚市 3 小时 = ${(10800 / LOOP).toFixed(1)} 圈\n`);

// 火锅：倒汤 10s，每人每 10 分钟加一次汤
const HOT = {
  seats: 40,
  kettles: 6,
  occupancy: 1,
  tau: toLoops(10),
  lambda: rateToLoops(600),
  frameDt: 0.02,
};
console.log(`火锅无量纲：τ=${HOT.tau.toFixed(4)} 圈，λ=${HOT.lambda.toFixed(3)} 圈⁻¹`);
console.log(`ρ = M·λ·τ/K = ${((40 * HOT.lambda * HOT.tau) / 6).toFixed(4)}（与旧时标相同，因为 λ 与 τ 反向缩放抵消）\n`);

console.log('--- 真实时标下 CV(t)：一顿饭内结团到什么程度？');
{
  const r = simulate({ ...HOT, duration: 48 }, 7);
  for (const t of [0, 1, 2, 4, 6, 8, 12, 16, 24, 36, 48]) {
    const i = Math.min(r.times.length - 1, Math.round(t / r.params.frameDt));
    const mark = t === 12 ? '  ← 一顿饭 90 分钟' : t === 24 ? '  ← 晚市 3 小时' : '';
    console.log(
      `  t=${String(t).padStart(3)} 圈 (${((t * LOOP) / 60).toFixed(0).padStart(3)} 分钟)  ` +
        `CV=${r.gapCV[i].toFixed(3)}  结团指数=${(r.gapCV[i] / maxGapCV(6)).toFixed(3)}${mark}`,
    );
  }
}

console.log('\n--- 新旧时标对比：同样 ρ，结团快慢差多少？');
for (const [name, p] of [
  ['旧假设 100s/圈', { tau: 0.1, lambda: 0.17 }],
  ['实测 450s/圈', { tau: HOT.tau, lambda: HOT.lambda }],
] as const) {
  const r = simulate({ ...HOT, ...p, duration: 200, frameDt: 0.1 }, 7);
  const half = maxGapCV(6) / 2;
  const iHalf = r.gapCV.findIndex((c) => c > half);
  const tHalf = iHalf < 0 ? NaN : r.times[iHalf];
  console.log(
    `${name.padEnd(16)} 越过半程用 ${Number.isNaN(tHalf) ? '未到' : `${tHalf.toFixed(1)} 圈`}` +
      `${Number.isNaN(tHalf) ? '' : ` = ${((tHalf * LOOP) / 60).toFixed(0)} 分钟`}`,
  );
}

console.log('\n--- 姜片（K=1）实测时标：夹一次 5s，每人每 15 分钟想吃一次');
{
  const g = {
    seats: 40,
    kettles: 1,
    occupancy: 1,
    tau: toLoops(5),
    lambda: rateToLoops(900),
    duration: 24,
    frameDt: 0.02,
  };
  const r = simulate(g, 'ginger-1');
  const waits = r.waits.slice().sort((a, b) => a - b);
  const p = (q: number) => (waits[Math.floor(waits.length * q)] * LOOP).toFixed(0);
  console.log(`  服务 ${r.waits.length} 次，等待中位数 ${p(0.5)}s，九成分位 ${p(0.9)}s，最长 ${(waits[waits.length - 1] * LOOP).toFixed(0)}s`);
}
