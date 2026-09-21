import { useEffect, useMemo, useState } from "react";
import "./styles.css";

const STORAGE_KEY = "hxyfront-62008-show-state";
const MIN_INTERVAL_MS = 1200; // 同点位已点火记录的最小安全间隔 1.2 秒

type NodeStatus = "pending" | "fired" | "suspended";

interface IgnitionNode {
  id: string;
  segment: string; // 节目段落
  model: string; // 烟花型号
  caliber: string; // 口径
  angle: string; // 发射角度
  positionId: string; // 燃放点位
  plannedMs: number; // 点火时间（演出相对毫秒）
  durationMs: number; // 持续时间
  safeDistance: number; // 安全距离（米）
  musicCue: string; // 音乐时间点
  status: NodeStatus;
  firedAtMs: number | null; // 实际点火时刻，已点火记录只读
}

interface ResumeRecord {
  reviewer: string; // 安全复核人
  baseMs: number; // 整组恢复的新基准点火时间
  count: number; // 恢复节点数
  loggedAtMs: number; // 登记时的演出时钟
}

interface ShowState {
  nodes: IgnitionNode[];
  ceasefire: { active: boolean; atMs: number | null };
  resumeLog: ResumeRecord[];
  clockMs: number;
}

const POSITIONS = [
  { id: "A", x: 14, y: 40 },
  { id: "B", x: 32, y: 18 },
  { id: "C", x: 50, y: 36 },
  { id: "D", x: 68, y: 16 },
  { id: "E", x: 86, y: 38 },
];

const MODELS = ["礼花弹", "罗马烛光", "扇形架", "冷焰火"];

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: "待点火",
  fired: "已点火",
  suspended: "停火挂起",
};

function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

function parseTimeInput(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const match = text.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const minutes = match[1] ? parseInt(match[1], 10) : 0;
  const seconds = parseFloat(match[2]);
  if (Number.isNaN(seconds)) return null;
  return Math.round(minutes * 60000 + seconds * 1000);
}

function seedState(): ShowState {
  const nodes: IgnitionNode[] = [
    { id: "n01", segment: "Intro", model: "扇形架", caliber: "30mm", angle: "扇形45°", positionId: "A", plannedMs: 12500, durationMs: 3000, safeDistance: 35, musicCue: "00:12.000", status: "fired", firedAtMs: 12500 },
    { id: "n02", segment: "Intro", model: "罗马烛光", caliber: "25mm", angle: "75°", positionId: "B", plannedMs: 18000, durationMs: 8000, safeDistance: 20, musicCue: "00:17.500", status: "pending", firedAtMs: null },
    { id: "n03", segment: "Intro", model: "冷焰火", caliber: "20mm", angle: "90°", positionId: "E", plannedMs: 24000, durationMs: 6000, safeDistance: 15, musicCue: "00:23.500", status: "pending", firedAtMs: null },
    { id: "n04", segment: "Verse", model: "礼花弹", caliber: "75mm", angle: "80°", positionId: "C", plannedMs: 45000, durationMs: 1500, safeDistance: 60, musicCue: "00:44.500", status: "pending", firedAtMs: null },
    { id: "n05", segment: "Verse", model: "礼花弹", caliber: "50mm", angle: "75°", positionId: "D", plannedMs: 52400, durationMs: 1500, safeDistance: 45, musicCue: "00:52.000", status: "pending", firedAtMs: null },
    { id: "n06", segment: "Chorus A", model: "礼花弹", caliber: "75mm", angle: "80°", positionId: "A", plannedMs: 68200, durationMs: 1500, safeDistance: 60, musicCue: "01:07.800", status: "pending", firedAtMs: null },
    { id: "n07", segment: "Chorus A", model: "扇形架", caliber: "30mm", angle: "扇形45°", positionId: "B", plannedMs: 74000, durationMs: 3000, safeDistance: 35, musicCue: "01:13.500", status: "pending", firedAtMs: null },
    { id: "n08", segment: "Chorus A", model: "罗马烛光", caliber: "25mm", angle: "75°", positionId: "C", plannedMs: 80000, durationMs: 8000, safeDistance: 20, musicCue: "01:19.500", status: "pending", firedAtMs: null },
    { id: "n09", segment: "Bridge", model: "冷焰火", caliber: "20mm", angle: "90°", positionId: "E", plannedMs: 105000, durationMs: 6000, safeDistance: 15, musicCue: "01:44.500", status: "pending", firedAtMs: null },
    { id: "n10", segment: "Bridge", model: "礼花弹", caliber: "50mm", angle: "75°", positionId: "D", plannedMs: 118000, durationMs: 1500, safeDistance: 45, musicCue: "01:57.500", status: "pending", firedAtMs: null },
    { id: "n11", segment: "Finale", model: "礼花弹", caliber: "100mm", angle: "85°", positionId: "C", plannedMs: 210000, durationMs: 1800, safeDistance: 80, musicCue: "03:29.500", status: "pending", firedAtMs: null },
    { id: "n12", segment: "Finale", model: "礼花弹", caliber: "75mm", angle: "80°", positionId: "A", plannedMs: 222000, durationMs: 1500, safeDistance: 60, musicCue: "03:41.500", status: "pending", firedAtMs: null },
    { id: "n13", segment: "Finale", model: "冷焰火", caliber: "20mm", angle: "90°", positionId: "B", plannedMs: 228000, durationMs: 6000, safeDistance: 15, musicCue: "03:47.500", status: "pending", firedAtMs: null },
  ];
  return { nodes, ceasefire: { active: false, atMs: null }, resumeLog: [], clockMs: 20000 };
}

