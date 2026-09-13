<script setup lang="ts">
/**
 * 回转带上的串车 —— 小玩意播放器。规格见 docs/科学小品指导.md 第 4.9 节。
 *
 * 这个组件**不实现任何物理**。它只做三件事：把读者填的「分钟/秒」换算成核要的
 * 无量纲参数、调一次 `simulate()` 拿到帧缓冲、然后移动播放头把缓冲画出来。
 * 于是文章配图和这里看到的是同一段历史，只要种子和参数一致。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  ElButton,
  ElInput,
  ElInputNumber,
  ElRadioButton,
  ElRadioGroup,
  ElSlider,
  ElTooltip,
} from 'element-plus';
import {
  controlBunching,
  maxGapCV,
  simulate,
  type SimResult,
} from '../src/sim.ts';
import { toSimParams } from '../src/units.ts';

/** 帧缓冲的目标帧数。只影响快照密度，不影响历史——随机流与 frameDt 无关。 */
const TARGET_FRAMES = 2400;
/** 1× 播放速度 = 每墙钟秒播放多少分钟的店内时间。 */
const MINUTES_PER_SECOND = 1;
const SPEEDS = [0.5, 1, 2, 4, 8] as const;

// ---------------------------------------------------------------- 参数

/**
 * 读者面向的量，全部用现实单位。翻成核的单位一律走 `src/units.ts`，
 * 和出文章数据的 `src/cli.ts` 是同一份换算——否则同一个种子在文章
 * 和这里会给出不同的历史，而读者复现不出来时根本无从察觉。
 */
interface Draft {
  kettles: number;
  /** 每人平均多久加一次汤，分钟。 */
  demandIntervalMin: number;
  /** 倒一次汤要多久，秒。 */
  tauSeconds: number;
  /** 传送带空载一圈多久，秒。40 座回转寿司店实测 450。 */
  loopSeconds: number;
  /** 预演多长时间，分钟。 */
  durationMin: number;
  seats: number;
  seed: string;
  /** 打开时把播放头直接放在第几分钟。文章里可以链到「第 90 分钟」。 */
  startMin: number;
}

const DEFAULT_DRAFT: Draft = {
  kettles: 6,
  demandIntervalMin: 10,
  tauSeconds: 10,
  loopSeconds: 450,
  durationMin: 180,
  seats: 40,
  seed: '20260830',
  startMin: 0,
};

