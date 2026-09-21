import { useEffect, useMemo, useState } from "react";
import "./styles.css";

/* ============================ 领域类型 ============================ */

type NodeStatus = "pending" | "fired" | "held";

interface FireNode {
  id: string;
  segment: string; // 节目段落
  model: string; // 烟花型号
  caliber: string; // 口径
  angle: number; // 发射角度
  time: number; // 计划点火时间，相对整场毫秒
  duration: number; // 持续时间 ms
  safetyDistance: number; // 安全距离 m
  musicCue: string; // 音乐时间点
  pointId: string; // 点位
  status: NodeStatus;
  firedAt?: number; // 实际点火时间（已点火只读记录）
  originalTime?: number; // 挂起前的计划点火时间
}

type AuditType = "init" | "add" | "fire" | "ceasefire" | "recover" | "resume" | "reset";

interface AuditEntry {
  id: string;
  type: AuditType;
  atWall: number;
  atShow: number;
  detail: string;
  reviewer?: string;
}

interface CeasefireInfo {
  at: number; // 停火时刻（节目相对 ms），恢复时校验基准
  wallAt: number;
  active: boolean; // 是否仍处于停火走时冻结状态
}

interface ConsoleState {
  version: 2;
  nodes: FireNode[];
  ceasefire: CeasefireInfo | null;
  hasRecovered: boolean; // 本场停火后是否至少有一批成功恢复
  audit: AuditEntry[];
  now: number;
  running: boolean;
  lastWall: number;
}

type RecoverOutcome =
  | { ok: true; detail: string }
  | { ok: false; errors: string[] };

/* ============================ 常量 / 种子 ============================ */

const STORAGE_KEY = "hxyfront-62008-ceasefire-console:v2";
const MIN_GAP_MS = 1200;

const POINTS = [
  { id: "A", name: "A 点 · 舞台左前", x: 21, y: 66 },
  { id: "B", name: "B 点 · 舞台右前", x: 79, y: 66 },
  { id: "C", name: "C 点 · 中后场", x: 50, y: 22 },
];

const MODEL_FILTERS = ["礼花弹", "罗马烛光", "扇形架", "冷焰火"];

function seedNodes(): FireNode[] {
  const rows: Array<[string, string, string, number, string, number, number, string, string]> = [
    // 段落, 型号, 口径, 角度, 点火时间, 持续, 安全距离, 点位, 音乐点
    ["Intro", "30mm扇形架", "30mm", 60, "00:12.500", 4000, 35, "A", "鼓点 1"],
    ["Intro", "75mm礼花弹", "75mm", 90, "00:13.300", 3000, 60, "B", "鼓点 2"],
    ["Chorus A", "罗马烛光", "25mm", 75, "00:18.000", 6000, 30, "C", "副歌进"],
    ["Chorus A", "75mm礼花弹", "75mm", 90, "00:20.000", 3200, 60, "A", "重拍"],
    ["Chorus A", "冷焰火", "20mm", 45, "00:20.900", 5000, 12, "B", "重拍"],
    ["Verse", "30mm扇形架", "30mm", 60, "00:32.000", 4000, 35, "C", "间奏"],
    ["Finale", "100mm礼花弹", "100mm", 90, "00:44.000", 4500, 80, "A", "终场齐射"],
    ["Finale", "30mm扇形架", "30mm", 60, "00:44.900", 4000, 35, "A", "终场齐射"],
    ["Finale", "罗马烛光", "25mm", 75, "00:46.000", 5000, 30, "C", "尾奏"],
    ["Finale", "冷焰火", "20mm", 45, "00:45.200", 6000, 12, "B", "尾奏"],
  ];
  return rows.map((r, i) => ({
    id: `N${String(i + 1).padStart(2, "0")}`,
    segment: r[0],
    model: r[1],
    caliber: r[2],
    angle: r[3],
    time: parseTimecodeStrict(r[4]),
    duration: r[5],
    safetyDistance: r[6],
    pointId: r[7],
    musicCue: r[8],
    status: "pending" as NodeStatus,
  }));
}

function seedState(): ConsoleState {
  return {
    version: 2,
    nodes: seedNodes(),
    ceasefire: null,
    hasRecovered: false,
    audit: [
      {
        id: auditId(),
        type: "init",
        atWall: Date.now(),
        atShow: 0,
        detail: "载入初始燃放编排（10 个点火节点，全场待点火）",
      },
    ],
    now: 0,
    running: false,
    lastWall: Date.now(),
  };
}

/* ============================ 工具函数 ============================ */

let auditSeq = 0;
function auditId(): string {
  auditSeq += 1;
  return `A${Date.now().toString(36)}${auditSeq}`;
}

function parseTimecodeStrict(raw: string): number {
  const v = parseTimecode(raw);
  if (v === null) throw new Error(`bad timecode ${raw}`);
  return v;
}

/** 支持 "MM:SS.mmm"、"H:MM:SS.mmm"、纯秒数 "12.5"；返回毫秒 */
function parseTimecode(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i];
    if (piece === "" || /\s/.test(piece)) return null;
    const isLast = i === parts.length - 1;
    const value = Number(piece);
    if (!Number.isFinite(value) || value < 0) return null;
    if (!isLast) {
      if (!Number.isInteger(value)) return null;
      total += value * Math.pow(60, parts.length - 1 - i);
    } else {
      if (parts.length > 1 && value >= 60) return null;
      total += value;
    }
  }
  return Math.round(total * 1000);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTimecode(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const m = Math.floor(v / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const milli = v % 1000;
  return `${pad2(m)}:${pad2(s)}.${String(milli).padStart(3, "0")}`;
}

function formatWall(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function loadState(): ConsoleState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as ConsoleState;
      if (data && data.version === 2 && Array.isArray(data.nodes)) {
        // 刷新前若时钟在走，按离线墙钟时长补走，并把到时的待点火节点结算为已点火
        if (data.running && data.ceasefire?.active !== true) {
          const gap = Math.max(0, Date.now() - (data.lastWall ?? Date.now()));
          const nowTo = data.now + gap;
          data.now = nowTo;
          data.lastWall = Date.now();
          data.nodes = data.nodes.map((n) =>
            n.status === "pending" && n.time <= nowTo
              ? { ...n, status: "fired", firedAt: n.time }
              : n,
          );
        }
        return data;
      }
    }
  } catch {
    /* 损坏的本地数据回退到种子 */
  }
  return seedState();
}