function loadState(): ShowState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ShowState;
      if (parsed && Array.isArray(parsed.nodes) && parsed.ceasefire && Array.isArray(parsed.resumeLog)) {
        return {
          nodes: parsed.nodes,
          ceasefire: {
            active: Boolean(parsed.ceasefire.active),
            atMs: typeof parsed.ceasefire.atMs === "number" ? parsed.ceasefire.atMs : null,
          },
          resumeLog: parsed.resumeLog,
          clockMs: typeof parsed.clockMs === "number" ? parsed.clockMs : 0,
        };
      }
    }
  } catch {
    // 本地数据损坏时回退到演示数据
  }
  return seedState();
}

const emptyForm = {
  segment: "",
  model: MODELS[0],
  positionId: POSITIONS[0].id,
  caliber: "",
  angle: "",
  time: "",
  duration: "3",
  distance: "30",
  music: "",
};

function App() {
  const [show, setShow] = useState<ShowState>(loadState);
  const [running, setRunning] = useState(false);
  const [reviewer, setReviewer] = useState("");
  const [newTime, setNewTime] = useState("");
  const [resumeErrors, setResumeErrors] = useState<string[]>([]);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  // 本地存储同步：任何状态变化立即持久化，刷新后保留
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(show));
    } catch {
      // 存储不可用时仅保持内存状态
    }
  }, [show]);

  // 演出时钟走钟
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setShow((prev) => ({ ...prev, clockMs: prev.clockMs + 100 }));
    }, 100);
    return () => window.clearInterval(timer);
  }, [running]);

  const sortedNodes = useMemo(
    () => [...show.nodes].sort((a, b) => a.plannedMs - b.plannedMs),
    [show.nodes],
  );

  const maxMs = useMemo(
    () =>
      Math.max(
        60000,
        show.clockMs,
        ...show.nodes.map((n) => Math.max(n.plannedMs, n.firedAtMs ?? 0)),
      ) * 1.06,
    [show.nodes, show.clockMs],
  );

  const firedCount = show.nodes.filter((n) => n.status === "fired").length;
  const pendingCount = show.nodes.filter((n) => n.status === "pending").length;
  const suspendedCount = show.nodes.filter((n) => n.status === "suspended").length;
  const segmentCount = new Set(show.nodes.map((n) => n.segment)).size;
  const minDistance = show.nodes.length ? Math.min(...show.nodes.map((n) => n.safeDistance)) : 0;

  // 冲突提示：未完成节点中，同点位计划点火间隔不足 1.2 秒的组合
  const conflictPairs = useMemo(() => {
    const alive = show.nodes.filter((n) => n.status !== "fired");
    const pairs: Array<[IgnitionNode, IgnitionNode]> = [];
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        if (
          alive[i].positionId === alive[j].positionId &&
          Math.abs(alive[i].plannedMs - alive[j].plannedMs) < MIN_INTERVAL_MS
        ) {
          pairs.push([alive[i], alive[j]]);
        }
      }
    }
    return pairs;
  }, [show.nodes]);

  const conflictIds = useMemo(
    () => new Set(conflictPairs.flatMap(([a, b]) => [a.id, b.id])),
    [conflictPairs],
  );

  const modelRows = useMemo(
    () =>
      MODELS.map((model) => {
        const ns = show.nodes.filter((n) => n.model === model);
        return {
          model,
          calibers: Array.from(new Set(ns.map((n) => n.caliber))).join(" / ") || "—",
          total: ns.length,
          fired: ns.filter((n) => n.status === "fired").length,
          pending: ns.filter((n) => n.status === "pending").length,
          suspended: ns.filter((n) => n.status === "suspended").length,
        };
      }).filter((row) => row.total > 0),
    [show.nodes],
  );

  const positionRows = POSITIONS.map((p) => {
    const ns = show.nodes.filter((n) => n.positionId === p.id);
    const suspended = ns.filter((n) => n.status === "suspended").length;
    const pending = ns.filter((n) => n.status === "pending").length;
    const fired = ns.filter((n) => n.status === "fired").length;
    const color =
      suspended > 0 ? "#f59e0b" : pending > 0 ? "#1d4ed8" : fired > 0 ? "#16a34a" : "#94a3b8";
    return { ...p, total: ns.length, suspended, pending, fired, color };
  });

  // 点火：仅待点火节点可点火；挂起节点不能直接点火；停火期间禁止点火
  const fireNode = (id: string) => {
    setShow((prev) => {
      if (prev.ceasefire.active) return prev;
      return {
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === id && n.status === "pending"
            ? { ...n, status: "fired" as NodeStatus, firedAtMs: prev.clockMs }
            : n,
        ),
      };
    });
  };

  // 触发停火：未完成节点全部挂起，已点火记录保持只读
  const triggerCeasefire = () => {
    setRunning(false);
    setResumeNote(null);
    setResumeErrors([]);
    setShow((prev) => ({
      ...prev,
      ceasefire: { active: true, atMs: prev.clockMs },
      nodes: prev.nodes.map((n) =>
        n.status === "pending" ? { ...n, status: "suspended" as NodeStatus } : n,
      ),
    }));
  };

  // 复核恢复：任一校验失败则整组拒绝，原状态不变
  const handleResume = () => {
    const name = reviewer.trim();
    const baseMs = parseTimeInput(newTime);
    const ceaseAt = show.ceasefire.atMs ?? 0;
    const errors: string[] = [];
    if (!name) errors.push("请填写安全复核人。");
    if (baseMs === null) {
      errors.push("请填写合法的新点火时间（格式 mm:ss.mmm，如 01:35.000）。");
    } else if (baseMs < ceaseAt) {
      errors.push(`新点火时间 ${formatMs(baseMs)} 早于停火时刻 ${formatMs(ceaseAt)}，整组拒绝，原状态不变。`);
    }
    if (errors.length > 0 || baseMs === null) {
      setResumeErrors(errors);
      setResumeNote(null);
      return;
    }
    const base = baseMs;

    const suspended = show.nodes.filter((n) => n.status === "suspended");
    // 以挂起组最早计划时间为锚点整体平移到新点火时间，保持组内相对间隔
    const shift = suspended.length > 0 ? base - Math.min(...suspended.map((n) => n.plannedMs)) : 0;

    const conflicts: string[] = [];
    for (const n of suspended) {
      const t = n.plannedMs + shift;
      for (const f of show.nodes) {
        if (f.status === "fired" && f.positionId === n.positionId && f.firedAtMs !== null) {
          const gap = Math.abs(t - f.firedAtMs);
          if (gap < MIN_INTERVAL_MS) {
            conflicts.push(
              `${n.positionId} 点位 · ${n.segment} / ${n.model} 新点火 ${formatMs(t)}，与同点位已点火记录 ${formatMs(f.firedAtMs)} 间隔 ${(gap / 1000).toFixed(2)}s，不足 1.20s`,
            );
          }
        }
      }
    }
    if (conflicts.length > 0) {
      setResumeErrors([
        `同点位间隔校验未通过（共 ${conflicts.length} 处），整组拒绝，原状态不变：`,
        ...conflicts,
      ]);
      setResumeNote(null);
      return;
    }

    setShow((prev) => ({
      ...prev,
      ceasefire: { active: false, atMs: null },
      nodes: prev.nodes.map((n) =>
        n.status === "suspended"
          ? { ...n, status: "pending" as NodeStatus, plannedMs: n.plannedMs + shift }
          : n,
      ),
      resumeLog: [
        ...prev.resumeLog,
        { reviewer: name, baseMs: base, count: suspended.length, loggedAtMs: prev.clockMs },
      ],
    }));
    setResumeErrors([]);
    setResumeNote(
      `安全复核人 ${name} 已确认，${suspended.length} 个挂起节点整组恢复为待点火，新基准点火时间 ${formatMs(base)}。`,
    );
    setReviewer("");
    setNewTime("");
  };

  const addNode = () => {
    const plannedMs = parseTimeInput(form.time);
    if (!form.segment.trim()) {
      setFormError("请填写节目段落。");
      return;
    }
    if (plannedMs === null) {
      setFormError("点火时间格式不正确，请使用 mm:ss.mmm（如 01:35.000）。");
      return;
    }
    const node: IgnitionNode = {
      id: `n${Date.now().toString(36)}`,
      segment: form.segment.trim(),
      model: form.model,
      caliber: form.caliber.trim() || "—",
      angle: form.angle.trim() || "90°",
      positionId: form.positionId,
      plannedMs,
      durationMs: Math.max(0, Math.round(Number(form.duration) * 1000) || 0),
      safeDistance: Math.max(0, Number(form.distance) || 0),
      musicCue: form.music.trim() || "—",
      // 停火期间新增节点同样挂起，不能直接点火
      status: show.ceasefire.active ? "suspended" : "pending",
      firedAtMs: null,
    };
    setShow((prev) => ({ ...prev, nodes: [...prev.nodes, node] }));
    setFormError(null);
    setForm({ ...form, segment: "", time: "", music: "" });
  };

  const resetShow = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 忽略存储异常
    }
    setRunning(false);
    setResumeErrors([]);
    setResumeNote(null);
    setFormError(null);
    setShow(seedState());
  };

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62008 · 源提示词10 · Port 62008</p>
        <h1>烟花燃放脚本编排 · 全场停火恢复台</h1>
        <span>
          每个点火节点实时标记 已点火 / 待点火 / 停火挂起。触发停火后，未完成节点全部挂起，
          已点火记录转为只读，挂起节点不能直接点火；恢复须由安全复核人登记不早于停火时刻的新点火时间，
          若与同点位已点火记录间隔不足 1.2 秒，整组拒绝且原状态不变。时间轴、点位图、型号清单与本地存储同步，刷新保留。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>节目段落</small>
          <strong>{segmentCount}</strong>
        </article>
        <article>
          <small>点火节点</small>
          <strong>{show.nodes.length}</strong>
        </article>
        <article>
          <small>冲突提示</small>
          <strong>{conflictPairs.length}</strong>
        </article>
        <article>
          <small>安全距离</small>
          <strong>{minDistance}m</strong>
        </article>
      </section>

      <section className={`panel ceasefire-panel${show.ceasefire.active ? " is-active" : ""}`}>
        <div className="heading">
          <div>
            <p>全场控制</p>
            <h2>停火 / 恢复控制台</h2>
          </div>
          <div className="clock">
            <span>演出时钟</span>
            <strong>{formatMs(show.clockMs)}</strong>
            <div className="clock-actions">
              <button onClick={() => setRunning((r) => !r)}>{running ? "暂停走钟" : "开始走钟"}</button>
              <button
                onClick={() => {
                  setRunning(false);
                  setShow((prev) => ({ ...prev, clockMs: 0 }));
                }}
              >
                时钟归零
              </button>
            </div>
          </div>
        </div>

        <div className="status-strip">
          <span className="st-fired">已点火 {firedCount}</span>
          <span className="st-pending">待点火 {pendingCount}</span>
          <span className="st-suspended">停火挂起 {suspendedCount}</span>
        </div>

        {!show.ceasefire.active ? (
          <div className="ceasefire-row">
            <p>当前无停火。触发后所有未完成节点立即挂起，已点火记录保持只读，挂起节点不能直接点火。</p>
            <button className="danger" onClick={triggerCeasefire}>
              触发全场停火
            </button>
          </div>
        ) : (
          <div className="resume-box">
            <p className="ceasefire-banner">
              全场停火中 · 停火时刻 {formatMs(show.ceasefire.atMs ?? 0)} · 挂起 {suspendedCount} 个节点
            </p>
            <div className="field-grid">
              <label>
                <span>安全复核人</span>
                <input
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  placeholder="填写复核人姓名"
                />
              </label>
              <label>
                <span>新点火时间（不早于停火时刻 {formatMs(show.ceasefire.atMs ?? 0)}）</span>
                <input
                  value={newTime}
                  onChange={(e) => setNewTime(e.target.value)}
                  placeholder="mm:ss.mmm"
                />
              </label>
            </div>
            <button className="primary" onClick={handleResume}>
              复核并整组恢复
            </button>
            {resumeErrors.length > 0 && (
              <ul className="errors">
                {resumeErrors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {resumeNote && <p className="ok-note">{resumeNote}</p>}

        {show.resumeLog.length > 0 && (
          <div className="resume-log">
            <h3>恢复记录</h3>
            {show.resumeLog.map((rec, index) => (
              <p key={`${rec.loggedAtMs}-${index}`}>
                #{index + 1} 复核人 {rec.reviewer} · 新基准点火 {formatMs(rec.baseMs)} · 整组恢复{" "}
                {rec.count} 个节点 · 登记于演出时钟 {formatMs(rec.loggedAtMs)}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>燃放点位平面图</h2>
          <svg viewBox="0 0 100 64" className="map" role="img" aria-label="燃放点位平面图">
            <rect x="1" y="1" width="98" height="62" rx="4" className="map-bound" />
            <line x1="1" y1="54" x2="99" y2="54" className="map-line" />
            <text x="50" y="60" textAnchor="middle" className="map-note">
              观众区 / 安全警戒线
            </text>
            {positionRows.map((p) => (
              <g key={p.id}>
                <circle cx={p.x} cy={p.y} r="5.5" fill={p.color} opacity="0.22" />
                <circle cx={p.x} cy={p.y} r="2.6" fill={p.color} />
                <text x={p.x} y={p.y - 7} textAnchor="middle" className="map-label">
                  {p.id}
                </text>
              </g>
            ))}
          </svg>
          <ul className="pos-list">
            {positionRows.map((p) => (
              <li key={p.id}>
                <i style={{ background: p.color }} />
                <b>{p.id} 点位</b>
                <span>
                  已点火 {p.fired} · 待点火 {p.pending} · 挂起 {p.suspended}
                </span>
              </li>
            ))}
          </ul>
        </aside>

        <section className="panel">
          <div className="heading">
            <div>
              <p>时间轴编排</p>
              <h2>点火节点时间轴</h2>
            </div>
            <span className="axis-clock">时钟 {formatMs(show.clockMs)}</span>
          </div>
          <div className="tl-row tl-scale">
            <span />
            <div className="tl-scale-labels">
              <span>00:00.000</span>
              <span>{formatMs(maxMs / 2)}</span>
              <span>{formatMs(maxMs)}</span>
            </div>
            <span />
            <span />
          </div>
          <div className="timeline">
            {sortedNodes.map((node) => (
              <article key={node.id} className={`tl-row st-${node.status}`}>
                <div className="tl-meta">
                  <b>{formatMs(node.plannedMs)}</b>
                  <span>
                    {node.segment} · {node.model} · {node.positionId} 点位
                  </span>
                  {conflictIds.has(node.id) && <em className="conflict-tag">同点位间隔&lt;1.2s</em>}
                </div>
                <div className="tl-track">
                  <span
                    className="tl-clock"
                    style={{ left: `${Math.min(100, (show.clockMs / maxMs) * 100)}%` }}
                  />
                  <i className="tl-planned" style={{ left: `${(node.plannedMs / maxMs) * 100}%` }} />
                  {node.firedAtMs !== null && (
                    <u className="tl-fired" style={{ left: `${(node.firedAtMs / maxMs) * 100}%` }} />
                  )}
                </div>
                <span className="badge">{STATUS_LABEL[node.status]}</span>
                <div className="tl-action">
                  {node.status === "fired" && (
                    <span className="readonly-note">已点火 {formatMs(node.firedAtMs ?? 0)} · 只读</span>
                  )}
                  {node.status === "suspended" && (
                    <button disabled title="停火挂起节点不能直接点火，须复核恢复">
                      挂起中 · 需复核恢复
                    </button>
                  )}
                  {node.status === "pending" && (
                    <button
                      className="primary"
                      onClick={() => fireNode(node.id)}
                      disabled={show.ceasefire.active}
                    >
                      点火
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>型号清单</p>
            <h2>烟花型号与状态汇总</h2>
          </div>
        </div>
        <table className="model-table">
          <thead>
            <tr>
              <th>烟花型号</th>
              <th>口径</th>
              <th>总数</th>
              <th>已点火</th>
              <th>待点火</th>
              <th>停火挂起</th>
            </tr>
          </thead>
          <tbody>
            {modelRows.map((row) => (
              <tr key={row.model}>
                <td>{row.model}</td>
                <td>{row.calibers}</td>
                <td>{row.total}</td>
                <td>{row.fired}</td>
                <td>{row.pending}</td>
                <td>{row.suspended}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel form-panel">
        <div className="heading">
          <div>
            <p>专业字段</p>
            <h2>新增点火节点</h2>
          </div>
          <button className="primary" onClick={addNode}>
            保存节点
          </button>
        </div>
        <div className="field-grid">
          <label>
            <span>节目段落</span>
            <input
              value={form.segment}
              onChange={(e) => setForm({ ...form, segment: e.target.value })}
              placeholder="如 Chorus B"
            />
          </label>
          <label>
            <span>烟花型号</span>
            <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>燃放点位</span>
            <select
              value={form.positionId}
              onChange={(e) => setForm({ ...form, positionId: e.target.value })}
            >
              {POSITIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} 点位
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>口径</span>
            <input
              value={form.caliber}
              onChange={(e) => setForm({ ...form, caliber: e.target.value })}
              placeholder="如 75mm"
            />
          </label>
          <label>
            <span>发射角度</span>
            <input
              value={form.angle}
              onChange={(e) => setForm({ ...form, angle: e.target.value })}
              placeholder="如 80°"
            />
          </label>
          <label>
            <span>点火时间</span>
            <input
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
              placeholder="mm:ss.mmm"
            />
          </label>
          <label>
            <span>持续时间（秒）</span>
            <input
              value={form.duration}
              onChange={(e) => setForm({ ...form, duration: e.target.value })}
              placeholder="如 3"
            />
          </label>
          <label>
            <span>安全距离（米）</span>
            <input
              value={form.distance}
              onChange={(e) => setForm({ ...form, distance: e.target.value })}
              placeholder="如 45"
            />
          </label>
          <label>
            <span>音乐时间点</span>
            <input
              value={form.music}
              onChange={(e) => setForm({ ...form, music: e.target.value })}
              placeholder="如 01:35.000"
            />
          </label>
        </div>
        {formError && <p className="form-error">{formError}</p>}
        {show.ceasefire.active && <p className="hint">停火期间新增节点将直接挂起，须复核恢复后方可点火。</p>}
      </section>

      <footer className="footer">
        <span>全部状态通过 localStorage 本地持久化，刷新页面后保留。</span>
        <button onClick={resetShow}>清空本地存储并重置演示数据</button>
      </footer>
    </main>
  );
}

export default App;
