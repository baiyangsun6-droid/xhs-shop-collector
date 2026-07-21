import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Copy,
  Database,
  ExternalLink,
  FileDown,
  FileText,
  Globe2,
  HelpCircle,
  Loader2,
  LogIn,
  Menu,
  MoreVertical,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Square,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = window.location.port === "5173" ? "http://127.0.0.1:3456" : "";

const defaultConfig = {
  feishu: {
    baseToken: "",
    tableId: "",
    viewId: "",
    identity: "auto",
    fieldMap: {
      creatorName: "博主名字",
      creatorUrl: "博主主页链接",
      shopUrl: "店铺链接",
      productTitle: "商品标题",
      sales: "商品销量",
      price: "商品价格",
      productUrl: "商品链接",
      collectedAt: "采集时间",
    },
  },
  collector: {
    maxScrollRounds: 40,
    stableRounds: 5,
    dryRun: false,
    useBrowserFallback: false,
    requestDelayMs: 3000,
  },
};

const navItems = [
  { id: "tasks", label: "任务中心", icon: ClipboardList },
  { id: "connections", label: "连接配置", icon: Database },
  { id: "login", label: "手动浏览", icon: LogIn },
  { id: "mapping", label: "数据映射", icon: Table2 },
  { id: "logs", label: "运行日志", icon: FileText },
];

const fieldLabels = [
  ["creatorName", "博主名字"],
  ["creatorUrl", "博主主页链接"],
  ["shopUrl", "店铺链接"],
  ["productTitle", "商品标题"],
  ["sales", "商品销量"],
  ["price", "商品价格"],
  ["productUrl", "商品链接"],
  ["collectedAt", "采集时间"],
];

