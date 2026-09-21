import "./styles.css";

const project = {
  "sourceNo": 10,
  "id": "hxyfront-62008",
  "port": 62008,
  "title": "烟花燃放脚本编排",
  "domain": "烟花燃放编排",
  "prompt": "我想做一个面向烟花燃放编排师的燃放脚本前端工具，可以记录节目段落、烟花型号、口径、发射角度、点火时间、持续时间、安全距离和音乐时间点。页面需要有时间轴编排、燃放点位平面图、型号清单、冲突时间提示和整场节目预览。",
  "palette": [
    "#1d4ed8",
    "#dc2626",
    "#f59e0b"
  ],
  "metrics": [
    "节目段落",
    "点火节点",
    "冲突提示",
    "安全距离"
  ],
  "filters": [
    "礼花弹",
    "罗马烛光",
    "扇形架",
    "冷焰火"
  ],
  "fields": [
    "节目段落",
    "烟花型号",
    "口径",
    "发射角度",
    "点火时间",
    "安全距离"
  ],
  "records": [
    [
      "Intro",
      "30mm扇形架",
      "00:12.500",
      "安全距离35m"
    ],
    [
      "Chorus A",
      "75mm礼花弹",
      "01:08.200",
      "与B点位间隔正常"
    ],
    [
      "Finale",
      "冷焰火",
      "03:42.000",
      "近景区待确认"
    ]
  ]
};

function App() {
  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {project.metrics.map((metric: string, index: number) => (
          <article key={metric}>
            <small>{metric}</small>
            <strong>{[86, 14, 7, 32][index] ?? 12}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain}筛选</h2>
          <div className="chips">
            {project.filters.map((item: string) => (
              <button key={item}>{item}</button>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <button className="primary">保存草稿</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>近期工作台</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="records">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