function readQuery(): Draft {
  const q = new URLSearchParams(window.location.search);
  const num = (key: string, fallback: number): number => {
    const v = Number(q.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    startMin: Math.max(0, Number(q.get('t')) || 0),
    kettles: Math.round(num('k', DEFAULT_DRAFT.kettles)),
    demandIntervalMin: num('interval', DEFAULT_DRAFT.demandIntervalMin),
    tauSeconds: num('tau', DEFAULT_DRAFT.tauSeconds),
    loopSeconds: num('loop', DEFAULT_DRAFT.loopSeconds),
    durationMin: num('mins', DEFAULT_DRAFT.durationMin),
    seats: Math.round(num('seats', DEFAULT_DRAFT.seats)),
    seed: q.get('seed') || DEFAULT_DRAFT.seed,
  };
}

const draft = ref<Draft>(readQuery());

const paramsOf = (d: Draft) =>
  toSimParams({
    loopSeconds: d.loopSeconds,
    seats: d.seats,
    kettles: d.kettles,
    demandEverySeconds: d.demandIntervalMin * 60,
    tauSeconds: d.tauSeconds,
    durationSeconds: d.durationMin * 60,
    targetFrames: TARGET_FRAMES,
  });

// ---------------------------------------------------------------- 运行与播放头

/** 当前这段历史对应的参数快照。改滑条不会动它，只有「从头模拟」才会。 */
const applied = ref<Draft>({ ...draft.value });
/** 帧缓冲很大且整体替换，用 shallowRef 避免 Vue 深度代理每一帧。 */
const result = shallowRef<SimResult | null>(null);
const error = ref('');

/** 播放头，单位「圈」。 */
const playhead = ref(0);
const playing = ref(false);
const speed = ref<number>(1);

const dirty = computed(
  () => JSON.stringify(draft.value) !== JSON.stringify(applied.value),
);

/** 只在首次运行时消费网址里的 `t`，之后「从头模拟」就该真的从头。 */
let startAt = draft.value.startMin;

function run(): void {
  playing.value = false;
  error.value = '';
  try {
    const d = { ...draft.value };
    result.value = simulate(paramsOf(d), d.seed);
    applied.value = d;
    // 「从头模拟」把播放头放回开头；只有首次按网址里的 t 落在指定时刻。
    playhead.value = Math.min(
      result.value.params.duration,
      (startAt * 60) / d.loopSeconds,
    );
    startAt = 0;
    syncQuery(d);
  } catch (e) {
    result.value = null;
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function queryOf(d: Draft): URLSearchParams {
  return new URLSearchParams({
    k: String(d.kettles),
    seed: d.seed,
    interval: String(d.demandIntervalMin),
    tau: String(d.tauSeconds),
    loop: String(d.loopSeconds),
    mins: String(d.durationMin),
    seats: String(d.seats),
  });
}

function syncQuery(d: Draft): void {
  window.history.replaceState(null, '', `${window.location.pathname}?${queryOf(d)}`);
}

/** 换个种子。这里不能用 Math.random —— 项目全程禁用，免得有人误当成物理噪声。 */
function rerollSeed(): void {
  draft.value.seed = String(Date.now() % 100000000);
}

/** 复制的链接带上当前时刻，对方打开就停在你正看的这一分钟。 */
const copied = ref(false);
async function copyLink(): Promise<void> {
  const q = queryOf(applied.value);
  q.set('t', minutesNow.value.toFixed(1));
  const url = `${window.location.origin}${window.location.pathname}?${q}`;
  try {
    await navigator.clipboard.writeText(url);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    error.value = '复制失败，可直接从地址栏拷贝';
  }
}

function reset(): void {
  draft.value = { ...DEFAULT_DRAFT };
  run();
}

// ---------------------------------------------------------------- 读数

const totalLoops = computed(() => result.value?.params.duration ?? 0);
const minutesNow = computed(
  () => (playhead.value * applied.value.loopSeconds) / 60,
);

/** 播放头所在帧（向下取整）以及到下一帧的插值系数。 */
const cursor = computed(() => {
  const r = result.value;
  if (!r || r.times.length === 0) return null;
  const dt = r.params.frameDt;
  const raw = playhead.value / dt;
  const i = Math.min(r.times.length - 1, Math.max(0, Math.floor(raw)));
  const j = Math.min(r.times.length - 1, i + 1);
  return { i, j, frac: i === j ? 0 : raw - i };
});

/** 当前帧的结团指数。只给数字，不画曲线——曲线是文章里 Python 的活。 */
const indexNow = computed(() => {
  const r = result.value;
  const c = cursor.value;
  if (!r || !c || r.params.kettles < 2) return null;
  return r.gapCV[c.i] / maxGapCV(r.params.kettles);
});

/**
 * 「随便乱扔」这条参考线的高度，随 K 变化。
 * 不要在这里写死阈值：K=6 时它是 0.36，K=20 时只有 0.22，写死会在最关键的
 * 那一刻（刚越过参考线）给出错误的说法。
 */
const reference = computed(() => {
  const k = result.value?.params.kettles ?? 0;
  return k < 2 ? NaN : controlBunching(k);
});

const indexHint = computed(() => {
  const v = indexNow.value;
  const ref = reference.value;
  if (v === null || !Number.isFinite(ref)) return '只有一件物品，谈不上「间距」';
  if (v < ref * 0.5) return '还很均匀';
  if (v < ref) return '开始散开，但还没到随便乱扔的程度';
  if (v < 0.75) return '已经比随便乱扔更不均匀了';
  if (v < 0.92) return '明显结团';
  return '基本挤成一坨';
});

/** 等待时长的前缀和，每次「从头模拟」算一次。 */
const waitPrefix = computed(() => {
  const r = result.value;
  if (!r) return new Float64Array(1);
  const acc = new Float64Array(r.waits.length + 1);
  for (let n = 0; n < r.waits.length; n++) acc[n + 1] = acc[n] + r.waits[n];
  return acc;
});

/**
 * 到此刻为止的取用次数与平均等待。
 * 这个读数每帧都要更新，所以用二分而不是线性扫——`waitTimes` 本来就是升序的。
 */
const servedSoFar = computed(() => {
  const r = result.value;
  if (!r) return { count: 0, meanWaitSeconds: 0 };
  const t = playhead.value;
  let lo = 0;
  let hi = r.waitTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.waitTimes[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return {
    count: lo,
    meanWaitSeconds: lo ? (waitPrefix.value[lo] / lo) * applied.value.loopSeconds : 0,
  };
});

const fmtClock = (min: number): string => {
  const m = Math.max(0, Math.floor(min));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- 绘制

const canvas = ref<HTMLCanvasElement | null>(null);
let raf = 0;
let lastTick = 0;

/** 位置 0 画在十二点（原点 = 厨房窗口），位置增大即顺时针。 */
function angleOf(pos: number): number {
  return -Math.PI / 2 + 2 * Math.PI * pos;
}

/** 帧间插值，处理跨过 0 点的回绕。 */
function lerpPos(a: number, b: number, frac: number): number {
  let to = b;
  if (to - a < -0.5) to += 1;
  const v = a + (to - a) * frac;
  return v - Math.floor(v);
}

function draw(): void {
  const el = canvas.value;
  const r = result.value;
  const c = cursor.value;
  if (!el || !r || !c) return;

  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (el.width !== w * dpr || el.height !== h * dpr) {
    el.width = w * dpr;
    el.height = h * dpr;
  }
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 34;

  // 传送带
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.stroke();

  // 座位刻度；原点那一格标成厨房窗口
  const M = r.params.seats;
  for (let j = 0; j < M; j++) {
    const a = angleOf(j / M);
    const origin = j === 0;
    ctx.strokeStyle = origin ? '#16a34a' : '#cbd5e1';
    ctx.lineWidth = origin ? 2.5 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (R + 9), cy + Math.sin(a) * (R + 9));
    ctx.lineTo(cx + Math.cos(a) * (R + (origin ? 22 : 16)), cy + Math.sin(a) * (R + (origin ? 22 : 16)));
    ctx.stroke();
  }

  // 汤壶
  const posA = r.positions[c.i];
  const posB = r.positions[c.j];
  const st = r.states[c.i];
  for (let k = 0; k < r.params.kettles; k++) {
    const held = st[k] === 1;
    const refill = st[k] === 2;
    const pos = held || refill ? posA[k] : lerpPos(posA[k], posB[k], c.frac);
    const a = angleOf(pos);
    // 被拿在手里的画到带外侧，补汤的画到内侧，一眼能看出它为什么没在动
    const rad = held ? R + 15 : refill ? R - 15 : R;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, held ? 7.5 : 6.5, 0, 2 * Math.PI);
    ctx.fillStyle = held ? '#c2410c' : refill ? '#16a34a' : '#0369a1';
    ctx.fill();
    if (held) {
      ctx.strokeStyle = '#fff7ed';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // 中心读数
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1e293b';
  ctx.font = '600 26px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(fmtClock(minutesNow.value), cx, cy - 2);
  ctx.font = '12px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('开餐后', cx, cy - 24);
  if (indexNow.value !== null) {
    ctx.fillText(`结团指数 ${indexNow.value.toFixed(2)}`, cx, cy + 20);
  }
}

function tick(now: number): void {
  raf = requestAnimationFrame(tick);
  const dtMs = lastTick ? now - lastTick : 0;
  lastTick = now;

  if (playing.value && dtMs > 0) {
    const simMinutes = (dtMs / 1000) * MINUTES_PER_SECOND * speed.value;
    const next = playhead.value + (simMinutes * 60) / applied.value.loopSeconds;
    // 播到缓冲末尾就停。第一版不追加计算。
    if (next >= totalLoops.value) {
      playhead.value = totalLoops.value;
      playing.value = false;
    } else {
      playhead.value = next;
    }
  }
  draw();
}

function togglePlay(): void {
  if (!result.value) return;
  if (playhead.value >= totalLoops.value) playhead.value = 0;
  playing.value = !playing.value;
}

/** 时间轴按分钟走，读者不需要知道「圈」。 */
const scrubMinutes = computed({
  get: () => minutesNow.value,
  set: (min: number) => {
    playhead.value = (min * 60) / applied.value.loopSeconds;
  },
});

function nudge(minutes: number): void {
  const next = playhead.value + (minutes * 60) / applied.value.loopSeconds;
  playhead.value = Math.min(totalLoops.value, Math.max(0, next));
}

function onKey(e: KeyboardEvent): void {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'ArrowLeft') {
    nudge(-5);
  } else if (e.code === 'ArrowRight') {
    nudge(5);
  }
}

onMounted(() => {
  run();
  raf = requestAnimationFrame(tick);
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey);
});

watch(speed, () => {
  lastTick = 0;
});
</script>

<template>
  <div class="kp">
    <header class="kp__head">
      <h3>回转带上的串车</h3>
      <p>
        开餐时汤壶均匀摆在回转带上。顾客从面前拿下来加汤，加完放回面前。
        过一个小时，它们还均匀吗？
      </p>
    </header>

    <div class="kp__body">
      <section class="kp__stage">
        <canvas ref="canvas" class="kp__canvas" />

        <ul class="kp__legend">
          <li><i class="dot dot--belt" />在带上</li>
          <li><i class="dot dot--held" />正被客人拿着</li>
          <li><i class="dot dot--origin" />原点（厨房窗口）</li>
        </ul>

        <div class="kp__timeline">
          <ElSlider
            v-model="scrubMinutes"
            :min="0"
            :max="(totalLoops * applied.loopSeconds) / 60"
            :step="0.5"
            :show-tooltip="false"
          />
          <div class="kp__clock">
            <span>{{ fmtClock(minutesNow) }}</span>
            <span class="muted">
              / {{ fmtClock((totalLoops * applied.loopSeconds) / 60) }}
            </span>
          </div>
        </div>

        <div class="kp__transport">
          <ElButton @click="nudge(-10)">« 10 分钟</ElButton>
          <ElButton type="primary" @click="togglePlay">
            {{ playing ? '暂停' : '播放' }}
          </ElButton>
          <ElButton @click="nudge(10)">10 分钟 »</ElButton>
          <ElRadioGroup v-model="speed" size="small">
            <ElRadioButton v-for="s in SPEEDS" :key="s" :value="s">
              {{ s }}×
            </ElRadioButton>
          </ElRadioGroup>
          <ElTooltip content="1× 表示每墙钟秒播放 1 分钟店内时间" placement="top">
            <span class="kp__hint">?</span>
          </ElTooltip>
        </div>

        <p class="kp__readout">
          <strong>{{ indexHint }}</strong>
          <span v-if="servedSoFar.count">
            · 已加汤 {{ servedSoFar.count }} 次，平均等
            {{ servedSoFar.meanWaitSeconds.toFixed(0) }} 秒
          </span>
        </p>
        <p v-if="Number.isFinite(reference)" class="kp__tip muted">
          参考：把 {{ applied.kettles }} 把壶随便扔在带上，结团指数约
          {{ reference.toFixed(2) }}；全挤成一坨是 1.00。
        </p>
        <p class="kp__tip muted">空格播放/暂停，左右方向键前后拨 5 分钟</p>
      </section>

      <aside class="kp__panel">
        <label>
          <span>汤壶数量</span>
          <ElInputNumber v-model="draft.kettles" :min="1" :max="24" size="small" />
        </label>
        <label>
          <span>每人多久加一次汤（分钟）</span>
          <ElInputNumber
            v-model="draft.demandIntervalMin"
            :min="1"
            :max="180"
            size="small"
          />
        </label>
        <label>
          <span>倒一次汤要多久（秒）</span>
          <ElInputNumber v-model="draft.tauSeconds" :min="1" :max="120" size="small" />
        </label>
        <label>
          <span>传送带一圈多久（秒）</span>
          <ElInputNumber
            v-model="draft.loopSeconds"
            :min="30"
            :max="1800"
            :step="10"
            size="small"
          />
        </label>
        <label>
          <span>座位数</span>
          <ElInputNumber v-model="draft.seats" :min="2" :max="120" size="small" />
        </label>
        <label>
          <span>预演多长时间（分钟）</span>
          <ElInputNumber
            v-model="draft.durationMin"
            :min="10"
            :max="600"
            :step="10"
            size="small"
          />
        </label>

        <label class="kp__seed">
          <span>种子</span>
          <ElInput v-model="draft.seed" size="small" placeholder="数字或任意文字" />
        </label>
        <div class="kp__seedrow">
          <ElButton size="small" @click="rerollSeed">换一个</ElButton>
          <ElButton size="small" @click="copyLink">
            {{ copied ? '已复制' : '复制链接' }}
          </ElButton>
        </div>

        <ElButton
          class="kp__run"
          type="primary"
          :plain="!dirty"
          @click="run"
        >
          从头模拟
        </ElButton>
        <p v-if="dirty" class="kp__dirty">参数改了，点「从头模拟」才生效</p>
        <p v-if="error" class="kp__error">{{ error }}</p>
        <ElButton link size="small" @click="reset">恢复文章里的那一次开餐</ElButton>

        <p class="kp__note muted">
          种子、参数和当前时刻都写在网址里。把链接发给别人，对方会看到一模一样的一段开餐、
          停在同一分钟。
        </p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.kp {
  --ink: #1e293b;
  --muted: #64748b;
  color: var(--ink);
}
.kp__head h3 {
  margin: 0 0 0.3em;
  font-size: 1.25rem;
}
.kp__head p {
  margin: 0 0 1.1em;
  max-width: 46em;
  color: var(--muted);
  line-height: 1.7;
}
.kp__body {
  display: flex;
  flex-wrap: wrap;
  gap: 1.75rem;
  align-items: flex-start;
}
.kp__stage {
  flex: 1 1 380px;
  min-width: 320px;
}
.kp__canvas {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  max-height: 460px;
}
.kp__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 1.1rem;
  margin: 0.2rem 0 1rem;
  padding: 0;
  list-style: none;
  font-size: 0.82rem;
  color: var(--muted);
}
.kp__legend li {
  display: flex;
  align-items: center;
  gap: 0.4em;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.dot--belt {
  background: #0369a1;
}
.dot--held {
  background: #c2410c;
}
.dot--origin {
  background: #16a34a;
}
.kp__clock {
  display: flex;
  justify-content: space-between;
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
}
.kp__transport {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
  margin: 0.9rem 0 0.6rem;
}
.kp__hint {
  display: inline-grid;
  place-items: center;
  width: 1.25em;
  height: 1.25em;
  border: 1px solid #cbd5e1;
  border-radius: 50%;
  color: var(--muted);
  font-size: 0.75rem;
  cursor: help;
}
.kp__readout {
  margin: 0.4rem 0 0.2rem;
  font-size: 0.9rem;
}
.kp__tip,
.kp__note,
.muted {
  color: var(--muted);
}
.kp__tip {
  margin: 0;
  font-size: 0.78rem;
}
.kp__panel {
  flex: 0 1 268px;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 1.1rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}
.kp__panel label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.82rem;
}
.kp__seedrow {
  display: flex;
  gap: 0.5rem;
}
.kp__run {
  margin-top: 0.4rem;
}
.kp__dirty {
  margin: 0;
  font-size: 0.78rem;
  color: #c2410c;
}
.kp__error {
  margin: 0;
  font-size: 0.8rem;
  color: #b91c1c;
}
.kp__note {
  margin: 0.3rem 0 0;
  font-size: 0.75rem;
  line-height: 1.6;
}
</style>