export function App() {
  const [activeView, setActiveView] = useState("tasks");
  const [appState, setAppState] = useState(null);
  const [config, setConfig] = useState(defaultConfig);
  const [batchUrls, setBatchUrls] = useState("");
  const [writeMode, setWriteMode] = useState("overwrite");
  const [salesFilterEnabled, setSalesFilterEnabled] = useState(false);
  const [minSales, setMinSales] = useState("10");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [checkedTaskIds, setCheckedTaskIds] = useState([]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    refreshAll();
    const source = new EventSource(`${API_BASE}/api/events`);
    source.addEventListener("state", () => refreshState());
    source.addEventListener("task", () => refreshState());
    source.addEventListener("log", () => refreshState());
    return () => source.close();
  }, []);

  const tasks = appState?.tasks || [];
  useEffect(() => {
    const availableIds = new Set(tasks.map((task) => task.id));
    setCheckedTaskIds((current) => {
      const next = current.filter((id) => availableIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [tasks]);

  const selectedTask = useMemo(() => {
    if (!tasks.length) return null;
    return tasks.find((task) => task.id === appState?.selectedTaskId) || tasks[0];
  }, [tasks, appState?.selectedTaskId]);

  const stats = useMemo(() => {
    const counts = { running: 0, queued: 0, done: 0, failed: 0, stopped: 0 };
    for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
    return counts;
  }, [tasks]);

  async function refreshAll() {
    const [statePayload, configPayload] = await Promise.all([api("/api/state"), api("/api/config")]);
    setAppState(statePayload);
    setConfig(configPayload);
  }

  async function refreshState() {
    const payload = await api("/api/state");
    setAppState(payload);
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const next = await api("/api/config", { method: "POST", body: config });
      setConfig(next);
      setNotice("配置已保存");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function testFeishu() {
    setNotice("正在测试飞书连接");
    try {
      const result = await api("/api/feishu/test", { method: "POST" });
      setNotice(result.ok ? "飞书字段映射正常" : `缺少字段：${result.missing.join("、")}`);
      await refreshState();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function openLogin() {
    try {
      await api("/api/xhs/login", { method: "POST" });
      setNotice("已打开手动浏览器，默认采集不会使用登录态");
      await refreshState();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function startTasks() {
    const parsedMinSales = Number(minSales);
    if (salesFilterEnabled && (!Number.isInteger(parsedMinSales) || parsedMinSales < 0)) {
      setNotice("销量筛选值需要填写 0 或更大的整数");
      return;
    }
    try {
      await api("/api/tasks/start", {
        method: "POST",
        body: {
          urls: batchUrls,
          mode: writeMode,
          overwrite: writeMode === "overwrite",
          salesFilter: { enabled: salesFilterEnabled, minSales: parsedMinSales || 0 },
        },
      });
      setNotice("采集任务已开始");
      await refreshState();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function stopTasks() {
    await api("/api/tasks/stop", { method: "POST" });
    setNotice("已请求停止");
    await refreshState();
  }

  async function clearLogs() {
    await api("/api/logs/clear", { method: "POST" });
    await refreshState();
  }

  function downloadTemplate() {
    const blob = new Blob(
      [
        "https://www.xiaohongshu.com/user/profile/xxxx\n",
        "https://xhslink.com/m/xxxx\n",
      ],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "xhs-creator-urls-template.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportLogs() {
    const rows = (appState?.logs || [])
      .slice()
      .reverse()
      .map((entry) => `${entry.time}\t${entry.level}\t${entry.message}`)
      .join("\n");
    const blob = new Blob([`时间\t级别\t内容\n${rows}\n`], { type: "text/tab-separated-values;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "xhs-collector-logs.tsv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function selectTask(id) {
    await api(`/api/tasks/${id}/select`, { method: "POST" });
    await refreshState();
  }

  async function retryTask(id) {
    await api(`/api/tasks/${id}/retry`, { method: "POST" });
    setInspectorOpen(true);
    await refreshState();
  }

  async function skipTask(id) {
    await api(`/api/tasks/${id}/skip`, { method: "POST" });
    await refreshState();
  }

  async function deleteTasks(ids) {
    const uniqueIds = Array.from(new Set(ids)).filter((id) => tasks.some((task) => task.id === id));
    if (!uniqueIds.length) return;
    if (tasks.some((task) => uniqueIds.includes(task.id) && task.status === "running")) {
      setNotice("正在采集的任务不能删除，请先停止任务");
      return;
    }

    const confirmed = window.confirm(
      `确定从软件中删除${uniqueIds.length > 1 ? `这 ${uniqueIds.length} 条` : "这条"}任务吗？\n\n只会删除本地任务、关联日志和商品预览，不会删除飞书里的任何数据。`,
    );
    if (!confirmed) return;

    try {
      const result = await api("/api/tasks", { method: "DELETE", body: { ids: uniqueIds } });
      setCheckedTaskIds((current) => current.filter((id) => !uniqueIds.includes(id)));
      setNotice(`已从软件删除 ${result.deleted} 条任务，飞书数据未受影响`);
      await refreshState();
    } catch (error) {
      setNotice(error.message);
    }
  }

  function toggleTaskChecked(id, checked) {
    setCheckedTaskIds((current) => checked
      ? Array.from(new Set([...current, id]))
      : current.filter((taskId) => taskId !== id));
  }

  function toggleAllTasks(checked) {
    setCheckedTaskIds(checked ? tasks.map((task) => task.id) : []);
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBatchUrls(await file.text());
    event.target.value = "";
  }

  function updateFieldMap(key, value) {
    setConfig((current) => ({
      ...current,
      feishu: {
        ...current.feishu,
        fieldMap: {
          ...current.feishu.fieldMap,
          [key]: value,
        },
      },
    }));
  }

  async function handleSelectTask(id) {
    setInspectorOpen(true);
    await selectTask(id);
  }

  function navigateTo(view) {
    setActiveView(view);
    setHelpOpen(false);
  }

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">小红书</div>
          <div>
            <div className="brand-title">小红书商品采集器</div>
            <div className="brand-subtitle">本地可视化工具</div>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`nav-item ${activeView === item.id ? "active" : ""}`}
                key={item.id}
                onClick={() => setActiveView(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="service-line">
            <span className="dot green" />
            <span>服务运行中</span>
          </div>
          <div className="version">v{appState?.service?.version || "0.1.0"}</div>
          <button className="sidebar-setting" onClick={() => setActiveView("connections")}>
            <Settings size={16} />
            <span>系统设置</span>
          </button>
        </div>
      </aside>

      <section className="workspace">
        <TopBar
          appState={appState}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          onHelp={() => setHelpOpen(true)}
          onNavigate={navigateTo}
        />
        {notice && (
          <button className="notice" onClick={() => setNotice("")}>
            <span>{notice}</span>
            <X size={14} />
          </button>
        )}

        {activeView === "tasks" && (
          <TaskCenter
            appState={appState}
            batchUrls={batchUrls}
            setBatchUrls={setBatchUrls}
            fileInputRef={fileInputRef}
            importFile={importFile}
            startTasks={startTasks}
            stopTasks={stopTasks}
            openLogin={openLogin}
            refreshState={refreshState}
            clearLogs={clearLogs}
            downloadTemplate={downloadTemplate}
            exportLogs={exportLogs}
            selectTask={handleSelectTask}
            retryTask={retryTask}
            skipTask={skipTask}
            deleteTasks={deleteTasks}
            checkedTaskIds={checkedTaskIds}
            toggleTaskChecked={toggleTaskChecked}
            toggleAllTasks={toggleAllTasks}
            selectedTask={selectedTask}
            inspectorOpen={inspectorOpen}
            setInspectorOpen={setInspectorOpen}
            stats={stats}
            writeMode={writeMode}
            setWriteMode={setWriteMode}
            salesFilterEnabled={salesFilterEnabled}
            setSalesFilterEnabled={setSalesFilterEnabled}
            minSales={minSales}
            setMinSales={setMinSales}
          />
        )}

        {activeView === "connections" && (
          <ConnectionsPanel
            config={config}
            setConfig={setConfig}
            appState={appState}
            saveConfig={saveConfig}
            testFeishu={testFeishu}
            openLogin={openLogin}
            saving={saving}
          />
        )}

        {activeView === "login" && (
          <LoginPanel appState={appState} openLogin={openLogin} refreshState={refreshState} />
        )}

        {activeView === "mapping" && (
          <MappingPanel
            config={config}
            updateFieldMap={updateFieldMap}
            saveConfig={saveConfig}
            testFeishu={testFeishu}
            saving={saving}
          />
        )}

        {activeView === "logs" && <LogsPanel logs={appState?.logs || []} />}
      </section>

      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} onNavigate={navigateTo} />}
      <input ref={fileInputRef} type="file" accept=".txt,.csv" hidden onChange={importFile} />
    </main>
  );
}

function TopBar({ appState, onToggleSidebar, onHelp, onNavigate }) {
  const feishu = appState?.connections?.feishu;
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <header className="topbar">
      <button className="icon-button" title="收起导航" onClick={onToggleSidebar}>
        <Menu size={20} />
      </button>
      <div className="top-status">
        <StatusPill label="飞书连接" status={feishu?.status} text={statusText(feishu)} />
        <span className="splitter" />
        <StatusPill label="浏览器" status={appState?.connections?.browser?.status} text={appState?.connections?.browser?.message || "未打开"} />
      </div>
      <div className="top-actions">
        <button className="ghost-button" onClick={onHelp}>
          <HelpCircle size={16} />
          帮助
        </button>
        <details className="user-menu-wrapper" open={menuOpen} onToggle={(event) => setMenuOpen(event.currentTarget.open)}>
          <summary className="user-menu">
            <span className="avatar">管</span>
            <span>管理员</span>
            <ChevronDown size={14} />
          </summary>
          <div className="top-menu-panel">
            <button onClick={() => { onNavigate("connections"); setMenuOpen(false); }}>连接配置</button>
            <button onClick={() => { onNavigate("login"); setMenuOpen(false); }}>登录会话</button>
            <button onClick={() => { onNavigate("mapping"); setMenuOpen(false); }}>字段映射</button>
          </div>
        </details>
      </div>
    </header>
  );
}

function TaskCenter(props) {
  const {
    appState,
    batchUrls,
    setBatchUrls,
    fileInputRef,
    startTasks,
    stopTasks,
    openLogin,
    refreshState,
    clearLogs,
    downloadTemplate,
    exportLogs,
    selectTask,
    retryTask,
    skipTask,
    deleteTasks,
    checkedTaskIds,
    toggleTaskChecked,
    toggleAllTasks,
    selectedTask,
    inspectorOpen,
    setInspectorOpen,
    stats,
    writeMode,
    setWriteMode,
    salesFilterEnabled,
    setSalesFilterEnabled,
    minSales,
    setMinSales,
  } = props;
  const tasks = appState?.tasks || [];
  const products = appState?.productsPreview || [];

  return (
    <div className="task-layout">
      <section className="main-column">
        <div className="command-strip">
          <label className="url-input-group">
            <span>批量输入博主主页 / 店铺 / 短链（每行一个）</span>
            <textarea
              value={batchUrls}
              onChange={(event) => setBatchUrls(event.target.value)}
              placeholder={"https://xhslink.com/m/...\nhttps://www.xiaohongshu.com/shop/...\nhttps://www.xiaohongshu.com/user/profile/..."}
            />
          </label>
          <div className="import-zone">
            <span>或</span>
            <button className="secondary-button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={16} />
              上传文件导入
            </button>
            <button className="link-button" onClick={downloadTemplate}>
              <FileDown size={15} />
              下载模板
            </button>
          </div>
          <div className="task-options">
            <div className="sales-filter-group">
              <div className="mode-label">商品筛选</div>
              <div className="segmented two">
                <button
                  className={!salesFilterEnabled ? "active" : ""}
                  aria-pressed={!salesFilterEnabled}
                  onClick={() => setSalesFilterEnabled(false)}
                  disabled={appState?.running}
                >
                  全部商品
                </button>
                <button
                  className={salesFilterEnabled ? "active" : ""}
                  aria-pressed={salesFilterEnabled}
                  onClick={() => setSalesFilterEnabled(true)}
                  disabled={appState?.running}
                >
                  按销量
                </button>
              </div>
              {salesFilterEnabled && (
                <label className="sales-threshold">
                  <span>销量</span>
                  <strong>&gt;</strong>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    value={minSales}
                    onChange={(event) => setMinSales(event.target.value)}
                    disabled={appState?.running}
                    aria-label="销量筛选值"
                  />
                </label>
              )}
            </div>
            <div className="mode-group">
              <div className="mode-label">
                写入模式
                <HelpCircle size={14} />
              </div>
              <div className="segmented">
                {[
                  ["overwrite", "覆盖"],
                  ["skip", "跳过"],
                  ["append", "追加"],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    className={writeMode === mode ? "active" : ""}
                    aria-pressed={writeMode === mode}
                    onClick={() => setWriteMode(mode)}
                    title={writeModeDescription(mode)}
                    disabled={appState?.running}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="command-actions">
            <button className="primary-button" onClick={startTasks} disabled={!batchUrls.trim() || appState?.running}>
              {appState?.running ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
              开始采集
            </button>
            <button className="danger-button" onClick={stopTasks} disabled={!appState?.running}>
              <Square size={15} />
              停止
            </button>
            <details className="more-menu">
              <summary className="secondary-button">
                更多操作
                <ChevronDown size={15} />
              </summary>
              <div className="more-menu-panel">
                <button onClick={openLogin}>手动打开浏览器</button>
                <button onClick={downloadTemplate}>下载模板</button>
                <button onClick={exportLogs}>导出日志</button>
                <button onClick={clearLogs}>清空日志</button>
              </div>
            </details>
          </div>
        </div>

        <div className="task-table-shell">
          <TaskTable
            tasks={tasks}
            selectedTask={selectedTask}
            selectTask={selectTask}
            retryTask={retryTask}
            skipTask={skipTask}
            deleteTasks={deleteTasks}
            checkedTaskIds={checkedTaskIds}
            toggleTaskChecked={toggleTaskChecked}
            toggleAllTasks={toggleAllTasks}
            stopTasks={stopTasks}
          />
          <div className="table-footer">
            <div className="table-footer-primary">
              <span>共 {tasks.length} 条</span>
              {checkedTaskIds.length > 0 && (
                <button
                  className="danger-outline compact"
                  disabled={tasks.some((task) => checkedTaskIds.includes(task.id) && task.status === "running")}
                  title="只删除软件里的任务，不会删除飞书数据"
                  onClick={() => deleteTasks(checkedTaskIds)}
                >
                  <Trash2 size={14} />
                  删除选中（{checkedTaskIds.length}）
                </button>
              )}
            </div>
            <div className="summary-counts">
              <span>采集中 {stats.running || 0}</span>
              <span>等待中 {stats.queued || 0}</span>
              <span>完成 {stats.done || 0}</span>
              <span>失败 {stats.failed || 0}</span>
              <span>已停止 {stats.stopped || 0}</span>
            </div>
          </div>
        </div>

        <div className="bottom-grid">
          <LogPreview logs={appState?.logs || []} clearLogs={clearLogs} exportLogs={exportLogs} />
          <ProductPreview products={products} refreshState={refreshState} />
        </div>
      </section>

      {inspectorOpen ? (
        <Inspector
          task={selectedTask}
          appState={appState}
          retryTask={retryTask}
          skipTask={skipTask}
          deleteTasks={deleteTasks}
          openLogin={openLogin}
          onClose={() => setInspectorOpen(false)}
        />
      ) : (
        <button className="inspector-tab" onClick={() => setInspectorOpen(true)}>显示详情</button>
      )}
    </div>
  );
}

function TaskTable({
  tasks,
  selectedTask,
  selectTask,
  retryTask,
  skipTask,
  deleteTasks,
  checkedTaskIds,
  toggleTaskChecked,
  toggleAllTasks,
  stopTasks,
}) {
  const allChecked = tasks.length > 0 && tasks.every((task) => checkedTaskIds.includes(task.id));
  return (
    <table className="task-table">
      <thead>
        <tr>
          <th className="checkbox-cell">
            <input
              type="checkbox"
              aria-label="选择全部任务"
              checked={allChecked}
              onChange={(event) => toggleAllTasks(event.target.checked)}
            />
          </th>
          <th>博主主页</th>
          <th>博主名称</th>
          <th>采集状态</th>
          <th>当前步骤</th>
          <th>商品数</th>
          <th>商品筛选</th>
          <th>写入模式</th>
          <th>写入飞书</th>
          <th>采集时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {tasks.length === 0 ? (
          <tr>
            <td className="empty-row" colSpan="11">
              还没有任务。粘贴博主主页链接后点击开始采集。
            </td>
          </tr>
        ) : (
          tasks.map((task, index) => (
            <tr
              key={task.id}
              className={selectedTask?.id === task.id ? "selected" : ""}
              onClick={() => selectTask(task.id)}
            >
              <td className="checkbox-cell">
                <input
                  type="checkbox"
                  aria-label={`选择任务：${task.creatorName || task.url}`}
                  checked={checkedTaskIds.includes(task.id)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => toggleTaskChecked(task.id, event.target.checked)}
                />
              </td>
              <td className="url-cell"><a href={task.url} target="_blank" rel="noreferrer">{task.url}</a></td>
              <td>{task.creatorName || "待识别"}</td>
              <td><StatusBadge status={task.status} /></td>
              <td className="step-cell">{task.step}</td>
              <td title={task.salesFilter?.enabled ? `符合筛选 ${task.productCount || 0} 个，店铺共发现 ${task.sourceProductCount || 0} 个` : undefined}>
                {task.salesFilter?.enabled ? `${task.productCount || 0}/${task.sourceProductCount || 0}` : task.productCount || "-"}
              </td>
              <td>{salesFilterLabel(task.salesFilter)}</td>
              <td className="yes-cell">{writeModeLabel(task.writeMode || (task.overwrite ? "overwrite" : "append"))}</td>
              <td><WriteStatus task={task} /></td>
              <td>{formatTime(task.startedAt || task.createdAt)}</td>
              <td>
                <div className="row-actions">
                  {task.status === "failed" ? (
                    <button className="icon-button small" title="重试" onClick={(event) => { event.stopPropagation(); retryTask(task.id); }}>
                      <RotateCcw size={15} />
                    </button>
                  ) : task.status === "running" ? (
                    <button className="icon-button small" title="停止任务" onClick={(event) => { event.stopPropagation(); stopTasks(); }}><Pause size={15} /></button>
                  ) : (
                    <button className="icon-button small" title={task.status === "done" ? "重新采集" : "查看详情"} onClick={(event) => { event.stopPropagation(); task.status === "done" ? retryTask(task.id) : selectTask(task.id); }}><Play size={15} /></button>
                  )}
                  <details className="row-menu" onClick={(event) => event.stopPropagation()}>
                    <summary className="icon-button small" title="更多"><MoreVertical size={15} /></summary>
                    <div className="row-menu-panel">
                      <button onClick={() => selectTask(task.id)}>查看详情</button>
                      <button disabled={task.status === "running"} onClick={() => retryTask(task.id)}>重新采集</button>
                      <button disabled={task.status !== "queued"} onClick={() => skipTask(task.id)}>跳过任务</button>
                      <a href={task.url} target="_blank" rel="noreferrer">打开主页</a>
                      <button
                        className="danger-menu-item"
                        disabled={task.status === "running"}
                        title="不会删除飞书数据"
                        onClick={() => deleteTasks([task.id])}
                      >
                        <Trash2 size={14} />
                        从软件中删除
                      </button>
                    </div>
                  </details>
                </div>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function Inspector({ task, appState, retryTask, skipTask, deleteTasks, openLogin, onClose }) {
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span>当前选择</span>
        <button className="icon-button small" onClick={onClose} title="关闭详情"><X size={16} /></button>
      </div>
      {task ? (
        <>
          <div className="creator-mini">
            <div className="creator-avatar">{(task.creatorName || "博").slice(0, 1)}</div>
            <div>
              <div className="creator-name">{task.creatorName || "等待识别博主"}</div>
              <a href={task.url} target="_blank" rel="noreferrer">{task.url}</a>
            </div>
          </div>

          <dl className="detail-list">
            <div><dt>采集状态</dt><dd><StatusBadge status={task.status} /></dd></div>
            <div><dt>当前步骤</dt><dd>{task.step}</dd></div>
            <div><dt>商品筛选</dt><dd>{salesFilterLabel(task.salesFilter)}</dd></div>
            <div><dt>店铺商品总数</dt><dd>{task.sourceProductCount || 0}</dd></div>
            <div><dt>符合筛选商品数</dt><dd>{task.productCount || 0}</dd></div>
            <div><dt>开始时间</dt><dd>{formatTime(task.startedAt)}</dd></div>
            <div><dt>运行时长</dt><dd>{duration(task.startedAt, task.finishedAt)}</dd></div>
            <div><dt>写入模式</dt><dd>{writeModeLabel(task.writeMode || (task.overwrite ? "overwrite" : "append"))}</dd></div>
            <div><dt>写入飞书</dt><dd><WriteStatus task={task} /></dd></div>
          </dl>

          <div className="inspector-section">
            <div className="section-title">浏览器操作（手动）</div>
            <div className="browser-state">
              <StatusDot status={appState?.connections?.browser?.status} />
              <span>{appState?.connections?.browser?.message || "未打开"}</span>
            </div>
            <p className="muted">默认采集不使用浏览器登录态；只有你在连接配置里开启浏览器兜底时，任务才会自动操作页面。</p>
            <button className="secondary-button full" onClick={openLogin}>
              手动打开浏览器
              <ExternalLink size={15} />
            </button>
          </div>

          <div className="inspector-section">
            <div className="section-title">错误信息</div>
            <p className={task.error ? "error-text" : "muted"}>{task.error || "暂无错误"}</p>
          </div>

          <div className="inspector-actions">
            <button className="secondary-button" disabled={task.status !== "failed"} onClick={() => retryTask(task.id)}>
              <RefreshCw size={15} />
              重试当前
            </button>
            <button className="secondary-button" disabled={task.status === "running"} onClick={() => retryTask(task.id)}>从头开始</button>
            <button className="danger-outline" disabled={task.status !== "queued"} onClick={() => skipTask(task.id)}>跳过该任务</button>
            <button
              className="danger-outline"
              disabled={task.status === "running"}
              title="只删除软件记录，不会删除飞书数据"
              onClick={() => deleteTasks([task.id])}
            >
              <Trash2 size={15} />
              从软件中删除
            </button>
          </div>
        </>
      ) : (
        <div className="empty-inspector">选择一条任务查看详情。</div>
      )}
    </aside>
  );
}

function ConnectionsPanel({ config, setConfig, appState, saveConfig, testFeishu, openLogin, saving }) {
  return (
    <div className="settings-view">
      <section className="settings-panel wide">
        <div className="panel-title">
          <Database size={18} />
          飞书多维表格连接
        </div>
        <p className="risk-note">当前默认使用公开 HTTP 采集模式，不打开小红书页面、不点击、不滚动，也不使用你的登录态。</p>
        <div className="form-grid two">
          <TextInput label="Base Token" value={config.feishu.baseToken} onChange={(value) => setConfig({ ...config, feishu: { ...config.feishu, baseToken: value } })} placeholder="app_xxx 或 Base 链接中的 token" />
          <TextInput label="Table ID / 表名" value={config.feishu.tableId} onChange={(value) => setConfig({ ...config, feishu: { ...config.feishu, tableId: value } })} placeholder="tbl_xxx 或数据表名称" />
          <TextInput label="视图 ID（可选）" value={config.feishu.viewId} onChange={(value) => setConfig({ ...config, feishu: { ...config.feishu, viewId: value } })} placeholder="只在指定视图范围内查旧记录" />
          <SelectInput
            label="飞书执行身份"
            value={config.feishu.identity || "auto"}
            onChange={(value) => setConfig({ ...config, feishu: { ...config.feishu, identity: value } })}
            options={[
              ["auto", "自动选择"],
              ["bot", "应用机器人"],
              ["user", "当前用户"],
            ]}
          />
          <TextInput label="公开请求间隔（毫秒）" value={String(config.collector.requestDelayMs ?? 3000)} onChange={(value) => setConfig({ ...config, collector: { ...config.collector, requestDelayMs: Number(value) || 3000 } })} placeholder="建议 3000 或更高" />
          <ToggleInput label="模拟模式" checked={config.collector.dryRun} onChange={(value) => setConfig({ ...config, collector: { ...config.collector, dryRun: value } })} hint="不请求小红书，不写飞书，用模拟数据验证流程" />
          <ToggleInput label="浏览器兜底" checked={Boolean(config.collector.useBrowserFallback)} onChange={(value) => setConfig({ ...config, collector: { ...config.collector, useBrowserFallback: value } })} hint="默认关闭。开启后会自动打开、点击、滚动页面，可能触发平台风控。" />
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveConfig} disabled={saving}>
            <Save size={16} />
            {saving ? "保存中" : "保存配置"}
          </button>
          <button className="secondary-button" onClick={testFeishu}>
            <RefreshCw size={16} />
            测试连接
          </button>
        </div>
      </section>

      <section className="settings-panel">
        <div className="panel-title">
          <Globe2 size={18} />
          连接状态
        </div>
        <ConnectionRows appState={appState} />
      </section>

      <section className="settings-panel">
        <div className="panel-title">
          <LogIn size={18} />
          小红书手动浏览
        </div>
        <p className="muted">默认采集不需要小红书登录。这个入口只用于你手动查看页面；不建议在收到账号警告后继续用账号做自动化采集。</p>
        <button className="secondary-button" onClick={openLogin}>
          手动打开浏览器
          <ExternalLink size={15} />
        </button>
      </section>
    </div>
  );
}

function LoginPanel({ appState, openLogin, refreshState }) {
  return (
    <div className="settings-view narrow">
      <section className="settings-panel wide">
        <div className="panel-title">
          <LogIn size={18} />
          小红书手动浏览
        </div>
        <div className="login-state">
          <StatusPill label="浏览器" status={appState?.connections?.browser?.status} text={appState?.connections?.browser?.message || "未打开"} />
          <StatusPill label="小红书" status={appState?.connections?.xhs?.status} text={appState?.connections?.xhs?.message || "未检查"} />
        </div>
        <p className="muted">点击后会打开一个 Chromium 窗口，仅供手动查看。默认采集不复用这份登录态；浏览器兜底关闭时，任务不会自动操作页面。</p>
        <div className="button-row">
          <button className="primary-button" onClick={openLogin}>
            <ExternalLink size={16} />
            手动打开浏览器
          </button>
          <button className="secondary-button" onClick={refreshState}>
            <RefreshCw size={16} />
            刷新状态
          </button>
        </div>
      </section>
    </div>
  );
}

function MappingPanel({ config, updateFieldMap, saveConfig, testFeishu, saving }) {
  return (
    <div className="settings-view narrow">
      <section className="settings-panel wide">
        <div className="panel-title">
          <Table2 size={18} />
          字段映射
        </div>
        <p className="muted">左侧是工具内置字段，右侧填你在飞书多维表格里的真实字段名。建议字段类型使用文本或 URL，采集时间使用日期时间。</p>
        <div className="mapping-list">
          {fieldLabels.map(([key, label]) => (
            <label className="mapping-row" key={key}>
              <span>{label}</span>
              <span className="arrow">→</span>
              <input value={config.feishu.fieldMap[key] || ""} onChange={(event) => updateFieldMap(key, event.target.value)} />
            </label>
          ))}
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveConfig} disabled={saving}>
            <Save size={16} />
            保存映射
          </button>
          <button className="secondary-button" onClick={testFeishu}>
            <RefreshCw size={16} />
            检查字段
          </button>
        </div>
      </section>
    </div>
  );
}

function LogsPanel({ logs }) {
  return (
    <div className="logs-view">
      <div className="panel-title">
        <FileText size={18} />
        运行日志
      </div>
      <div className="log-table">
        {logs.map((entry) => (
          <div className="log-row" key={entry.id}>
            <span>{formatClock(entry.time)}</span>
            <span className={`log-level ${entry.level?.toLowerCase()}`}>{entry.level}</span>
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LogPreview({ logs, clearLogs, exportLogs }) {
  return (
    <section className="bottom-panel">
      <div className="bottom-title">
        <span>运行日志</span>
        <ChevronDown size={15} />
        <div className="bottom-actions">
          <button onClick={clearLogs}><Copy size={14} /> 清空</button>
          <button onClick={exportLogs}><FileDown size={14} /> 导出</button>
        </div>
      </div>
      <div className="log-preview">
        {logs.length === 0 ? (
          <div className="empty-mini">暂无日志</div>
        ) : (
          logs.slice(0, 9).map((entry) => (
            <div className="log-line" key={entry.id}>
              <span>{formatClock(entry.time)}</span>
              <span className={`log-level ${entry.level?.toLowerCase()}`}>{entry.level}</span>
              <span>{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ProductPreview({ products, refreshState }) {
  return (
    <section className="bottom-panel product-panel">
      <div className="bottom-title">
        <span>商品预览（最近采集）</span>
        <button className="icon-button small" onClick={refreshState} title="刷新预览"><RefreshCw size={15} /></button>
      </div>
      <table className="product-table">
        <thead>
          <tr>
            <th>商品标题</th>
            <th>销量</th>
            <th>价格</th>
            <th>商品链接</th>
          </tr>
        </thead>
        <tbody>
          {products.length === 0 ? (
            <tr><td className="empty-row" colSpan="4">暂无商品预览</td></tr>
          ) : (
            products.slice(0, 5).map((product) => (
              <tr key={product.url}>
                <td>{product.title}</td>
                <td>{product.sales}</td>
                <td>{product.price}</td>
                <td><a href={product.url} target="_blank" rel="noreferrer">{product.url}<ExternalLink size={13} /></a></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}

function HelpPanel({ onClose, onNavigate }) {
  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label="帮助">
      <section className="help-panel">
        <div className="help-header">
          <div>
            <h2>帮助</h2>
            <p>按顺序完成飞书连接、采集配置和写入检查。</p>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭帮助"><X size={18} /></button>
        </div>
        <div className="help-grid">
          <button onClick={() => onNavigate("connections")}>
            <Database size={18} />
            <span>配置飞书 Base、Table 和执行身份</span>
          </button>
          <button onClick={() => onNavigate("login")}>
            <LogIn size={18} />
            <span>手动打开浏览器查看页面，默认采集不使用登录态</span>
          </button>
          <button onClick={() => onNavigate("mapping")}>
            <Table2 size={18} />
            <span>检查字段映射，销量和价格建议为数字字段</span>
          </button>
          <button onClick={() => onNavigate("logs")}>
            <FileText size={18} />
            <span>查看运行日志和错误详情</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function ConnectionRows({ appState }) {
  const rows = [
    ["飞书连接", appState?.connections?.feishu],
    ["小红书手动浏览", appState?.connections?.xhs],
    ["浏览器状态", appState?.connections?.browser],
  ];
  return (
    <div className="connection-rows">
      {rows.map(([label, item]) => (
        <div className="connection-row" key={label}>
          <span>{label}</span>
          <StatusPill status={item?.status} text={item?.message || "未检查"} />
        </div>
      ))}
    </div>
  );
}

function writeModeLabel(mode) {
  const labels = { overwrite: "覆盖", skip: "跳过", append: "追加" };
  return labels[mode] || "覆盖";
}

function salesFilterLabel(salesFilter) {
  return salesFilter?.enabled ? `销量 > ${Number(salesFilter.minSales) || 0}` : "全部商品";
}

function writeModeDescription(mode) {
  const descriptions = {
    overwrite: "删除该博主旧记录后写入本次结果",
    skip: "如果该博主已有记录，本次不写入",
    append: "不删除旧记录，直接追加本次结果",
  };
  return descriptions[mode] || descriptions.overwrite;
}

function TextInput({ label, value, onChange, placeholder }) {
  return (
    <label className="text-input">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function SelectInput({ label, value, onChange, options }) {
  return (
    <label className="text-input">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  );
}

function ToggleInput({ label, checked, onChange, hint }) {
  return (
    <label className="toggle-row">
      <span>
        {label}
        <small>{hint}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function StatusPill({ label, status, text }) {
  return (
    <span className={`status-pill ${statusClass(status)}`}>
      <StatusDot status={status} />
      {label && <span>{label}：</span>}
      <b>{text}</b>
    </span>
  );
}

function StatusDot({ status }) {
  return <span className={`dot ${statusClass(status)}`} />;
}

function StatusBadge({ status }) {
  const labels = {
    queued: "等待中",
    running: "采集中",
    done: "完成",
    failed: "失败",
    stopped: "已停止",
  };
  const Icon = status === "done" ? CheckCircle2 : status === "failed" ? AlertTriangle : status === "running" ? Loader2 : null;
  return (
    <span className={`status-badge ${statusClass(status)}`}>
      {Icon && <Icon className={status === "running" ? "spin" : ""} size={14} />}
      {labels[status] || "未知"}
    </span>
  );
}

function WriteStatus({ task }) {
  if (task.status === "done") return <span className="write-status success"><CheckCircle2 size={14} /> 成功</span>;
  if (task.status === "failed") return <span className="write-status error"><AlertTriangle size={14} /> 失败</span>;
  if (task.status === "running" && /写入/.test(task.step)) return <span className="write-status running"><Loader2 className="spin" size={14} /> 写入中</span>;
  return <span className="muted">等待中</span>;
}

function statusText(item) {
  if (!item) return "未测试";
  return item.message || item.status || "未测试";
}

function statusClass(status = "") {
  if (["connected", "done", "success"].includes(status)) return "success";
  if (["running", "pending", "queued"].includes(status)) return "running";
  if (["error", "failed"].includes(status)) return "error";
  if (["stopped", "idle"].includes(status)) return "neutral";
  return "neutral";
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatClock(value) {
  if (!value) return "-";
  const date = new Date(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function duration(start, end) {
  if (!start) return "-";
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}