/** 时钟推进后，把所有到时的待点火节点结算为已点火 */
function settleDueNodes(prev: ConsoleState, nowTo: number): ConsoleState {
  let changed = false;
  const fired: FireNode[] = [];
  const nodes = prev.nodes.map((n) => {
    if (n.status === "pending" && n.time <= nowTo) {
      changed = true;
      const done: FireNode = { ...n, status: "fired", firedAt: n.time };
      fired.push(done);
      return done;
    }
    return n;
  });
  if (!changed) return { ...prev, now: nowTo, lastWall: Date.now() };
  const audit = [...prev.audit];
  for (const n of fired) {
    audit.push({
      id: auditId(),
      type: "fire",
      atWall: Date.now(),
      atShow: n.firedAt ?? n.time,
      detail: `${n.id}（${n.model} · ${n.pointId}点）按计划 ${formatTimecode(n.time)} 自动点火`,
    });
  }
  return { ...prev, now: nowTo, lastWall: Date.now(), nodes, audit };
}

/* ============================ 主组件 ============================ */

function App() {
  const [state, setState] = useState<ConsoleState>(loadState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState<string | null>(null);

  /* 本地存储同步：任何状态变化即落盘，刷新后完整保留 */
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* 存储不可用时静默降级为内存态 */
    }
  }, [state]);

  /* 走时驱动：停火期间强制冻结 */
  useEffect(() => {
    if (!state.running || state.ceasefire?.active) return;
    const timer = setInterval(() => {
      setState((prev) => {
        if (!prev.running || prev.ceasefire?.active) return prev;
        const gap = Math.max(0, Date.now() - prev.lastWall);
        return settleDueNodes(prev, prev.now + gap);
      });
    }, 100);
    return () => clearInterval(timer);
  }, [state.running, state.ceasefire?.active]);

  const nodes = state.nodes;
  const counts = useMemo(
    () => ({
      fired: nodes.filter((n) => n.status === "fired").length,
      pending: nodes.filter((n) => n.status === "pending").length,
      held: nodes.filter((n) => n.status === "held").length,
    }),
    [nodes],
  );

  const softConflicts = useMemo(() => computeSoftConflicts(nodes), [nodes]);

  /* ---------------- 走时控制 ---------------- */

  function toggleRunning() {
    setState((prev) => {
      if (prev.ceasefire?.active) return prev; // 停火期间禁止走时
      if (!prev.running && prev.nodes.every((n) => n.status !== "pending")) return prev;
      return { ...prev, running: !prev.running, lastWall: Date.now() };
    });
  }

  function seekTo(ms: number) {
    setState((prev) => {
      if (prev.ceasefire?.active) return prev;
      const target = Math.max(0, Math.round(ms));
      const next = settleDueNodes({ ...prev, running: false, lastWall: Date.now() }, target);
      return next;
    });
  }

  function igniteNow(id: string) {
    setState((prev) => {
      if (prev.ceasefire?.active) return prev;
      const node = prev.nodes.find((n) => n.id === id);
      if (!node || node.status !== "pending") return prev;
      const nodes2 = prev.nodes.map((n) =>
        n.id === id ? { ...n, status: "fired" as const, firedAt: prev.now } : n,
      );
      return {
        ...prev,
        nodes: nodes2,
        audit: [
          ...prev.audit,
          {
            id: auditId(),
            type: "fire" as const,
            atWall: Date.now(),
            atShow: prev.now,
            detail: `${node.id}（${node.model} · ${node.pointId}点）手动立即点火，实际时刻 ${formatTimecode(prev.now)}`,
          },
        ],
      };
    });
  }

  /* ---------------- 停火 / 恢复 ---------------- */

  function triggerCeasefire() {
    setState((prev) => {
      if (prev.ceasefire?.active) return prev;
      if (!prev.nodes.some((n) => n.status === "pending")) return prev;
      const nodes2 = prev.nodes.map((n) =>
        n.status === "pending"
          ? { ...n, status: "held" as const, originalTime: n.originalTime ?? n.time }
          : n,
      );
      const heldCount = nodes2.filter((n) => n.status === "held").length;
      return {
        ...prev,
        running: false, // 触发停火立即冻结节目时钟
        nodes: nodes2,
        ceasefire: { at: prev.now, wallAt: Date.now(), active: true },
        hasRecovered: false,
        audit: [
          ...prev.audit,
          {
            id: auditId(),
            type: "ceasefire",
            atWall: Date.now(),
            atShow: prev.now,
            detail: `触发全场停火：${heldCount} 个未完成节点全部挂起，已点火记录保持只读`,
          },
        ],
      };
    });
  }

  function endCeasefire() {
    setState((prev) => {
      if (!prev.ceasefire?.active || !prev.hasRecovered) return prev;
      const heldLeft = prev.nodes.filter((n) => n.status === "held").length;
      return {
        ...prev,
        ceasefire: { ...prev.ceasefire, active: false },
        audit: [
          ...prev.audit,
          {
            id: auditId(),
            type: "resume",
            atWall: Date.now(),
            atShow: prev.now,
            detail:
              heldLeft > 0
                ? `安全复核后结束停火、恢复走时；仍有 ${heldLeft} 个节点保持停火挂起`
                : "安全复核后结束停火、恢复走时",
          },
        ],
      };
    });
  }

  function recoverBatch(
    selected: string[],
    times: Record<string, string>,
    reviewer: string,
  ): RecoverOutcome {
    const cf = state.ceasefire;
    if (!cf) return { ok: false, errors: ["不存在停火记录，无需恢复。"] };
    const errors = validateRecovery(state.nodes, selected, times, reviewer, cf.at);
    if (errors.length) return { ok: false, errors };

    const parsed = new Map<string, number>();
    for (const id of selected) parsed.set(id, parseTimecodeStrict(times[id] ?? ""));
    const sel = new Set(selected);
    const nodes2 = state.nodes.map((n) =>
      sel.has(n.id) && n.status === "held"
        ? { ...n, status: "pending" as const, time: parsed.get(n.id) ?? n.time }
        : n,
    );
    const remainingHeld = nodes2.filter((n) => n.status === "held").length;
    const autoEnd = remainingHeld === 0;
    const list = selected
      .map((id) => `${id}→${formatTimecode(parsed.get(id) ?? 0)}`)
      .join("，");
    const audit: AuditEntry[] = [
      ...state.audit,
      {
        id: auditId(),
        type: "recover",
        atWall: Date.now(),
        atShow: state.now,
        reviewer: reviewer.trim(),
        detail: `安全复核人 ${reviewer.trim()} 批复恢复 ${selected.length} 个挂起节点：${list}`,
      },
    ];
    if (autoEnd) {
      audit.push({
        id: auditId(),
        type: "resume",
        atWall: Date.now(),
        atShow: state.now,
        reviewer: reviewer.trim(),
        detail: "挂起节点已全部恢复，自动结束停火、恢复走时",
      });
    }
    setState({
      ...state,
      nodes: nodes2,
      hasRecovered: true,
      ceasefire: autoEnd ? { ...cf, active: false } : cf,
      audit,
    });
    return {
      ok: true,
      detail: `已恢复 ${selected.length} 个节点${autoEnd ? "，全场无挂起节点，停火自动结束" : ""}。`,
    };
  }

  function addNode(input: NodeFormInput): string | null {
    const t = parseTimecode(input.time);
    if (t === null) return "点火时间格式应为 MM:SS.mmm";
    const angle = Number(input.angle);
    const duration = Number(input.duration) * 1000;
    const distance = Number(input.safetyDistance);
    if (!input.segment.trim() || !input.model.trim()) return "节目段落与烟花型号必填";
    if (!Number.isFinite(angle) || angle < 0 || angle > 360) return "发射角度需在 0–360° 之间";
    if (!Number.isFinite(duration) || duration <= 0) return "持续时间需为正数（秒）";
    if (!Number.isFinite(distance) || distance <= 0) return "安全距离需为正数（米）";
    if (state.ceasefire?.active) return "停火期间不允许新增点火节点";

    const maxNo = state.nodes.reduce((m, n) => {
      const mm = /^N(\d+)$/.exec(n.id);
      return mm ? Math.max(m, Number(mm[1])) : m;
    }, 0);
    const isDue = t <= state.now;
    const node: FireNode = {
      id: `N${String(maxNo + 1).padStart(2, "0")}`,
      segment: input.segment.trim(),
      model: input.model.trim(),
      caliber: input.caliber.trim() || "未标注",
      angle,
      time: t,
      duration,
      safetyDistance: distance,
      musicCue: input.musicCue.trim() || "—",
      pointId: input.pointId,
      status: isDue ? "fired" : "pending",
      ...(isDue ? { firedAt: state.now } : {}),
    };
    setState({
      ...state,
      nodes: [...state.nodes, node],
      audit: [
        ...state.audit,
        {
          id: auditId(),
          type: "add",
          atWall: Date.now(),
          atShow: state.now,
          detail: `新增点火节点 ${node.id}（${node.model} · ${node.pointId}点，${formatTimecode(t)}）`,
        },
      ],
    });
    return null;
  }

  function resetConsole() {
    if (!window.confirm("确认重置演练台？所有点火与停火记录将恢复为初始编排。")) return;
    const fresh = seedState();
    setState(fresh);
    setSelectedId(null);
  }

  const visibleNodes = modelFilter
    ? nodes.filter((n) => n.model.includes(modelFilter))
    : nodes;

  const timelineEnd = useMemo(() => {
    const maxScheduled = nodes.reduce(
      (m, n) => Math.max(m, n.time, n.firedAt ?? 0, n.originalTime ?? 0) + n.duration,
      60000,
    );
    return Math.max(maxScheduled, state.now + 4000);
  }, [nodes, state.now]);

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62008 · 烟花燃放脚本编排 · Port 62008</p>
        <h1>全场停火恢复台</h1>
        <span>
          每个点火节点处于「已点火 / 待点火 / 停火挂起」三态之一。触发停火后未完成节点一律挂起、已点火记录只读、挂起节点不得直接点火；
          恢复须登记安全复核人与不早于停火时刻的新点火时间，与同点位已点火记录间隔不足 1.2 秒时整组拒绝。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>已点火（只读）</small>
          <strong className="stat-fired">{counts.fired}</strong>
        </article>
        <article>
          <small>待点火</small>
          <strong className="stat-pending">{counts.pending}</strong>
        </article>
        <article>
          <small>停火挂起</small>
          <strong className="stat-held">{counts.held}</strong>
        </article>
        <article>
          <small>同点 &lt;1.2s 冲突提示</small>
          <strong className="stat-conflict">{softConflicts.length}</strong>
        </article>
      </section>

      {state.ceasefire?.active && (
        <section className="ceasefire-banner" role="alert">
          <div>
            <b>● 全场停火中</b>
            <span>
              停火时刻 {formatTimecode(state.ceasefire.at)}（{formatWall(state.ceasefire.wallAt)}）·
              节目时钟已冻结 · 挂起 {counts.held} 个节点 · 挂起节点不可直接点火
            </span>
          </div>
          <button
            className="danger-ghost"
            onClick={endCeasefire}
            disabled={!state.hasRecovered}
            title={state.hasRecovered ? "" : "须至少完成一批安全复核恢复后才能结束停火"}
          >
            结束停火，恢复走时
          </button>
        </section>
      )}

      <TransportBar
        now={state.now}
        running={state.running}
        ceasefireActive={!!state.ceasefire?.active}
        pendingCount={counts.pending}
        hasRecovered={state.hasRecovered}
        onToggle={toggleRunning}
        onSeek={seekTo}
        onCeasefire={triggerCeasefire}
        onEnd={endCeasefire}
        onReset={resetConsole}
      />

      <Timeline
        nodes={visibleNodes}
        end={timelineEnd}
        now={state.now}
        ceasefire={state.ceasefire}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      <section className="workspace">
        <PointMap nodes={nodes} selectedId={selectedId} onSelect={setSelectedId} />
        <ConflictPanel conflicts={softConflicts} nodes={nodes} />
      </section>

      <ModelList
        nodes={visibleNodes}
        allNodes={nodes}
        filter={modelFilter}
        onFilter={setModelFilter}
        selectedId={selectedId}
        onSelect={setSelectedId}
        ceasefireActive={!!state.ceasefire?.active}
        onIgnite={igniteNow}
      />

      {(state.ceasefire || counts.held > 0) && (
        <RecoveryConsole
          nodes={nodes}
          ceasefire={state.ceasefire}
          audit={state.audit}
          onRecover={recoverBatch}
        />
      )}

      <NodeForm onAdd={addNode} ceasefireActive={!!state.ceasefire?.active} now={state.now} />
    </main>
  );
}

