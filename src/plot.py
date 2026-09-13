"""
读 data/*.json 出图到 figures/。

这里只画图，不做物理：随机数、事件推进、统计量全部来自 src/sim.ts。
先跑 `npm run sim` 生成 data/，再跑本脚本。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FIGS = ROOT / "figures"

# 沙箱里 ~/.matplotlib 可能不可写，先把缓存指到工作区内。
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplcache"))
(ROOT / ".mplcache").mkdir(exist_ok=True)

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib import font_manager  # noqa: E402

# ---------------------------------------------------------------- 字体

_CJK_CANDIDATES = [
    "PingFang SC",
    "Hiragino Sans GB",
    "Heiti SC",
    "Songti SC",
    "Arial Unicode MS",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "Microsoft YaHei",
    "SimHei",
]


def setup_font() -> bool:
    """挑一个可用的中文字体。找不到就回退英文标签，免得图里全是方框。"""
    available = {f.name for f in font_manager.fontManager.ttflist}
    for name in _CJK_CANDIDATES:
        if name in available:
            plt.rcParams["font.family"] = [name]
            plt.rcParams["axes.unicode_minus"] = False
            print(f"中文字体：{name}")
            return True
    print("警告：没找到中文字体，图上改用英文标签")
    return False


HAS_CJK = setup_font()


def L(zh: str, en: str) -> str:
    return zh if HAS_CJK else en


plt.rcParams.update(
    {
        "figure.dpi": 150,
        "savefig.dpi": 150,
        "savefig.bbox": "tight",
        "axes.grid": True,
        "grid.alpha": 0.25,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "legend.frameon": False,
        "font.size": 11,
    }
)

C_KETTLE = "#c2410c"
C_ACCENT = "#0369a1"
C_CTRL = "#94a3b8"
C_MEAL = "#16a34a"

# ---------------------------------------------------------------- 工具


def load(name: str) -> dict:
    path = DATA / f"{name}.json"
    if not path.exists():
        sys.exit(f"缺少 {path}，请先跑 `npm run sim`")
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def save(fig, name: str) -> None:
    FIGS.mkdir(exist_ok=True)
    out = FIGS / f"{name}.png"
    fig.savefig(out)
    plt.close(fig)
    print(f"  → figures/{name}.png")


def minutes(loops, loop_seconds: float):
    return np.asarray(loops) * loop_seconds / 60.0


def break_wraps(y: np.ndarray, threshold: float = 0.5) -> np.ndarray:
    """在圆周坐标跳变处插入 NaN，避免画出横跨整幅图的假线段。"""
    out = y.astype(float).copy()
    jumps = np.abs(np.diff(out)) > threshold
    out[1:][jumps] = np.nan
    return out


# ---------------------------------------------------------------- 图 1：时空图


def fig_spacetime() -> None:
    d = load("scene-a")
    loop = d["loopSeconds"]
    t = np.asarray(d["times"])
    pos = np.asarray(d["positions"])  # (帧, 壶)
    states = np.asarray(d["states"])
    k = pos.shape[1]

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(9.5, 7.6), gridspec_kw={"height_ratios": [1, 1.25]}
    )

    # 上：真实位置，只看开餐后前 30 分钟
    window = 30 * 60 / loop
    m = t <= window
    tm = minutes(t[m], loop)
    for i in range(k):
        ax1.plot(tm, break_wraps(pos[m, i]), lw=1.0, alpha=0.85)
        held = states[m, i] == 1
        ax1.plot(
            tm[held], pos[m, i][held], ".", ms=2.2, color=C_KETTLE, zorder=3
        )
    ax1.set_xlim(0, 30)
    ax1.set_ylim(0, 1)
    ax1.set_xlabel(L("开餐后（分钟）", "minutes after opening"))
    ax1.set_ylabel(L("在圆周上的位置", "position on the loop"))
    ax1.set_title(
        L(
            f"开餐后前 30 分钟：{k} 把汤壶的真实轨迹（橙点 = 正被客人拿着）",
            f"first 30 min: trajectories of {k} kettles (orange = being held)",
        ),
        loc="left",
    )

    # 下：共动坐标系，仍留在圆周上（0 和 1 是同一点）。
    # 没被拿过的壶在这个视角里是一条水平线；被拿一次就往下掉 τ。
    # 注意别画展开后的累计相位：相差整整一圈其实是同一个位置，会假装成两股。
    tm_all = minutes(t, loop)
    for i in range(k):
        ax2.plot(tm_all, break_wraps((pos[:, i] - t) % 1.0), lw=1.2)
    meal = d["mealLoops"] * loop / 60
    ax2.axvline(meal, color=C_MEAL, ls="--", lw=1.2)
    ax2.text(
        meal + 2, 0.97, L("一顿饭 90 分钟", "one meal, 90 min"), color=C_MEAL, va="top", fontsize=10
    )
    ax2.set_xlabel(L("开餐后（分钟）", "minutes after opening"))
    ax2.set_ylabel(L("共动坐标下的位置（0 与 1 是同一点）", "co-rotating position (0 = 1)"))
    ax2.set_title(
        L(
            "共动视角：扣掉传送带本身的转动。开餐时六条线均匀分开，之后并成一条",
            "co-rotating frame: six even lines at opening, one strand later",
        ),
        loc="left",
    )
    ax2.set_xlim(0, tm_all[-1])
    ax2.set_ylim(0, 1)

    fig.suptitle(
        L(
            f"回转火锅：{d['params']['seats']} 座、{k} 把加汤壶、一圈 {loop/60:.1f} 分钟"
            f"（种子 {d['seed']}）",
            f"hotpot: {d['params']['seats']} seats, {k} kettles, {loop/60:.1f} min per lap",
        ),
        y=1.0,
        fontsize=12,
    )
    fig.tight_layout()
    save(fig, "fig1-spacetime")


# ---------------------------------------------------------------- 图 2：结团进程


def fig_bunching() -> None:
    d = load("scene-a")
    loop = d["loopSeconds"]
    t = minutes(d["times"], loop)
    cv = np.asarray(d["gapCV"])
    ceiling = d["maxCV"]
    idx = cv / ceiling
    ctrl = d["controlBunching"]

    fig, ax = plt.subplots(figsize=(9.5, 5.0))
    ax.plot(t, idx, lw=1.5, color=C_KETTLE)
    ax.axhline(1.0, color="#475569", ls=":", lw=1.2)
    ax.text(t[-1], 1.0, L("  全挤成一坨", "  fully bunched"), va="center", fontsize=10)
    ax.axhline(ctrl, color=C_CTRL, ls="--", lw=1.2)
    ax.text(
        t[-1],
        ctrl,
        L("  随便乱扔的水平", "  random reshuffle"),
        va="center",
        color="#64748b",
        fontsize=10,
    )

    meal = d["mealLoops"] * loop / 60
    ax.axvline(meal, color=C_MEAL, ls="--", lw=1.2)
    ax.text(meal + 2, 0.05, L("一顿饭 90 分钟", "one meal"), color=C_MEAL, fontsize=10)

    for mark in (16, 30, 90):
        if mark > t[-1]:
            continue
        j = int(np.argmin(np.abs(t - mark)))
        ax.plot([t[j]], [idx[j]], "o", ms=5, color=C_ACCENT, zorder=4)
        ax.annotate(
            f"{mark} {L('分钟', 'min')}\n{idx[j]:.2f}",
            (t[j], idx[j]),
            textcoords="offset points",
            xytext=(6, -22),
            fontsize=9.5,
            color=C_ACCENT,
        )

    ax.set_ylim(0, 1.12)
    ax.set_xlim(0, t[-1])
    ax.set_xlabel(L("开餐后（分钟）", "minutes after opening"))
    ax.set_ylabel(L("结团指数（0 = 均匀，1 = 全挤成一坨）", "bunching index"))
    ax.set_title(
        L(
            "均匀排布撑不过一顿饭：16 分钟越过「随便乱扔」，25 分钟走完一半，一小时基本到顶",
            "evenly spaced does not survive one meal",
        ),
        loc="left",
    )
    save(fig, "fig2-bunching")


# ---------------------------------------------------------------- 图 3：多久才结团


def fig_time_to_bunch() -> None:
    d = load("time-to-bunch")
    fig, ax = plt.subplots(figsize=(9.5, 5.2))

    for s, color, marker in zip(
        d["series"], [C_CTRL, C_KETTLE, C_ACCENT], ["s", "o", "^"]
    ):
        rows = s["rows"]
        x = [r["demandIntervalMinutes"] for r in rows]
        y = [r["halfMinutes"] for r in rows]
        ax.plot(
            x,
            y,
            marker=marker,
            ms=5,
            lw=1.6,
            color=color,
            label=L(f"倒一次汤 {s['tauSeconds']} 秒", f"pour {s['tauSeconds']}s"),
        )

    meal = d["mealMinutes"]
    ax.axhline(meal, color=C_MEAL, ls="--", lw=1.2)
    ax.annotate(
        L("一顿饭 90 分钟：线在这下面，就是吃完前已经挤好了", "one meal = 90 min"),
        xy=(0.03, meal),
        xycoords=("axes fraction", "data"),
        xytext=(0, 5),
        textcoords="offset points",
        color=C_MEAL,
        fontsize=10,
    )

    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xticks([2, 3, 5, 10, 20, 30, 60, 120])
    ax.get_xaxis().set_major_formatter(matplotlib.ticker.ScalarFormatter())
    ax.set_yticks([10, 20, 50, 100, 200, 400])
    ax.get_yaxis().set_major_formatter(matplotlib.ticker.ScalarFormatter())
    ax.set_xlabel(L("每人平均多久加一次汤（分钟）", "minutes between refills per person"))
    ax.set_ylabel(L("结团走完一半所需时间（分钟）", "minutes to reach half bunching"))
    ax.set_title(
        L(
            "需求快慢只决定「多久挤好」，不决定「会不会挤」",
            "demand rate sets how fast, not whether",
        ),
        loc="left",
    )
    ax.legend(loc="upper left")
    save(fig, "fig3-time-to-bunch")


# ---------------------------------------------------------------- 图 4：壶的数量


def fig_kettle_count() -> None:
    d = load("sweep-k")
    rows = [r for r in d["rows"] if r["kettles"] >= 2]
    k = [r["kettles"] for r in rows]
    idx = [r["steadyBunching"] for r in rows]
    ctrl = [r["controlBunching"] for r in rows]

    all_rows = d["rows"]
    kw = [r["kettles"] for r in all_rows]
    wait = [r["meanWaitSeconds"] for r in all_rows]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.5, 4.4))

    ax1.plot(k, idx, "o-", color=C_KETTLE, lw=1.8, ms=6, label=L("仿真", "simulated"))
    ax1.plot(k, ctrl, "s--", color=C_CTRL, lw=1.4, ms=5, label=L("随便乱扔", "random"))
    ax1.set_ylim(0, 1.05)
    ax1.set_xticks(k)
    ax1.set_xlabel(L("壶的数量 K", "number of kettles K"))
    ax1.set_ylabel(L("结团指数", "bunching index"))
    ax1.set_title(L("壶越多，挤得相对越松", "more kettles, relatively looser"), loc="left")
    ax1.legend()

    ax2.plot(kw, wait, "o-", color=C_ACCENT, lw=1.8, ms=6)
    ax2.set_xticks(kw)
    ax2.set_xlabel(L("壶的数量 K", "number of kettles K"))
    ax2.set_ylabel(L("平均等待（秒）", "mean wait (s)"))
    ax2.set_title(L("但顾客只在乎等多久", "what the diner feels"), loc="left")
    for x, y in zip(kw, wait):
        if x in (1, 6, 20):
            ax2.annotate(
                f"{y:.0f}s",
                (x, y),
                textcoords="offset points",
                xytext=(6, 6),
                fontsize=9.5,
                color=C_ACCENT,
            )

    fig.suptitle(
        L(
            "裸 CV 会随 K 变大而虚高（上限是 √(K−1)），所以跨 K 只能比归一化指数",
            "raw CV's ceiling grows with K; compare the normalised index",
        ),
        fontsize=10.5,
        y=1.02,
    )
    fig.tight_layout()
    save(fig, "fig4-kettle-count")


# ---------------------------------------------------------------- 图 5：姜片


def fig_ginger() -> None:
    d = load("scene-b")
    sk = load("scene-b-skewed")
    loop = d["loopSeconds"]

    waits = np.asarray(d["waits"]) * loop
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.5, 4.4))

    ax1.hist(waits, bins=28, color=C_ACCENT, alpha=0.8)
    med, p90 = np.median(waits), np.percentile(waits, 90)
    for val, label, color in (
        (med, L(f"中位 {med:.0f}s", f"median {med:.0f}s"), "#1e293b"),
        (p90, L(f"九成 {p90:.0f}s", f"p90 {p90:.0f}s"), C_KETTLE),
    ):
        ax1.axvline(val, color=color, ls="--", lw=1.3)
        ax1.text(val, ax1.get_ylim()[1] * 0.94, "  " + label, color=color, fontsize=9.5)
    ax1.axvline(loop, color=C_CTRL, ls=":", lw=1.3)
    ax1.annotate(
        L(f"  一整圈 {loop:.0f}s", f"  one lap {loop:.0f}s"),
        xy=(loop, 0.55),
        xycoords=("data", "axes fraction"),
        color="#64748b",
        fontsize=9.5,
        bbox={"facecolor": "white", "edgecolor": "none", "pad": 1.5},
    )
    ax1.set_xlabel(L("等到姜片的时间（秒）", "wait for the ginger (s)"))
    ax1.set_ylabel(L("次数", "count"))
    ax1.set_title(
        L("一盒姜片：等待几乎摊平在一整圈上", "a single box: waits are nearly flat"),
        loc="left",
    )

    # 右：热座效应到底有没有空间范围。
    # 答案是没有——增量只在热座本身，隔一桌就归零。这是「一件物品不会结团」的对照。
    hot = sk["hotSeat"]
    n = len(sk["heldTimeBySeat"])
    uni = np.asarray(sk["uniformHeldTimeBySeat"]) * loop
    skew = np.asarray(sk["heldTimeBySeat"]) * loop
    offs = np.arange(n) - hot
    dist = np.minimum(np.abs(offs), n - np.abs(offs))
    rings = np.arange(0, 8)
    delta = [float((skew - uni)[dist == r].mean()) for r in rings]

    colors = [C_KETTLE] + [C_ACCENT] * (len(rings) - 1)
    ax2.bar(rings, delta, color=colors, width=0.65)
    ax2.axhline(0, color="#475569", lw=0.9)
    ax2.set_xticks(rings)
    ax2.set_xlabel(L("到「爱吃姜那桌」的距离（几个座位）", "seats away from the hot seat"))
    ax2.set_ylabel(L("停留时长的增量（秒）", "extra dwell time (s)"))
    ax2.set_title(
        L("热座效应没有空间范围：隔一桌就归零", "the hot seat effect has no spatial reach"),
        loc="left",
    )
    ax2.annotate(
        L(f"第 {hot} 桌自己 {delta[0]:+.0f}s", f"hot seat {delta[0]:+.0f}s"),
        xy=(0, delta[0]),
        textcoords="offset points",
        xytext=(4, 4),
        fontsize=9.5,
        color=C_KETTLE,
    )

    fig.suptitle(
        L(
            "一盒姜片没法「和自己串车」——这正说明结团至少要有两件东西",
            "one box cannot bunch with itself: bunching needs at least two",
        ),
        fontsize=10.5,
        y=1.02,
    )
    fig.tight_layout()
    save(fig, "fig5-ginger")


# ---------------------------------------------------------------- 图 6：服务员巡台


def fig_reset() -> None:
    d = load("reset")
    rows = d["rows"]
    labels = [
        L("不重整", "never") if r["resetMinutes"] == 0 else f"{r['resetMinutes']}"
        for r in rows
    ]
    x = np.arange(len(rows))
    idx = [r["steadyBunching"] for r in rows]
    wait = [r["meanWaitSeconds"] for r in rows]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.5, 4.4))

    bars = ax1.bar(x, idx, color=C_KETTLE, alpha=0.88, width=0.62)
    ax1.set_ylim(0, 1.08)
    ax1.set_xticks(x)
    ax1.set_xticklabels(labels)
    ax1.set_xlabel(L("每隔多久把壶重新摊开（分钟）", "reshuffle period (min)"))
    ax1.set_ylabel(L("结团指数", "bunching index"))
    ax1.set_title(L("勤摊就压得住", "regular reshuffling works"), loc="left")
    for b, v in zip(bars, idx):
        ax1.text(
            b.get_x() + b.get_width() / 2, v + 0.02, f"{v:.2f}", ha="center", fontsize=9.5
        )

    # 右：结团换成等待。曲线是上凸的 —— 结团的边际代价递增，
    # 所以哪怕只把结团压掉一半，也能拿回大部分等待。
    loop = d["loopSeconds"]
    k = d["base"]["kettles"]
    floor = loop / (2 * k)  # 完美均匀时的平均等待 = 1/(2K) 圈

    ax2.plot(idx, wait, "o-", color=C_ACCENT, lw=1.4, ms=7)
    ax2.axhline(floor, color=C_CTRL, ls="--", lw=1.2)
    ax2.annotate(
        L(f"完美均匀的下限 {floor:.0f}s", f"perfectly even: {floor:.0f}s"),
        xy=(0.55, floor),
        xycoords=("axes fraction", "data"),
        xytext=(0, 6),
        textcoords="offset points",
        color="#64748b",
        fontsize=9.5,
    )
    for i, (v_idx, v_wait, lab) in enumerate(zip(idx, wait, labels)):
        ax2.annotate(
            lab if not lab[0].isdigit() else L(f"{lab} 分钟", f"{lab} min"),
            (v_idx, v_wait),
            textcoords="offset points",
            xytext=(9, 10 if i % 2 else -16),
            fontsize=9.5,
            color="#475569",
        )
    ax2.set_xlim(0, 1.12)
    ax2.set_ylim(0, max(wait) * 1.15)
    ax2.set_xlabel(L("结团指数", "bunching index"))
    ax2.set_ylabel(L("平均等待（秒）", "mean wait (s)"))
    ax2.set_title(
        L("而结团的边际代价是递增的", "the marginal cost of bunching accelerates"),
        loc="left",
    )

    fig.suptitle(
        L(
            "反串车不必聪明，但要勤：半小时摊一次，平均等待就从 238 秒掉到 75 秒",
            "anti-bunching need not be clever, only regular",
        ),
        fontsize=10.5,
        y=1.02,
    )
    fig.tight_layout()
    save(fig, "fig6-reset")


# ---------------------------------------------------------------- 入口

FIGURES = {
    "spacetime": fig_spacetime,
    "bunching": fig_bunching,
    "time-to-bunch": fig_time_to_bunch,
    "kettle-count": fig_kettle_count,
    "ginger": fig_ginger,
    "reset": fig_reset,
}

if __name__ == "__main__":
    want = [a for a in sys.argv[1:] if not a.startswith("-")] or list(FIGURES)
    for name in want:
        if name not in FIGURES:
            sys.exit(f"未知图名：{name}。可用：{', '.join(FIGURES)}")
        print(f"[{name}]")
        FIGURES[name]()
    print("\n完成。图在 figures/")
