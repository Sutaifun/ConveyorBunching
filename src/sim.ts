/**
 * 回转带上的串车：唯一模拟核。
 *
 * 这个文件是全项目唯一实现物理的地方。它不依赖 Vue、DOM、canvas、Node，
 * 既给浏览器里的播放器调用，也给 Node CLI 批处理调用。规则见
 * docs/科学小品指导.md 第 3、4 节；改物理只改这里。
 */

// ---------------------------------------------------------------- 随机数

export type Seed = number | string;

/** 字符串/数字 → uint32。FNV-1a，够用且两端行为一致。 */
export function hashSeed(seed: Seed): number {
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32。选它是因为实现短到可以在文章里说清楚，且浏览器与 Node 逐位一致。
 * 禁止在本项目任何地方使用 Math.random()。
 */
export function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 速率为 rate 的指数间隔。 */
function expDraw(rand: () => number, rate: number): number {
  return -Math.log(1 - rand()) / rate;
}

// ---------------------------------------------------------------- 参数

export interface SimParams {
  /** 座位数 M，均匀分布在圆周上；座位 0 位于原点（厨房窗口）。 */
  seats: number;
  /** 公用物件数 K（汤壶或姜盒），开餐时均匀放置。 */
  kettles: number;
  /** 上座率 0..1。哪些座位有人由种子决定；1 表示满座。 */
  occupancy: number;
  /** 每位在座客人的需求速率 λ，单位 圈^-1。 */
  lambda: number;
  /** 单次占用时间 τ（倒汤 / 夹姜），单位 圈。 */
  tau: number;
  /** 模拟总时长，单位 圈。 */
  duration: number;
  /** 帧快照间隔，单位 圈。 */
  frameDt: number;
  /** 个别座位的 λ 覆盖（场景 B：某桌特别爱吃姜）。 */
  lambdaOverrides?: Record<number, number>;
  /** 服务员每隔多少圈把物件重新均匀摊开；0 或省略表示不重整。 */
  resetPeriod?: number;

  // ---- 容量与回壶（低优先级增强，默认关闭；见指导第 5 节）
  capacityEnabled?: boolean;
  /** 满载可加汤次数 C。 */
  capacity?: number;
  /** 低于该比例且经过原点时进入补汤。 */
  refillThreshold?: number;
  /** 补汤停留时长，单位 τ。 */
  refillDwell?: number;
  /** true 表示原点一次只补一把（像只有一个水龙头）。 */
  refillExclusive?: boolean;
}

export const DEFAULT_PARAMS: SimParams = {
  seats: 40,
  kettles: 6,
  occupancy: 1,
  lambda: 0.17,
  tau: 0.1,
  duration: 200,
  frameDt: 0.05,
  capacityEnabled: false,
  capacity: 10,
  refillThreshold: 0.4,
  refillDwell: 3,
  refillExclusive: false,
};

// ---------------------------------------------------------------- 输出

/** 0 = 在带上，1 = 被客人拿着，2 = 在原点补汤。 */
export type KettleState = 0 | 1 | 2;

export interface SimResult {
  params: SimParams;
  seed: Seed;
  /** 哪些座位有人。 */
  occupied: boolean[];
  /** 帧时刻。 */
  times: number[];
  /** positions[frame][kettle]，圆周坐标 0..1。 */
  positions: number[][];
  /** states[frame][kettle]，见 KettleState。 */
  states: KettleState[][];
  /** 每帧的间距变异系数 CV = σ/μ；K < 2 时为 NaN。 */
  gapCV: number[];
  /** 每次「从产生需求到拿到物件」的等待时长。 */
  waits: number[];
  /** 每次取用发生的时刻，与 waits 一一对应。 */
  waitTimes: number[];
  /** 每个座位被服务的次数。 */
  servedBySeat: number[];
  /** 每个座位累计「手上拿着物件」的时长。 */
  heldTimeBySeat: number[];
  /** 每把物件被取用的次数。 */
  usesByKettle: number[];
  /** 每把物件的补汤次数（未启用容量时全为 0）。 */
  refillsByKettle: number[];
  /** 因为「手边已有待服务需求」而被丢弃的需求数。 */
  droppedDemands: number;
  /** 结束时仍在等待的需求数。 */
  pendingAtEnd: number;
}

// ---------------------------------------------------------------- 事件堆

/**
 * 事件优先级。同一时刻的处理顺序必须写死在核里，播放器不得另排。
 * release 先于 demand，demand 先于 arrival：
 *   - 放回的物件在同一瞬间先回到带上，才可能被随后的到达逻辑看到；
 *   - 与物件到达同一瞬间产生的需求算「已在等」，能拿到这一把。
 */
const P_RELEASE = 0;
const P_DEMAND = 1;
const P_ARRIVAL = 2;
const P_REFILL_END = 3;
const P_RESET = 4;

interface Event {
  t: number;
  p: number;
  /** 稳定排序用：同 (t, p) 时按实体下标。 */
  i: number;
  kind: 'release' | 'demand' | 'arrival' | 'refillEnd' | 'reset';
  /** arrival / release / refillEnd：物件下标。demand：座位下标。 */
  id: number;
  /** arrival：到达的座位下标。 */
  seat?: number;
  /** arrival：物件轨迹版本号，用于惰性作废。 */
  seq?: number;
}

function eventLess(a: Event, b: Event): boolean {
  if (a.t !== b.t) return a.t < b.t;
  if (a.p !== b.p) return a.p < b.p;
  return a.i < b.i;
}

/** 二叉最小堆。只为了让事件顺序完全确定，不追求花哨。 */
class EventHeap {
  private h: Event[] = [];

  get size(): number {
    return this.h.length;
  }

  push(e: Event): void {
    const h = this.h;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (eventLess(h[i], h[parent])) {
        [h[i], h[parent]] = [h[parent], h[i]];
        i = parent;
      } else break;
    }
  }

  pop(): Event | undefined {
    const h = this.h;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && eventLess(h[l], h[m])) m = l;
        if (r < h.length && eventLess(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------- 几何辅助

const EPS = 1e-12;

function wrap(x: number): number {
  const y = x % 1;
  return y < 0 ? y + 1 : y;
}

/** 圆周上一组位置的间距变异系数。 */
export function gapCV(positions: number[]): number {
  const k = positions.length;
  if (k < 2) return NaN;
  const sorted = [...positions].sort((a, b) => a - b);
  const gaps = new Array<number>(k);
  for (let i = 0; i < k - 1; i++) gaps[i] = sorted[i + 1] - sorted[i];
  gaps[k - 1] = 1 - sorted[k - 1] + sorted[0];
  const mean = 1 / k;
  let acc = 0;
  for (const g of gaps) acc += (g - mean) * (g - mean);
  return Math.sqrt(acc / k) / mean;
}

/**
 * 对照用：把 K 个点均匀随机投在圆周上时的间距 CV（折断棍子）。
 * 用来在图上区分「动力学结团」与「随机看起来像扎堆」。
 */
export function randomGapCV(k: number, rand: () => number): number {
  if (k < 2) return NaN;
  const pts = new Array<number>(k);
  for (let i = 0; i < k; i++) pts[i] = rand();
  return gapCV(pts);
}

/**
 * CV 的上限随 K 变化，所以跨 K 比较不能看裸 CV。
 * 全部挤成一点时 gaps = [0,…,0,1]，此时 CV = sqrt(K-1)。
 */
export function maxGapCV(k: number): number {
  return k < 2 ? NaN : Math.sqrt(k - 1);
}

/**
 * 归一化结团指数 CV / sqrt(K-1) ∈ [0, 1]：
 * 0 = 完全均匀，1 = 全挤成一点。这才是可以跨 K 比较的量。
 * 均匀随机投放的参考值约为 1/sqrt(K+1)。
 */
export function bunchingIndex(positions: number[]): number {
  const k = positions.length;
  if (k < 2) return NaN;
  return gapCV(positions) / maxGapCV(k);
}

// ---------------------------------------------------------------- 主循环

export function simulate(userParams: Partial<SimParams>, seed: Seed): SimResult {
  const params: SimParams = { ...DEFAULT_PARAMS, ...userParams };
  const {
    seats: M,
    kettles: K,
    lambda,
    tau,
    duration,
    frameDt,
    occupancy,
    lambdaOverrides,
  } = params;

  if (M < 1 || K < 1) throw new Error('seats 和 kettles 必须 ≥ 1');
  if (tau <= 0 || lambda <= 0) throw new Error('tau 和 lambda 必须 > 0');

  const capacityEnabled = params.capacityEnabled ?? false;
  const capacity = params.capacity ?? 10;
  const refillAt = (params.refillThreshold ?? 0.4) * capacity;
  const refillDwell = (params.refillDwell ?? 3) * tau;
  const refillExclusive = params.refillExclusive ?? false;
  const resetPeriod = params.resetPeriod ?? 0;

  const master = hashSeed(seed);
  const seatPos = (j: number): number => j / M;

  // 上座：每座一条独立随机流，这样改 K 不会改变「今天来了哪些客人」。
  const occRand = mulberry32(hashSeed(`${master}:occupancy`));
  const occupied = new Array<boolean>(M);
  for (let j = 0; j < M; j++) occupied[j] = occupancy >= 1 ? true : occRand() < occupancy;

  // 每座一条独立需求流，理由同上：K=1 与 K=6 面对同一批客人。
  const seatRand: Array<() => number> = new Array(M);
  for (let j = 0; j < M; j++) seatRand[j] = mulberry32(hashSeed(`${master}:seat:${j}`));
  const seatRate = (j: number): number => lambdaOverrides?.[j] ?? lambda;

  // 物件状态
  const state = new Array<KettleState>(K).fill(0);
  const refPos = new Array<number>(K); // 上次事件时的位置
  const refTime = new Array<number>(K).fill(0);
  const seq = new Array<number>(K).fill(0);
  const heldSeat = new Array<number>(K).fill(-1);
  const remaining = new Array<number>(K).fill(capacity);
  const usesByKettle = new Array<number>(K).fill(0);
  const refillsByKettle = new Array<number>(K).fill(0);

  // 座位状态
  const pending = new Array<boolean>(M).fill(false);
  const pendingSince = new Array<number>(M).fill(0);
  const holding = new Array<boolean>(M).fill(false);
  const servedBySeat = new Array<number>(M).fill(0);
  const heldTimeBySeat = new Array<number>(M).fill(0);

  const waits: number[] = [];
  const waitTimes: number[] = [];
  let droppedDemands = 0;
  let refillBusy = false;
  const refillQueue: number[] = [];

  const heap = new EventHeap();
  let counter = 0;

  /** 给在带上的物件排下一次「到达某座」。 */
  function scheduleArrival(k: number, from: number, t: number): void {
    // from 是当前位置，找下一个座位。
    const scaled = from * M;
    let nextIdx = Math.floor(scaled + EPS) + 1;
    let dist = nextIdx / M - from;
    if (dist <= EPS) {
      nextIdx += 1;
      dist = nextIdx / M - from;
    }
    const seat = ((nextIdx % M) + M) % M;
    heap.push({
      t: t + dist,
      p: P_ARRIVAL,
      i: counter++,
      kind: 'arrival',
      id: k,
      seat,
      seq: seq[k],
    });
  }

  function putOnBelt(k: number, pos: number, t: number): void {
    state[k] = 0;
    refPos[k] = wrap(pos);
    refTime[k] = t;
    seq[k] += 1;
    scheduleArrival(k, refPos[k], t);
  }

  // 开餐：均匀放置
  for (let k = 0; k < K; k++) {
    refPos[k] = k / K;
    refTime[k] = 0;
    state[k] = 0;
    scheduleArrival(k, refPos[k], 0);
  }

  // 每座第一次需求
  for (let j = 0; j < M; j++) {
    if (!occupied[j]) continue;
    const dt = expDraw(seatRand[j], seatRate(j));
    if (dt <= duration) {
      heap.push({ t: dt, p: P_DEMAND, i: counter++, kind: 'demand', id: j });
    }
  }

  if (resetPeriod > 0) {
    for (let t = resetPeriod; t <= duration; t += resetPeriod) {
      heap.push({ t, p: P_RESET, i: counter++, kind: 'reset', id: 0 });
    }
  }

  // 帧输出
  const times: number[] = [];
  const positions: number[][] = [];
  const states: KettleState[][] = [];
  const gapCVs: number[] = [];

  function posAt(k: number, t: number): number {
    if (state[k] === 0) return wrap(refPos[k] + (t - refTime[k]));
    return refPos[k]; // 被拿着或补汤中，位置不动
  }

  function emitFrame(t: number): void {
    const pos = new Array<number>(K);
    const st = new Array<KettleState>(K);
    for (let k = 0; k < K; k++) {
      pos[k] = posAt(k, t);
      st[k] = state[k];
    }
    times.push(t);
    positions.push(pos);
    states.push(st);
    gapCVs.push(gapCV(pos));
  }

  // 帧时刻用整数索引算，避免反复加法累积浮点误差。
  let frameIdx = 0;

  function advanceFrames(upTo: number): void {
    for (;;) {
      const t = frameIdx * frameDt;
      if (t > upTo + EPS || t > duration + EPS) break;
      emitFrame(t);
      frameIdx += 1;
    }
  }

  // ---- 事件循环
  for (;;) {
    const e = heap.pop();
    if (!e || e.t > duration) break;
    advanceFrames(e.t);
    const t = e.t;

    if (e.kind === 'demand') {
      const j = e.id;
      // 自由运行的泊松时钟：占用中或已在等，则这次需求被丢弃（不累积排队）。
      if (pending[j] || holding[j]) {
        droppedDemands += 1;
      } else {
        pending[j] = true;
        pendingSince[j] = t;
      }
      const dt = expDraw(seatRand[j], seatRate(j));
      const nt = t + dt;
      if (nt <= duration) {
        heap.push({ t: nt, p: P_DEMAND, i: counter++, kind: 'demand', id: j });
      }
      continue;
    }

    if (e.kind === 'release') {
      const k = e.id;
      const j = heldSeat[k];
      heldSeat[k] = -1;
      holding[j] = false;
      heldTimeBySeat[j] += tau;
      putOnBelt(k, seatPos(j), t);
      continue;
    }

    if (e.kind === 'refillEnd') {
      const k = e.id;
      remaining[k] = capacity;
      refillsByKettle[k] += 1;
      putOnBelt(k, 0, t);
      if (refillExclusive) {
        refillBusy = false;
        const nxt = refillQueue.shift();
        if (nxt !== undefined && state[nxt] === 2) {
          refillBusy = true;
          heap.push({
            t: t + refillDwell,
            p: P_REFILL_END,
            i: counter++,
            kind: 'refillEnd',
            id: nxt,
          });
        }
      }
      continue;
    }

    if (e.kind === 'reset') {
      // 服务员巡台：把还在带上的物件重新均匀摊开。被拿着的不动。
      const onBelt: number[] = [];
      for (let k = 0; k < K; k++) if (state[k] === 0) onBelt.push(k);
      onBelt.forEach((k, idx) => {
        putOnBelt(k, idx / onBelt.length, t);
      });
      continue;
    }

    // arrival
    const k = e.id;
    if (state[k] !== 0 || e.seq !== seq[k]) continue; // 已作废
    const seat = e.seat!;
    refPos[k] = seatPos(seat);
    refTime[k] = t;

    // 原点（= 座位 0 的位置）就是厨房窗口。补汤优先于服务。
    if (capacityEnabled && seat === 0 && remaining[k] <= refillAt + EPS) {
      state[k] = 2;
      seq[k] += 1;
      if (refillExclusive && refillBusy) {
        refillQueue.push(k);
      } else {
        refillBusy = true;
        heap.push({
          t: t + refillDwell,
          p: P_REFILL_END,
          i: counter++,
          kind: 'refillEnd',
          id: k,
        });
      }
      continue;
    }

    const hasSoup = !capacityEnabled || remaining[k] > 0;
    if (pending[seat] && hasSoup) {
      pending[seat] = false;
      state[k] = 1;
      seq[k] += 1;
      heldSeat[k] = seat;
      holding[seat] = true;
      if (capacityEnabled) remaining[k] -= 1;
      usesByKettle[k] += 1;
      servedBySeat[seat] += 1;
      waits.push(t - pendingSince[seat]);
      waitTimes.push(t);
      heap.push({ t: t + tau, p: P_RELEASE, i: counter++, kind: 'release', id: k });
    } else {
      scheduleArrival(k, refPos[k], t);
    }
  }

  advanceFrames(duration);

  let pendingAtEnd = 0;
  for (let j = 0; j < M; j++) if (pending[j]) pendingAtEnd += 1;

  return {
    params,
    seed,
    occupied,
    times,
    positions,
    states,
    gapCV: gapCVs,
    waits,
    waitTimes,
    servedBySeat,
    heldTimeBySeat,
    usesByKettle,
    refillsByKettle,
    droppedDemands,
    pendingAtEnd,
  };
}

// ---------------------------------------------------------------- 汇总

export interface Summary {
  /** 后 half 段的平均 CV，作为「稳态结团程度」。 */
  steadyCV: number;
  /** 同上，但归一化到 [0,1]，可跨 K 比较。 */
  steadyBunching: number;
  finalCV: number;
  meanWait: number;
  p90Wait: number;
  served: number;
  droppedDemands: number;
  /** 各物件取用次数的不均衡度（max/mean）。 */
  useImbalance: number;
}

export function summarize(r: SimResult, tailFraction = 0.5): Summary {
  const n = r.times.length;
  const from = Math.floor(n * (1 - tailFraction));
  let cvAcc = 0;
  let cvN = 0;
  for (let i = from; i < n; i++) {
    if (Number.isFinite(r.gapCV[i])) {
      cvAcc += r.gapCV[i];
      cvN += 1;
    }
  }
  const tCut = r.params.duration * (1 - tailFraction);
  const tailWaits = r.waits.filter((_, i) => r.waitTimes[i] >= tCut).sort((a, b) => a - b);
  const meanWait = tailWaits.length
    ? tailWaits.reduce((a, b) => a + b, 0) / tailWaits.length
    : NaN;
  const p90Wait = tailWaits.length ? tailWaits[Math.floor(tailWaits.length * 0.9)] : NaN;
  const uses = r.usesByKettle;
  const useMean = uses.reduce((a, b) => a + b, 0) / uses.length || 1;

  const steadyCV = cvN ? cvAcc / cvN : NaN;

  return {
    steadyCV,
    steadyBunching: steadyCV / maxGapCV(r.params.kettles),
    finalCV: r.gapCV[n - 1],
    meanWait,
    p90Wait,
    served: r.waits.length,
    droppedDemands: r.droppedDemands,
    useImbalance: Math.max(...uses) / useMean,
  };
}

/**
 * 随机重投对照：把 K 个点均匀扔在圆周上，多次取平均。
 * 这是「随机也像扎堆」那条参考线——越过它，才算比随便乱扔更不均匀。
 * 用均值而不是均方根，因为要比的是逐帧 CV 的典型高度。
 *
 * 出文章数据的 cli.ts 和小玩意播放器都用这一份，所以两边的参考线必然一致。
 */
export function controlCV(k: number, samples = 4000, seed: Seed = 'control'): number {
  if (k < 2) return NaN;
  const rand = mulberry32(hashSeed(seed));
  let acc = 0;
  for (let i = 0; i < samples; i++) acc += randomGapCV(k, rand);
  return acc / samples;
}

/** 同上，但已归一化到 [0,1]，可跨 K 比较。 */
export function controlBunching(k: number): number {
  return controlCV(k) / maxGapCV(k);
}

/**
 * 折断棍子的解析值。K 个均匀随机点的间距是 Dirichlet(1,…,1)，
 * 于是 E[CV²] = (K-1)/(K+1)，即 CV 的均方根为 sqrt((K-1)/(K+1))。
 * 注意这是均方根，按 Jensen 不等式它略高于 CV 的均值；K→∞ 时两者都趋近 1。
 */
export function controlCVRmsAnalytic(k: number): number {
  return k < 2 ? NaN : Math.sqrt((k - 1) / (k + 1));
}

/**
 * 首次达到指定结团程度的时刻，单位「圈」；始终没到则返回 NaN。
 * level 用归一化结团指数（0 = 均匀，1 = 全挤成一点），因而可跨 K 比较。
 *
 * 这是比「稳态 CV」更有用的量：聚团态几乎是任何正需求率下的吸引子，
 * 需求率决定的是多久到，而不是会不会到。
 */
export function timeToBunching(r: SimResult, level: number): number {
  const ceiling = maxGapCV(r.params.kettles);
  if (!Number.isFinite(ceiling)) return NaN;
  const target = level * ceiling;
  for (let i = 0; i < r.gapCV.length; i++) {
    if (r.gapCV[i] > target) return r.times[i];
  }
  return NaN;
}

/** 便于解释的负荷参数 ρ = (在座人数 × λ × τ) / K。 */
export function load(params: SimParams, occupiedCount?: number): number {
  const occ = occupiedCount ?? Math.round(params.seats * params.occupancy);
  return (occ * params.lambda * params.tau) / params.kettles;
}