/* ============================ 走时控制条 ============================ */

function TransportBar(props: {
  now: number;
  running: boolean;
  ceasefireActive: boolean;
  pendingCount: number;
  hasRecovered: boolean;
  onToggle: () => void;
  onSeek: (ms: number) => void;
  onCeasefire: () => void;
  onEnd: () => void;
  onReset: () => void;
}) {
  const [seekText, setSeekText] = useState("");
  const canPlay = !props.ceasefireActive && props.pendingCount > 0;

  return (
    <section className={"panel transport" + (props.ceasefireActive ? " transport-held" : "")}>
      <div className="clock">
        <small>节目时钟</small>
        <strong>{formatTimecode(props.now)}</strong>
        <span>{props.running ? "走时中" : props.ceasefireActive ? "停火冻结" : "已暂停"}</span>
      </div>
      <div className="transport-actions">
        <button className="primary" onClick={props.onToggle} disabled={!canPlay && !props.running}>
          {props.running ? "暂停走时" : "开始走时"}
        </button>
        <button onClick={() => props.onSeek(props.now + 5000)} disabled={props.ceasefireActive}>
          +5 秒
        </button>
        <button onClick={() => props.onSeek(props.now + 15000)} disabled={props.ceasefireActive}>
          +15 秒
        </button>
        <span className="seek-box">
          跳转
          <input
            value={seekText}
            placeholder="MM:SS.mmm"
            onChange={(e) => setSeekText(e.target.value)}
            disabled={props.ceasefireActive}
          />
          <button
            disabled={props.ceasefireActive}
            onClick={() => {
              const t = parseTimecode(seekText);
              if (t !== null) {
                props.onSeek(t);
                setSeekText("");
              }
            }}
          >
            确定
          </button>
        </span>
      </div>
      <div className="transport-actions">
        <button
          className="danger"
          onClick={props.onCeasefire}
          disabled={props.ceasefireActive || props.pendingCount === 0}
          title={props.pendingCount === 0 ? "没有待点火节点" : "未完成节点将全部挂起"}
        >
          ✋ 触发全场停火
        </button>
        {props.ceasefireActive && (
          <button className="primary" onClick={props.onEnd} disabled={!props.hasRecovered}>
            结束停火
          </button>
        )}
        <button className="ghost" onClick={props.onReset}>
          重置演练
        </button>
      </div>
    </section>
  );
}

/* ============================ 时间轴 ============================ */

function Timeline(props: {
  nodes: FireNode[];
  end: number;
  now: number;
  ceasefire: CeasefireInfo | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { nodes, end, now, ceasefire } = props;
  const ticks: number[] = [];
  for (let t = 0; t <= end; t += 5000) ticks.push(t);

  return (
    <section className="panel timeline-panel">
      <div className="heading">
        <div>
          <p>时间轴编排</p>
          <h2>节目时间轴</h2>
        </div>
        <div className="legend">
          <span className="lg lg-fired">已点火 · 只读</span>
          <span className="lg lg-pending">待点火</span>
          <span className="lg lg-held">停火挂起</span>
          {ceasefire && <span className="lg lg-cf">停火时刻 {formatTimecode(ceasefire.at)}</span>}
        </div>
      </div>

      <div className="timeline-scroll">
        <div className="timeline" style={{ minWidth: 720 }}>
          <div className="ruler">
            {ticks.map((t) => (
              <span key={t} style={{ left: `${(t / end) * 100}%` }}>
                {formatTimecode(t)}
              </span>
            ))}
          </div>

          {POINTS.map((p) => {
            const laneNodes = nodes
              .filter((n) => n.pointId === p.id)
              .sort((a, b) => a.time - b.time);
            return (
              <div className="lane" key={p.id}>
                <div className="lane-label">{p.id} 点</div>
                <div className="lane-track">
                  {ticks.map((t) => (
                    <i key={t} className="gridline" style={{ left: `${(t / end) * 100}%` }} />
                  ))}
                  {laneNodes.map((n) => {
                    const start = n.status === "fired" ? n.firedAt ?? n.time : n.time;
                    const widthPct = Math.max((n.duration / end) * 100, 1.1);
                    return (
                      <button
                        key={n.id}
                        className={`block block-${n.status} ${props.selectedId === n.id ? "block-selected" : ""}`}
                        style={{
                          left: `${(start / end) * 100}%`,
                          width: `${widthPct}%`,
                        }}
                        title={`${n.id} ${n.model}｜${n.status === "held" ? `计划 ${formatTimecode(n.originalTime ?? n.time)}（已挂起）` : `点火 ${formatTimecode(start)}`}｜持续 ${n.duration / 1000}s`}
                        onClick={() => props.onSelect(n.id)}
                      >
                        <span>{n.id}</span>
                      </button>
                    );
                  })}
                  {ceasefire && (
                    <i
                      className="ceasefire-line"
                      style={{ left: `${(ceasefire.at / end) * 100}%` }}
                      title={`停火时刻 ${formatTimecode(ceasefire.at)}`}
                    />
                  )}
                </div>
              </div>
            );
          })}

          <div className="playhead" style={{ left: `${(now / end) * 100}%` }}>
            <i />
            <b>{formatTimecode(now)}</b>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================ 点位平面图 ============================ */

function PointMap(props: {
  nodes: FireNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="panel map-panel">
      <div className="heading">
        <div>
          <p>燃放点位平面图</p>
          <h2>点位状态</h2>
        </div>
      </div>
      <div className="map-canvas">
        <div className="stage">舞台 / 观众近景区</div>
        {POINTS.map((p) => {
          const list = props.nodes
            .filter((n) => n.pointId === p.id)
            .sort((a, b) => (a.originalTime ?? a.time) - (b.originalTime ?? b.time));
          const hasHeld = list.some((n) => n.status === "held");
          const hasPending = list.some((n) => n.status === "pending");
          const tone = hasHeld ? "held" : hasPending ? "pending" : "fired";
          return (
            <div className="point-card" key={p.id} style={{ left: `${p.x}%`, top: `${p.y}%` }}>
              <div className={`point-marker point-marker-${tone}`}>{p.id}</div>
              <div className="point-name">{p.name}</div>
              <div className="point-nodes">
                {list.map((n) => (
                  <button
                    key={n.id}
                    className={`chip chip-${n.status} ${props.selectedId === n.id ? "chip-selected" : ""}`}
                    onClick={() => props.onSelect(n.id)}
                    title={`${n.segment}｜${n.model}｜${n.status === "held" ? "停火挂起，禁止直接点火" : formatTimecode(n.status === "fired" ? n.firedAt ?? n.time : n.time)}`}
                  >
                    <i />
                    {n.id} {formatTimecode(n.status === "fired" ? n.firedAt ?? n.time : n.originalTime ?? n.time)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ============================ 冲突提示 ============================ */

interface Conflict {
  a: FireNode;
  b: FireNode;
  delta: number;
  kind: "fired" | "scheduled";
}

function effectiveTime(n: FireNode): number {
  if (n.status === "fired") return n.firedAt ?? n.time;
  return n.time;
}

function computeSoftConflicts(nodes: FireNode[]): Conflict[] {
  const active = nodes.filter((n) => n.status !== "held");
  const out: Conflict[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.pointId !== b.pointId) continue;
      const delta = Math.abs(effectiveTime(a) - effectiveTime(b));
      if (delta < MIN_GAP_MS) {
        const kind =
          a.status === "fired" || b.status === "fired" ? "fired" : "scheduled";
        out.push({ a, b, delta, kind });
      }
    }
  }
  return out;
}

function ConflictPanel(props: { conflicts: Conflict[]; nodes: FireNode[] }) {
  const held = props.nodes.filter((n) => n.status === "held");
  return (
    <section className="panel conflict-panel">
      <div className="heading">
        <div>
          <p>冲突时间提示</p>
          <h2>同点 1.2 秒间隔</h2>
        </div>
      </div>
      {props.conflicts.length === 0 && held.length === 0 && (
        <p className="muted">同点位相邻点火间隔均不小于 1.2 秒，暂无冲突。</p>
      )}
      <ul className="conflict-list">
        {props.conflicts.map((c) => (
          <li key={`${c.a.id}-${c.b.id}`} className={c.kind === "fired" ? "cf-fired" : "cf-sched"}>
            <b>{c.pointLabel(c.a.pointId)}</b>
            {c.a.id}（{formatTimecode(effectiveTime(c.a))}）与 {c.b.id}（
            {formatTimecode(effectiveTime(c.b))}）仅间隔 {(c.delta / 1000).toFixed(1)} 秒
            <span>{c.kind === "fired" ? "· 涉已点火记录" : "· 计划阶段提示"}</span>
          </li>
        ))}
        {held.map((n) => (
          <li key={n.id} className="cf-held">
            <b>{n.pointId} 点</b>
            {n.id} 停火挂起：原计划 {formatTimecode(n.originalTime ?? n.time)}，恢复后才重新进入待点火
          </li>
        ))}
      </ul>
    </section>
  );
}

function pointLabel(id: string): string {
  return `${id} 点`;
}

/* ============================ 型号清单 / 节点表 ============================ */

function ModelList(props: {
  nodes: FireNode[];
  allNodes: FireNode[];
  filter: string | null;
  onFilter: (f: string | null) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  ceasefireActive: boolean;
  onIgnite: (id: string) => void;
}) {
  const summary = useMemo(() => {
    const map = new Map<string, { count: number; calibers: Set<string>; points: Set<string>; status: Record<NodeStatus, number> }>();
    for (const n of props.allNodes) {
      const s = map.get(n.model) ?? {
        count: 0,
        calibers: new Set(),
        points: new Set(),
        status: { fired: 0, pending: 0, held: 0 },
      };
      s.count += 1;
      s.calibers.add(n.caliber);
      s.points.add(n.pointId);
      s.status[n.status] += 1;
      map.set(n.model, s);
    }
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [props.allNodes]);

  const sorted = [...props.nodes].sort(
    (a, b) => (a.originalTime ?? a.time) - (b.originalTime ?? b.time),
  );

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>型号清单</p>
          <h2>烟花型号与点火节点</h2>
        </div>
        <div className="chips">
          <button
            className={props.filter === null ? "chip-on" : ""}
            onClick={() => props.onFilter(null)}
          >
            全部
          </button>
          {MODEL_FILTERS.map((f) => (
            <button
              key={f}
              className={props.filter === f ? "chip-on" : ""}
              onClick={() => props.onFilter(props.filter === f ? null : f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="model-summary">
        {summary.map(([model, s]) => (
          <article key={model} className="model-card">
            <h3>{model}</h3>
            <p className="muted">
              {[...s.calibers].join(" / ") || "未标注口径"} · {[...s.points].sort().join("/")} 点
            </p>
            <div className="model-counts">
              <span className="lg lg-fired">已点火 {s.status.fired}</span>
              <span className="lg lg-pending">待点火 {s.status.pending}</span>
              <span className="lg lg-held">挂起 {s.status.held}</span>
            </div>
          </article>
        ))}
      </div>

      <div className="table-scroll">
        <table className="node-table">
          <thead>
            <tr>
              <th>编号</th>
              <th>状态</th>
              <th>节目段落</th>
              <th>型号 / 口径</th>
              <th>角度</th>
              <th>点位</th>
              <th>点火时间</th>
              <th>持续</th>
              <th>安全距离</th>
              <th>音乐点</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((n) => {
              const selected = props.selectedId === n.id;
              return (
                <tr
                  key={n.id}
                  className={`row-${n.status} ${selected ? "row-selected" : ""}`}
                  onClick={() => props.onSelect(n.id)}
                >
                  <td><b>{n.id}</b></td>
                  <td><StatusBadge status={n.status} /></td>
                  <td>{n.segment}</td>
                  <td>{n.model}<br /><small className="muted">{n.caliber}</small></td>
                  <td>{n.angle}°</td>
                  <td>{n.pointId} 点</td>
                  <td>
                    {formatTimecode(n.status === "fired" ? n.firedAt ?? n.time : n.originalTime ?? n.time)}
                    {n.status === "held" && (
                      <small className="muted"> 原 {formatTimecode(n.originalTime ?? n.time)}</small>
                    )}
                    {n.status === "fired" && Math.abs((n.firedAt ?? n.time) - n.time) > 50 && (
                      <small className="muted"> 计划 {formatTimecode(n.time)}</small>
                    )}
                  </td>
                  <td>{(n.duration / 1000).toFixed(1)}s</td>
                  <td>{n.safetyDistance}m</td>
                  <td>{n.musicCue}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {n.status === "fired" ? (
                      <span className="readonly-tag">🔒 只读</span>
                    ) : n.status === "held" ? (
                      <a className="link-held" href="#recovery-console">
                        停火挂起·去恢复
                      </a>
                    ) : (
                      <button
                        className="mini"
                        disabled={props.ceasefireActive}
                        title={props.ceasefireActive ? "停火期间挂起/待点火节点均不得点火" : "按当前节目时钟立即点火"}
                        onClick={() => props.onIgnite(n.id)}
                      >
                        立即点火
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: NodeStatus }) {
  const map: Record<NodeStatus, string> = {
    fired: "已点火",
    pending: "待点火",
    held: "停火挂起",
  };
  return <span className={`badge badge-${status}`}>{map[status]}</span>;
}

/* ============================ 停火恢复台 ============================ */

function RecoveryConsole(props: {
  nodes: FireNode[];
  ceasefire: CeasefireInfo | null;
  audit: AuditEntry[];
  onRecover: (selected: string[], times: Record<string, string>, reviewer: string) => RecoverOutcome;
}) {
  const held = props.nodes
    .filter((n) => n.status === "held")
    .sort((a, b) => (a.originalTime ?? 0) - (b.originalTime ?? 0));
  const cfAt = props.ceasefire?.at ?? held[0]?.originalTime ?? 0;

  const [reviewer, setReviewer] = useState("");
  const [times, setTimes] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [okMsg, setOkMsg] = useState("");

  // 新挂起的节点给默认新点火时间：不早于停火时刻，且尽量沿用原计划
  const heldKey = held.map((n) => n.id).join(",");
  useEffect(() => {
    setTimes((prev) => {
      const next = { ...prev };
      for (const n of held) {
        if (next[n.id] === undefined) {
          next[n.id] = formatTimecode(Math.max(cfAt, n.originalTime ?? n.time));
        }
      }
      return next;
    });
    setPicked((prev) => {
      const next = { ...prev };
      for (const n of held) if (next[n.id] === undefined) next[n.id] = true;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey, cfAt]);

  const selectedIds = held.filter((n) => picked[n.id]).map((n) => n.id);
  const liveErrors = useMemo(
    () =>
      props.ceasefire
        ? validateRecovery(props.nodes, selectedIds, times, reviewer, props.ceasefire.at)
        : [],
    [props.nodes, selectedIds, times, reviewer, props.ceasefire],
  );

  function submit() {
    const outcome = props.onRecover(selectedIds, times, reviewer);
    if (outcome.ok) {
      setErrors([]);
      setOkMsg(outcome.detail);
      setReviewer("");
    } else {
      setOkMsg("");
      setErrors(outcome.errors);
    }
  }

  const recentAudit = [...props.audit]
    .filter((a) => a.type !== "init" && a.type !== "add")
    .reverse()
    .slice(0, 8);

  return (
    <section className="panel recovery" id="recovery-console">
      <div className="heading">
        <div>
          <p>全场停火恢复台</p>
          <h2>挂起节点恢复批复</h2>
        </div>
        {props.ceasefire && (
          <span className="cf-time">
            停火时刻 <b>{formatTimecode(props.ceasefire.at)}</b>（{formatWall(props.ceasefire.wallAt)}）
            {props.ceasefire.active ? "" : " · 停火已结束，遗留挂起节点仍可批复"}
          </span>
        )}
      </div>

      <div className="recovery-rule muted">
        恢复规则：整组一起批复；必须填写安全复核人；每个新点火时间不得早于停火时刻；与同点位已点火记录（只读）间隔不足
        1.2 秒、或本批复组内同点位相互不足 1.2 秒时，<b>整组拒绝且原挂起状态保持不变</b>。
      </div>

      {held.length === 0 ? (
        <p className="muted">当前没有停火挂起节点。</p>
      ) : (
        <>
          <label className="reviewer">
            <span>安全复核人 *</span>
            <input
              placeholder="填写负责本次恢复批复的安全复核人姓名"
              value={reviewer}
              onChange={(e) => {
                setReviewer(e.target.value);
                setErrors([]);
                setOkMsg("");
              }}
            />
          </label>

          <div className="table-scroll">
            <table className="node-table recovery-table">
              <thead>
                <tr>
                  <th>纳入恢复</th>
                  <th>编号</th>
                  <th>型号 · 点位</th>
                  <th>原计划</th>
                  <th>新点火时间（MM:SS.mmm，≥ 停火时刻）</th>
                  <th>同点已点火最近间隔</th>
                </tr>
              </thead>
              <tbody>
                {held.map((n) => {
                  const nearest = nearestFiredGap(props.nodes, n, parseTimecode(times[n.id] ?? ""));
                  return (
                    <tr key={n.id} className="row-held">
                      <td>
                        <input
                          type="checkbox"
                          checked={!!picked[n.id]}
                          onChange={(e) => {
                            setPicked((p) => ({ ...p, [n.id]: e.target.checked }));
                            setErrors([]);
                            setOkMsg("");
                          }}
                        />
                      </td>
                      <td><b>{n.id}</b></td>
                      <td>{n.model}<br /><small className="muted">{n.segment} · {n.pointId} 点</small></td>
                      <td>{formatTimecode(n.originalTime ?? n.time)}</td>
                      <td>
                        <input
                          className="time-input"
                          value={times[n.id] ?? ""}
                          onChange={(e) => {
                            setTimes((t) => ({ ...t, [n.id]: e.target.value }));
                            setErrors([]);
                            setOkMsg("");
                          }}
                          placeholder="MM:SS.mmm"
                          disabled={!picked[n.id]}
                        />
                      </td>
                      <td>
                        {nearest === null ? (
                          <span className="muted">同点无已点火记录</span>
                        ) : (
                          <span className={nearest.gap < MIN_GAP_MS ? "gap-bad" : "gap-ok"}>
                            对 {nearest.id}：{(nearest.gap / 1000).toFixed(1)} 秒
                            {nearest.gap < MIN_GAP_MS ? " · 不足 1.2 秒" : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {liveErrors.length > 0 && (
            <ul className="rev-errors">
              {liveErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {errors.length > 0 && (
            <ul className="rev-errors">
              {errors.map((e, i) => (
                <li key={i}>⛔ {e}</li>
              ))}
              <li>整组拒绝，所有节点保持停火挂起，表单内容不变。</li>
            </ul>
          )}
          {okMsg && <p className="rev-ok">✅ {okMsg}</p>}

          <div className="recovery-actions">
            <button
              className="primary"
              disabled={selectedIds.length === 0 || liveErrors.length > 0}
              onClick={submit}
            >
              整组恢复批复（{selectedIds.length} 个节点）
            </button>
            <button
              type="button"
              onClick={() => {
                const all = selectedIds.length === held.length;
                const next: Record<string, boolean> = {};
                held.forEach((n) => (next[n.id] = !all));
                setPicked(next);
              }}
            >
              {selectedIds.length === held.length ? "全部移出" : "全部纳入"}
            </button>
          </div>
        </>
      )}

      <div className="audit">
        <h3>停火 / 恢复操作留痕</h3>
        {recentAudit.length === 0 && <p className="muted">暂无停火相关操作。</p>}
        <ul>
          {recentAudit.map((a) => (
            <li key={a.id} className={`audit audit-${a.type}`}>
              <span className="audit-tag">{auditLabel(a.type)}</span>
              <time>{formatWall(a.atWall)} · 节目 {formatTimecode(a.atShow)}</time>
              <p>
                {a.detail}
                {a.reviewer ? `（复核人：${a.reviewer}）` : ""}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function auditLabel(t: AuditType): string {
  switch (t) {
    case "fire":
      return "点火";
    case "ceasefire":
      return "停火";
    case "recover":
      return "恢复批复";
    case "resume":
      return "恢复走时";
    case "reset":
      return "重置";
    default:
      return "操作";
  }
}

function validateRecovery(
  nodes: FireNode[],
  selectedIds: string[],
  times: Record<string, string>,
  reviewer: string,
  cfAt: number,
): string[] {
  const errors: string[] = [];
  if (selectedIds.length === 0) return errors; // 未选节点不算错误，按钮禁用即可
  if (!reviewer.trim()) errors.push("必须填写安全复核人。");

  const picked = selectedIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is FireNode => !!n && n.status === "held");

  const parsed = new Map<string, number>();
  for (const n of picked) {
    const t = parseTimecode(times[n.id] ?? "");
    if (t === null) {
      errors.push(`${n.id} 的新点火时间格式无效，需为 MM:SS.mmm。`);
    } else {
      parsed.set(n.id, t);
      if (t < cfAt) {
        errors.push(
          `${n.id} 新点火时间 ${formatTimecode(t)} 早于停火时刻 ${formatTimecode(cfAt)}。`,
        );
      }
    }
  }

  // 硬规则：与同点位已点火（只读）记录间隔不足 1.2 秒 → 整组拒绝
  for (const n of picked) {
    const t = parsed.get(n.id);
    if (t === undefined) continue;
    const hit = nodes.find(
      (o) =>
        o.status === "fired" &&
        o.pointId === n.pointId &&
        Math.abs((o.firedAt ?? o.time) - t) < MIN_GAP_MS,
    );
    if (hit) {
      errors.push(
        `${n.id} 与同点位已点火记录 ${hit.id}（${formatTimecode(hit.firedAt ?? hit.time)}）间隔仅 ${(
          Math.abs((hit.firedAt ?? hit.time) - t) / 1000
        ).toFixed(1)} 秒，不足 1.2 秒。`,
      );
    }
  }

  // 硬规则：本批复组内同点位节点相互不足 1.2 秒 → 整组拒绝
  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      const a = picked[i];
      const b = picked[j];
      const ta = parsed.get(a.id);
      const tb = parsed.get(b.id);
      if (ta === undefined || tb === undefined || a.pointId !== b.pointId) continue;
      if (Math.abs(ta - tb) < MIN_GAP_MS) {
        errors.push(
          `本批 ${a.id}（${formatTimecode(ta)}）与 ${b.id}（${formatTimecode(tb)}）同在 ${a.pointId} 点，间隔仅 ${(
            Math.abs(ta - tb) / 1000
          ).toFixed(1)} 秒，不足 1.2 秒。`,
        );
      }
    }
  }

  return errors;
}

function nearestFiredGap(
  nodes: FireNode[],
  target: FireNode,
  time: number | null,
): { id: string; gap: number } | null {
  if (time === null) return null;
  let best: { id: string; gap: number } | null = null;
  for (const o of nodes) {
    if (o.status !== "fired" || o.pointId !== target.pointId) continue;
    const gap = Math.abs((o.firedAt ?? o.time) - time);
    if (!best || gap < best.gap) best = { id: o.id, gap };
  }
  return best;
}

/* ============================ 新增节点表单 ============================ */

interface NodeFormInput {
  segment: string;
  model: string;
  caliber: string;
  angle: string;
  time: string;
  duration: string;
  safetyDistance: string;
  musicCue: string;
  pointId: string;
}

function NodeForm(props: {
  onAdd: (input: NodeFormInput) => string | null;
  ceasefireActive: boolean;
  now: number;
}) {
  const [form, setForm] = useState<NodeFormInput>({
    segment: "",
    model: "",
    caliber: "",
    angle: "90",
    time: "00:00.000",
    duration: "3",
    safetyDistance: "30",
    musicCue: "",
    pointId: "A",
  });
  const [error, setError] = useState("");

  function update<K extends keyof NodeFormInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <section className="panel form-panel">
      <div className="heading">
        <div>
          <p>专业字段</p>
          <h2>新增点火节点</h2>
        </div>
        <span className="muted">
          当前节目时刻 {formatTimecode(props.now)}
          {props.ceasefireActive && " · 停火期间禁止新增"}
        </span>
      </div>
      <div className="field-grid">
        <label>
          <span>节目段落</span>
          <input value={form.segment} onChange={(e) => update("segment", e.target.value)} placeholder="如 Finale" />
        </label>
        <label>
          <span>烟花型号</span>
          <input
            value={form.model}
            onChange={(e) => update("model", e.target.value)}
            placeholder="如 75mm礼花弹"
            list="model-options"
          />
          <datalist id="model-options">
            {["30mm扇形架", "75mm礼花弹", "100mm礼花弹", "罗马烛光", "冷焰火"].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label>
          <span>口径</span>
          <input value={form.caliber} onChange={(e) => update("caliber", e.target.value)} placeholder="如 75mm" />
        </label>
        <label>
          <span>发射角度（0–360°）</span>
          <input value={form.angle} onChange={(e) => update("angle", e.target.value)} inputMode="numeric" />
        </label>
        <label>
          <span>点火时间（MM:SS.mmm）</span>
          <input value={form.time} onChange={(e) => update("time", e.target.value)} placeholder="00:00.000" />
        </label>
        <label>
          <span>持续时间（秒）</span>
          <input value={form.duration} onChange={(e) => update("duration", e.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>安全距离（米）</span>
          <input value={form.safetyDistance} onChange={(e) => update("safetyDistance", e.target.value)} inputMode="numeric" />
        </label>
        <label>
          <span>音乐时间点</span>
          <input value={form.musicCue} onChange={(e) => update("musicCue", e.target.value)} placeholder="如 副歌进" />
        </label>
        <label>
          <span>燃放点位</span>
          <select value={form.pointId} onChange={(e) => update("pointId", e.target.value)}>
            {POINTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="rev-errors-inline">{error}</p>}
      <div className="recovery-actions">
        <button
          className="primary"
          disabled={props.ceasefireActive}
          onClick={() => {
            const err = props.onAdd(form);
            if (err) {
              setError(err);
            } else {
              setError("");
              setForm((f) => ({ ...f, segment: "", model: "", musicCue: "" }));
            }
          }}
        >
          保存节点
        </button>
      </div>
    </section>
  );
}

export default App;
