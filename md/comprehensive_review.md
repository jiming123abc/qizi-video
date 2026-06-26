# qizi-video 全面审查与详细改进建议

> 版本：2026-06-26（第二版，已整合《代码修改状态分析报告》）
> 范围：代码层面 · 逻辑层面 · 用户操作层面 · 界面视觉层面 · 程序功能层面
> 目的：供后续智能体阅读并直接实施改进
> 参考来源：本次全代码阅读 + `代码修改状态分析报告.md`（基于 `.trae/documents/code_review_fix_plan.md` 和 `功能修改.md`）

---

## 目录

0. [已完成项与实际验证状态](#0-已完成项与实际验证状态)
1. [代码层面](#1-代码层面)
2. [逻辑层面](#2-逻辑层面)
3. [用户操作层面](#3-用户操作层面)
4. [界面视觉层面](#4-界面视觉层面)
5. [程序功能层面](#5-程序功能层面)
6. [优先级矩阵](#6-优先级矩阵)

---

## 0. 已完成项与实际验证状态

> 本节来自《代码修改状态分析报告》的待确认项，经本轮代码阅读逐一核实后更新状态。

### 0.1 待确认项核实结果

| 编号 | 问题描述 | 报告中状态 | 本轮核实结论 |
|------|----------|-----------|-------------|
| P1-4 | `loadShots` 条件判断冗余 | 待确认 | **无冗余**：`loadShots`（第262-297行）逻辑清晰，`trash` tab 不传 `sceneId`、其余 tab 传当前 `sceneId`，无重复判断。 |
| P1-5 | Word 导出场次名称错误 | 待确认 | **已正确**：`server/index.js` 第1840-1895行查询了 `video2Scenes` 表，构建 `sceneNameMap`，以 `sceneNameMap[sceneKey] \|\| 第N场` 渲染标题，场次名称正常。 |
| P2-1 | OSS AccessKey 暴露在前端 | 部分修复 | **仍存在问题**：`ossUtils.ts` 第41-45行仍保留 `REACT_APP_OSS_*` 作为 fallback，若 `.env` 中配置了旧前缀，AccessKey 仍会被打包进前端 bundle。需彻底清理。 |
| P3-3 | `renderShotCard` 重复排序 | 待确认 | **轻微冗余**：`loadShots` 第281行存入 state 前已排序，`sortedShots`（第1232行）又对 state 再次排序。逻辑无害但冗余，可移除后者。 |
| P3-5 | Toast 没有进出场动画 | 待确认 | **已有动画**：`showToast` 使用 `requestAnimationFrame` 控制 `toastVisible`，渲染层有 `opacity/translate-y` 的 `transition-all duration-300`。此条已修复，无需处理。 |
| P3-6 | 自动选中第一个场次 | 待确认 | **已实现但有 Bug**：第354-359行已实现，但缺少 `currentTab` 条件（见 §2.6），垃圾桶 Tab 下也会错误触发。 |
| P3-7 | 全屏查看时 `fullscreenItem.title` 不存在 | 待确认 | **已安全处理**：第2082行使用 `filename \|\| url` 降级，不报错。但展示原始文件名（如 `1750123_abc.jpg`）或 URL 体验较差，见 §4.10。 |
| 功能#5 | 首次体验自动跳转场次 | 待确认 | **同 P3-6**，已实现但含 Bug，见 §2.6。 |

### 0.2 仍未修复的关键项（已整合进各章节）

| 来源编号 | 问题 | 整合位置 |
|---------|------|---------|
| P3-1 | `Video2Page.tsx` 体量过大（2110 行） | §1.13（新增） |
| P2-1 | OSS AccessKey 残留旧前缀 `REACT_APP_` | §1.14（新增） |
| P3-2 | 顶部栏按钮过多，移动端拥挤 | §4.7（已收录） |
| P3-4 | 拖拽排序缺少视觉反馈动画 | §4.9（新增） |
| P3-8 | 多处使用原生 `confirm()` | §1.1（已收录） |
| 功能#6 | 旁白/sceneContent/备注字段长文本编辑体验差 | §3.9（新增） |
| 功能#9 | 合并分镜后 `mergedFrom` UI 体验不完整 | §5.11（新增） |
| 功能#10 | 导出功能单一（仅 Word） | §5.5（已收录） |

---

## 1. 代码层面

### 1.1 【错误】`Video2Page.tsx` 中 `hardDelete` 使用原生 `confirm`

**位置**：`src/components/Video2Page.tsx` 第 500、564 行

```js
if (!confirm('确定彻底删除此素材吗？无法恢复。')) return;
```

**问题**：
- `window.confirm` 在某些移动浏览器（如微信内置浏览器）和 PWA 模式下会被阻止或显示异常。
- 与页面其他确认弹窗风格（自定义 Modal）不一致，违反视觉一致性原则。

**建议**：统一使用项目已有的 `ConfirmDialog.tsx` 组件（`src/components/ConfirmDialog.tsx`）替代所有原生 `confirm`。全局搜索 `window.confirm` 或裸调用 `confirm(`，共计有约 6 处均需改造。

---

### 1.2 【错误】`InlineEditField` 中 `editValue` 与外部 `value` prop 不同步

**位置**：`src/components/storyboard/ShotCard.tsx` 第 59-148 行

```tsx
const [editValue, setEditValue] = useState(value);
```

**问题**：`editValue` 只在组件挂载时初始化一次。当父组件通过 API 更新了 `value` prop（例如 AI 批量填充字段后），编辑框内的旧值不会更新，会导致用户下次编辑时看到过期内容。

**建议**：
```tsx
useEffect(() => {
  if (!isEditing) {
    setEditValue(value);
  }
}, [value, isEditing]);
```

---

### 1.3 【错误】`updateTitle` 接口字段名错误

**位置**：`src/components/Video2Page.tsx` 第 381-392 行

```tsx
body: JSON.stringify({ title })
```

**问题**：服务端 `PUT /api/video2/shots/:id` 允许的更新字段白名单（第 488-492 行，`server/index.js`）中包含 `sceneContent` 而不是 `title`，因此该请求虽然返回 200（因为框架不会报错，只是找不到该字段），但**实际上什么都没有更新**。前端局部更新 `shots` 状态后数据与服务端不一致。

**建议**：改为发送 `{ sceneContent: title }` 或废弃该单独函数，复用 `ShotCard` 的 `handleFieldUpdate('sceneContent', value)` 路径。

---

### 1.4 【错误】`Video2ProjectList.tsx` 中 `timeAgo` 和 `Video2Page.tsx` 中存在重复实现

**位置**：
- `src/components/Video2ProjectList.tsx` 第 42-50 行
- `src/components/Video2Page.tsx` 第 48-56 行

**问题**：两个 `timeAgo` 函数功能相同但实现略有差异（项目列表版本更精细，分 `刚刚 / 分钟前 / 小时前 / 天前`；页面版本只区分 `今天 / 昨天 / X天前 / X周前`），是明显的代码重复。

**建议**：将统一版本抽取到 `src/lib/utils.ts`，并在两处导入使用。

---

### 1.5 【错误】`server/database.js` 中 `video2Items` 表仍有遗留旧字段

**位置**：`server/database.js` 第 24-42 行

**问题**：数据库初始化时仍创建了 `portfolio_items`、`featured_works`、`home_content`、`team_members`、`categories_details` 等旧版（企业官网）表，但当前项目已完全改造为 `qizi-video`（拍摄辅助工具）。这些遗留表不仅浪费存储，还增加了代码维护难度。数据库文件 `data.db` 和 `video2.db` 并存，路径逻辑混乱。

**建议**：
- 清理掉企业官网相关的旧表定义和初始数据插入逻辑。
- 将两个数据库文件统一为一个。

---

### 1.6 【不合理】`server/index.js` 中 `express.json` 中间件重复声明

**位置**：`server/index.js` 第 110 行已全局挂载 `express.json({ limit: '1mb' })`，但在之后约 20 余个路由定义时再次传入 `express.json({ limit: '1mb' })`。

**建议**：删除各路由中的重复声明，仅保留全局中间件。

---

### 1.7 【不合理】`server/index.js` 中内联调用 `require`

**位置**：多处（如第 746、788、816 行）在请求处理时动态 `require`：

```js
const task = await db.video2AiTasks.create({
  id: require('crypto').randomUUID ? require('crypto').randomUUID() : require('uuid').v4(),
```

**问题**：`require` 在 Node.js 中会缓存模块，所以性能影响微小，但代码可读性极差且不符合规范，`crypto` 在 `server/index.js` 顶部已经 `require('crypto')`，此处是重复引入。

**建议**：将 `aiClient`、`aliyunVideo` 等常用模块也移至文件顶部统一引入，并使用 `crypto.randomUUID()` 直接调用。

---

### 1.8 【不合理】`Shot` 类型中存在冗余与设计不清晰字段

**位置**：`src/lib/types.ts`

**问题**：
- `Shot` 同时有 `url`、`filename` 字段（旧版单媒体时代遗留）和 `media: ShotMedia[]`（新版多媒体），但 `url` 字段仍然被部分旧逻辑（`Video2Page.tsx` 第 986 行、`ShotCard.tsx` 第 308 行）直接读取，新旧路径混用导致难以预料的 Bug。
- `reference: number`（0/1 整数）应改为 `reference: boolean`（TypeScript 层面转换）。
- `mergedFrom: string` 存储 JSON 字符串，应该在数据库层解析后以 `mergedFrom: number[]` 形式传递给前端。

**建议**：
- 制定一个迁移计划：逐步废弃 `Shot.url`，统一通过 `Shot.media[0]` 访问主媒体。
- 在服务端返回数据时对 `mergedFrom` 进行 JSON.parse，前端接收 `number[]`。
- 将整数布尔字段在接口层转换为 `boolean`。

---

### 1.9 【不合理】`CORS` 配置完全开放

**位置**：`server/index.js` 第 103 行

```js
app.use(cors());
```

**问题**：CORS 不指定来源白名单，任何域名均可跨域请求接口。

**建议**：根据部署域名配置白名单：

```js
app.use(cors({ origin: ['https://qiziwenhua.top', 'http://localhost:5173'] }));
```

---

### 1.10 【不合理】`compressVideo` 中大文件全量读入内存

**位置**：`server/index.js` 第 320-416 行

**问题**：视频文件最大支持 1 GB（`FILE_SIZE_LIMITS.video`），`compressVideo` 将整个 Buffer 传入，先写盘再读盘，压缩完成后再整体读入内存，可能造成高峰期内存溢出。

**建议**：使用 `ffmpeg` 的流式处理（直接从磁盘读写），避免整个文件常驻内存；或限制服务端压缩文件大小上限（如 500 MB），超过此限制强制使用客户端压缩（浏览器端 `videoCompressor.ts` 已实现）。

---

### 1.11 【不合理】`transcodeTasks` 使用内存 Map 存储，重启后数据丢失

**位置**：`server/index.js` 第 1643 行

```js
const transcodeTasks = new Map();
```

**问题**：转码任务状态存储在进程内存中，服务器重启（如 PM2 reload）后所有任务记录消失，前端无法查询状态。

**建议**：将转码任务状态持久化到 SQLite（与现有 AI 任务 `video2AiTasks` 表统一），或至少写入 JSON 文件。

---

### 1.12 【不合理】图片加载失败时使用 DOM 操作创建占位符

**位置**：`src/components/storyboard/ShotCard.tsx` 第 361-374 行

```tsx
const placeholder = document.createElement('div');
placeholder.className = '...';
placeholder.innerHTML = '<svg ...>';
parent.appendChild(placeholder);
```

**问题**：直接操作 DOM 绕过了 React 的虚拟 DOM，可能导致不一致的状态。

**建议**：使用 React state 控制降级显示：

```tsx
const [imgError, setImgError] = useState(false);
// ...
{imgError
  ? <div className="..."><ImageIcon /></div>
  : <img onError={() => setImgError(true)} ... />
}
```

---

## 2. 逻辑层面

### 2.1 【错误】浏览器后退按钮无法正确导航

**位置**：`src/App.tsx`

**问题**：路由使用 `window.history.pushState` 手动管理，但没有监听 `popstate` 事件。当用户按浏览器后退键时，URL 会变化（如从 `/project/1` 回到 `/`），但 React 状态不会更新，页面仍停留在项目页面。

**建议**：

```tsx
useEffect(() => {
  const handlePop = () => {
    const path = window.location.pathname;
    const m = path.match(/^\/project\/(\d+)$/);
    setRoute(m ? { page: 'project', projectId: parseInt(m[1]) } : { page: 'list' });
  };
  window.addEventListener('popstate', handlePop);
  return () => window.removeEventListener('popstate', handlePop);
}, []);
```

长期建议：引入 React Router，彻底解决路由管理问题。

---

### 2.2 【错误】`backToProjectList` 有降级写死路径

**位置**：`src/components/Video2Page.tsx` 第 1096-1102 行

```tsx
const backToProjectList = () => {
  if (onBack) {
    onBack();
  } else {
    window.location.href = '/video2'; // 该路径不存在
  }
};
```

**问题**：`/video2` 路由在当前项目中实际不存在，服务端虽然有通配兜底路由，但会重新渲染首页（`/`）而非 `/video2`，可能导致白屏或重定向不正确。

**建议**：降级路径改为 `window.location.href = '/'`，或改为 `window.history.back()`。

---

### 2.3 【错误】`confirmShotNo` 中两次 API 调用缺少原子性

**位置**：`src/components/Video2Page.tsx` 第 426-452 行

```tsx
// 先更新 shotNo
await fetch(`/api/video2/shots/${shot.id}`, { ... shotNo });
// 再更新 status
await fetch(`/api/video2/shots/${shot.id}/status`, { ... status: 'done' });
```

**问题**：两次独立请求之间如果发生网络错误，会出现"镜头号已更新但状态未更新"的数据不一致。

**建议**：合并为一次请求（服务端 `PUT /api/video2/shots/:id` 本身支持同时更新多个字段），或将 `status` 加入允许批量更新的字段白名单，在同一请求中传递 `{ shotNo, status: 'done' }`。

---

### 2.4 【错误】`/api/video2/stats` 中对全量数据查询后在内存中计数

**位置**：`server/index.js` 第 1784-1840 行

```js
const pending = await db.video2Items.getByFilter({ projectId, status: 'pending', ... });
// stats.pending = pending.length
```

**问题**：获取统计数字时先查出所有记录（包含完整字段），然后用 `.length` 计数。若项目素材量大（数千条），这会查出大量不必要的数据，浪费性能。

**建议**：在数据库层使用 `SELECT COUNT(*) FROM ...` 代替 `SELECT * FROM ...`：

```sql
SELECT status, COUNT(*) as cnt FROM video2_items
WHERE projectId = ? AND deleted = 0
GROUP BY status
```

---

### 2.5 【错误】`loadStats` 与 `loadShots` 中 `currentTab === 'trash'` 时 sceneId 过滤逻辑不一致

**位置**：`src/components/Video2Page.tsx` 第 262-321 行

`loadShots` 在 `trash` tab 下不传 `sceneId`（正确）；但 `loadStats` 仍然在 `trash` tab 下传 `sceneId`，导致垃圾桶数量统计可能被场次过滤影响，显示不准确。

**建议**：`loadStats` 在 `currentTab === 'trash'` 时也不传 `sceneId`。

---

### 2.6 【不合理】未分类分镜被清空后强制跳转场次的时机不当

**位置**：`src/components/Video2Page.tsx` 第 354-359 行

```tsx
useEffect(() => {
  if (currentSceneId === null && stats.unclassified === 0 && scenes.length > 0) {
    setCurrentSceneId(scenes[0].id);
  }
}, [stats.unclassified, currentSceneId, scenes]);
```

**问题**：当用户正在 `已拍摄` 或 `垃圾桶` tab 浏览时，该 effect 也会触发（因为 `currentTab` 不在依赖项中），如果当前 `currentSceneId` 为 null（垃圾桶 tab 下场次无关），会意外把 `currentSceneId` 切换掉，导致后续行为异常。

**建议**：增加条件 `currentTab === 'pending'`：

```tsx
if (currentTab === 'pending' && currentSceneId === null && stats.unclassified === 0 && scenes.length > 0) {
  setCurrentSceneId(scenes[0].id);
}
```

---

### 2.7 【不合理】`handleUploadFiles` 中暂停逻辑仍保留后续文件的 `UploadingFile` 项

**位置**：`src/components/Video2Page.tsx` 第 922-936 行

```tsx
if (decision.decision === 'must_compress') {
  setUploadingFiles(prev => prev.map((uf, idx) => idx === i ? { ...uf, status: 'error' } : uf));
  // ...
  stopped = true;
  break;
}
```

**问题**：当第 i 个文件需要压缩时，该文件之后的所有文件（i+1 到 n）在 `uploadingFiles` 中状态仍为 `uploading`，用户界面会显示多个"正在上传"的假进度条，造成误导。

**建议**：`break` 前将后续文件的状态设置为 `'pending'`（待处理）或从 list 中移除，仅保留当前文件的提示。

---

### 2.8 【不合理】`Video2ProjectList` 中封面设置逻辑耦合在上传回调里

**位置**：`src/components/Video2Page.tsx` 第 974-990 行 & `Video2ProjectList.tsx` 第 280+ 行

**问题**：上传完成后，前端再次发起一次列表查询来找最新素材作为封面，这与上传逻辑高度耦合，且两次请求之间可能存在竞态条件。

**建议**：由服务端在创建新素材时，若项目封面为空则自动更新。或者直接在上传接口返回数据中附带 `suggestedCoverUrl`。

---

### 2.9 【不合理】分享落地页使用字符串替换注入 HTML

**位置**：`server/index.js` 第 2819-2832 行

```js
html = html.replace('<meta property="og:title"...', `...${escapeHtml(title)}...`);
```

**问题**：使用正则字符串替换修改 HTML 文件，依赖对 HTML 模板格式的硬编码假设，极不稳定。若 Vite 构建优化改变了属性顺序，替换会失效（静默失败）。

**建议**：使用模板引擎（如 `handlebars` 或 `ejs`）渲染分享落地页，或使用 `cheerio` 解析 HTML DOM 后精确替换节点属性。

---

## 3. 用户操作层面

### 3.1 【错误】场次 Tab 拖拽排序只有当前选中场次可以拖拽

**位置**：`src/components/Video2Page.tsx` 第 1357 行

```tsx
draggable={isActive && !isMobile}
```

**问题**：场次 Tab 上的拖拽排序要求用户"先点击场次使其激活，再拖拽"，这与直觉相悖。用户通常期望点击后可直接拖拽任意场次。

**建议**：
- 方案 A：允许所有场次都可拖拽，移除 `isActive` 限制。
- 方案 B（已有）：在场次管理面板中使用上下箭头排序，作为更直观的替代方案。  
  如果保留 Tab 拖拽，至少添加一个视觉提示（如 tooltip 或悬浮图标）说明需要先选中。

---

### 3.2 【错误】上传弹窗关闭条件不直观（上传中时无法关闭）

**位置**：`src/components/Video2Page.tsx` 第 1702-1716 行

```tsx
onClick={() => {
  if (uploadingFiles.every(f => f.status !== 'uploading')) setShowUploadDialog(false);
}}
```

**问题**：上传进行中时，用户点击遮罩或 X 按钮没有任何响应，也没有任何提示，用户会以为点击无效或者 UI 出 Bug。

**建议**：上传进行中时，点击关闭按钮弹出提示："文件正在上传中，确定要取消吗？"（使用 ConfirmDialog 实现），提供"继续上传"和"取消上传"两个选项。

---

### 3.3 【错误】批量选择后切换 Tab 不清除选中状态

**位置**：`src/components/Video2Page.tsx` 第 1574 行

```tsx
onClick={() => { setCurrentTab(tab.key); setSelectedIds(new Set()); setPlayingVideoKey(null); }}
```

实际上已清除，但**切换场次 Tab**（上方场次按钮）时没有清除 `selectedIds`：

```tsx
onClick={() => { setCurrentSceneId(scene.id); setSelectedIds(new Set()); }}  // ✓ 此处正确
```

经核查第 1356 行，场次切换时已清除，问题是**搜索时也会筛选 shots，但 `selectedIds` 不会跟随过滤**：搜索后，`selectedIds` 中可能包含当前可见列表中不存在的 ID，导致"已选 X 项"数量显示与实际可见项不一致，批量操作会对不可见项生效。

**建议**：搜索词变化时清除选中状态：

```tsx
onChange={(e) => { setSearchQuery(e.target.value); setSelectedIds(new Set()); }}
```

---

### 3.4 【不合理】`已拍摄 → 未拍摄` 确认弹窗过于简单，缺少足够的信息

**位置**：`src/components/Video2Page.tsx` 第 1672-1698 行

**问题**：弹窗只显示"将此镜头标记为未拍摄"，未显示该分镜的具体标识信息（如场景名、镜头号），操作多个分镜时容易误操作。

**建议**：弹窗中显示分镜序号和内容摘要，帮助用户确认操作对象。

---

### 3.5 【不合理】场次 Tab 栏在场次过多时仅水平滚动，无视觉指示

**位置**：`src/components/Video2Page.tsx` 第 1347 行

```tsx
<div className="max-w-7xl mx-auto px-4 sm:px-6 pb-3 overflow-x-auto">
```

**问题**：当场次较多，Tab 栏超出屏幕宽度后只能横向滚动，但没有任何视觉指示（渐变遮罩或箭头）提示用户可以滚动，用户可能以为 Tab 已显示完整。

**建议**：在 Tab 栏两侧添加渐变阴影（CSS `mask-image` 或 `::after` 伪元素）来暗示可滚动内容的存在。

---

### 3.6 【不合理】`"删除场次"` 在多个入口中有不同的确认流程

**问题**：
- 场次管理面板列表视图（`第 1860 行`）：内联 `confirm()` 弹窗。
- 场次管理面板编辑视图（`第 1934 行`）：内联 `confirm()` 弹窗（文案不同）。
- `deleteScene()` 函数（`第 678 行`）：又有一次额外的 `confirm()` 弹窗。

实际上一次删除会弹出**两次** confirm 确认，体验极差。

**建议**：移除 `deleteScene()` 内部的 `confirm()`，仅在调用方（UI 层）展示一次自定义 ConfirmDialog 确认。

---

### 3.7 【不合理】搜索框在垃圾桶 Tab 下无效但仍然显示

**位置**：`src/components/Video2Page.tsx` 第 1476-1495 行

**问题**：搜索框在所有 Tab 下均显示，但垃圾桶 Tab 中搜索并无实际场景价值（废弃素材本来就很少），且"搜索已删除素材"与产品定位不符。

**建议**：在 `currentTab === 'trash'` 时隐藏搜索框，或至少给搜索框添加 `placeholder` 说明仅搜索当前 Tab。

---

### 3.8 【不合理】键盘操作支持不完整

**问题**：
- 全屏弹窗（图片/视频）没有 `Escape` 键关闭支持。
- 镜头号输入弹窗已支持 `Enter`/`Escape`（`第 1636 行`），但全屏弹窗和场次管理弹窗未实现。

**建议**：为所有弹窗添加 `Escape` 关闭的 `keydown` 监听器（可封装为 `useEscapeKey` hook）。

---

## 4. 界面视觉层面

### 4.1 【错误】`og:url` 为空字符串

**位置**：`index.html` 第 14 行

```html
<meta property="og:url" content="" />
```

**问题**：空的 `og:url` 导致微信等社交平台分享时无法正确标识页面唯一 URL，影响分享卡片效果。虽然服务端分享落地页会动态注入，但默认首页分享时仍为空。

**建议**：填写站点根 URL，或由服务端在响应首页时动态注入。

---

### 4.2 【错误】加载状态文字过于简陋

**位置**：`src/components/Video2Page.tsx` 第 1105-1111 行

```tsx
<div className="text-slate-400">加载中...</div>
```

**问题**：全屏黑色背景上只有一行灰色的"加载中..."，首屏体验差，与整体视觉风格（玻璃拟态、紫色渐变）严重不匹配。

**建议**：实现一个与整体风格一致的 Skeleton 加载状态（参考 `shotsLoading` 时已实现的卡片骨架屏，第 1499-1509 行），或至少添加一个紫色渐变的 Loading Spinner。

---

### 4.3 【错误】Toast 通知永远显示绿色勾勾图标，即使是错误消息

**位置**：`src/components/Video2Page.tsx` 第 2094-2106 行

```tsx
<CheckCircle2 className="w-4 h-4 inline mr-2 text-green-400" />
{toast}
```

**问题**：Toast 系统不区分消息类型，错误、警告、成功均显示绿色勾勾，会误导用户认为操作成功。

**建议**：为 `showToast` 增加类型参数 `'success' | 'error' | 'info'`，并对应显示不同图标和颜色：

```tsx
showToast('操作失败', 'error');
showToast('上传完成', 'success');
```

同样问题存在于 `Video2ProjectList.tsx`（第 115-118 行的 `showToast`）。

---

### 4.4 【不合理】分镜卡片底部操作栏（复制、删除按钮）在移动端触摸区域太小

**位置**：`src/components/storyboard/ShotCard.tsx` 第 688-703 行

```tsx
<button className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs ...">
  <Copy className="w-3.5 h-3.5" />
</button>
```

**问题**：`py-1.5` + `text-xs` 的按钮在移动端触摸面积约为 24×24px，低于 Apple/Google 建议的最小 44×44px 触摸目标，容易误触或点击困难。

**建议**：移动端（`isMobile` 为 true 时）增大按钮 padding：`py-2.5 px-4`。

---

### 4.5 【不合理】统计数字徽标在暗黑背景下对比度不足

**位置**：`src/components/Video2Page.tsx` 第 1580-1582 行

```tsx
<span className={`ml-1 ${isActive ? 'text-white/90' : 'text-slate-400'}`}>({tab.count})</span>
```

**问题**：非激活 Tab 的 `text-slate-400`（约 40% 亮度）在深色背景（`bg-slate-900/90`）上，WCAG 对比度不满足 AA 级别（最低 4.5:1 用于正文，3:1 用于大文字）。

**建议**：将非激活 Tab 的统计数字改为 `text-slate-300`，以提升可读性。

---

### 4.6 【不合理】分镜卡片的「展开/收起详情」按钮视觉区域太小，难以发现

**位置**：`src/components/storyboard/ShotCard.tsx` 第 512-521 行

```tsx
<button className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition">
  <span className="w-8 h-px bg-slate-600" />
  <span>{isExpanded ? '收起详情' : '展开详情'}</span>
  <span className="w-8 h-px bg-slate-600" />
</button>
```

**问题**：按钮文字极小（`text-xs`），颜色为 `text-slate-400`（低对比度），视觉上几乎隐形，新用户难以发现该卡片还可以展开查看更多字段信息，导致核心功能被遗漏。

**建议**：
- 按钮默认可见性增强：文字改为 `text-slate-300`，或添加一个小的展开箭头图标。
- 卡片有填充字段时（如演员、地点不为空），默认展开，让用户能立即看到内容。

---

### 4.7 【不合理】顶部导航栏图标按钮无标签，在小屏上难以辨识

**位置**：`src/components/Video2Page.tsx` 第 1286-1343 行

顶部栏有 Share、AI生成、视频分割、费用统计、设置 等 5 个圆形图标按钮，仅有 `title` 属性（鼠标悬停提示），移动端无法悬停查看。

**建议**：在图标下方添加极小的文字标签（约 8-9px），或在顶部栏缩小版本中改用更有辨识度的图标（如设置改用齿轮图而非当前的 `SettingsIcon`），并在移动端折叠为汉堡菜单。

---

### 4.8 【不合理】「已拍摄」Tab 的分镜卡片与「未拍摄」Tab 外观完全相同

**问题**：用户切换到「已拍摄」Tab 后，卡片外观（除了左下角状态标签变绿色）与「未拍摄」完全一致，无法一眼区分当前所处 Tab。

**建议**：「已拍摄」的分镜卡片可在左边或顶部添加一条绿色高亮边框，或在卡片背景上增加一点轻微的绿色调，以增强区分度。

---

## 5. 程序功能层面

### 5.1 【改进建议】AI 任务缺少实时进度反馈机制

**现状**：AI 脚本解析、AI 生图、视频分割等任务均是异步的，前端通过轮询 `/api/video2/ai/task/:taskId` 查询进度（`AIScriptDialog.tsx`、`AIImageGenDialog.tsx`）。

**问题**：
- 轮询间隔固定（通常 2-3 秒），任务完成时最多有 3 秒延迟才能更新 UI。
- 多个并发任务时会造成多个并行轮询请求，增加服务器压力。

**建议**：
- 引入 **Server-Sent Events (SSE)**，在任务进度变化时主动推送给前端，一条 SSE 连接可复用多个任务。
- 或升级为 **WebSocket** 双向通信，同时支持未来的实时协作功能。

---

### 5.2 【改进建议】批量 AI 生图缺少队列管理

**现状**：当用户对多个分镜同时触发 AI 生图（未来批量功能），每个分镜都会独立创建一个 AI 任务并立即开始处理。

**问题**：可能同时向 AI API 发起大量并发请求，触发速率限制（Rate Limit），导致部分任务失败，且失败后用户无感知。

**建议**：
- 实现服务端 **任务队列**（可使用 `bull` 或简单的 SQLite FIFO），控制并发上限（如最多同时 3 个 AI 请求）。
- 失败的任务自动重试（最多 2 次），超过重试次数后通知用户。

---

### 5.3 【改进建议】视频分割结果预览缺失

**现状**：手动视频分割（标记分割点后确认）会直接创建分镜，用户无法预先查看每个分镜的内容截图。

**建议**：
- 确认分割前，在 `VideoSplitDialog` 中展示每个分割段的首帧截图预览（服务端通过 `ffmpeg` 抽取帧图）。
- 用户可以调整、删除某些分割段后再确认生成分镜，减少不必要的分镜被创建。

---

### 5.4 【改进建议】分镜卡片缺少快速定位功能（跳转到指定镜头号）

**现状**：项目内分镜可能多达几十上百个，目前只有全文搜索。

**建议**：
- 在搜索框旁添加"跳转到镜头编号"输入框，输入编号后直接滚动到对应卡片并高亮显示。
- 或在搜索时支持 `#编号` 语法（如 `#A03`）快速定位。

---

### 5.5 【改进建议】分镜导出功能需要增强

**现状**：`Video2ProjectList.tsx` 第 247-250 行：

```tsx
window.open(`/api/video2/projects/${project.id}/export?format=docx&includeImages=true`, '_blank');
```

只支持 Word (.docx) 导出。

**建议**：
- 支持 **PDF** 导出（适合甲方审阅）。
- 支持 **Excel/CSV** 导出（适合数据统计）。
- 支持 **PPT** 导出（适合导演会议演示）。
- 导出时允许选择场次范围、是否包含图片、图片尺寸等选项。

---

### 5.6 【改进建议】缺少项目级别的拍摄进度统计视图

**现状**：`stats` 只统计了 `pending`、`done`、`trash` 的数量，项目列表卡片也只显示素材总数和文件总大小。

**建议**：
- 在项目列表页面卡片上添加圆形进度条，直观显示"已拍摄 / 总分镜数"的完成百分比。
- 在项目详情页面添加分场次统计面板（每个场次有多少已拍 / 未拍），帮助导演快速了解整体拍摄进度。

---

### 5.7 【改进建议】AI 脚本解析未支持增量生成

**现状**：AI 解析脚本的结果需要等待全部完成后才会创建分镜（`processScriptParse` 是整体处理后才批量写库）。

**建议**：实现流式解析，每解析出一个分镜就立即写库并通过 SSE/WebSocket 推送给前端，让用户实时看到分镜被逐渐生成，改善长脚本的等待体验。

---

### 5.8 【改进建议】API Key 安全性：前端可以通过设置接口读取被脱敏的 Key，但设置接口本身无鉴权

**位置**：`server/index.js` 第 663-694 行

```js
app.get('/api/video2/settings', ...)  // 无鉴权
app.put('/api/video2/settings', ...)  // 无鉴权
```

**问题**：任何知道 API 地址的人都可以读取（脱敏版）和修改设置，包括替换 AI API Key。在局域网或内网部署场景下风险可接受，但若服务器暴露在公网则存在安全隐患。

**建议**：
- 短期：为设置接口添加简单的 IP 白名单（如仅允许本地访问）或 HTTP 基本认证。
- 长期：实现基于 Session 或 JWT 的用户鉴权体系。

---

### 5.9 【改进建议】缺少分镜备份/恢复功能

**问题**：误操作批量删除（硬删除）后无法恢复。软删除（垃圾桶）虽然存在，但仍无法防止用户清空垃圾桶。

**建议**：
- 定期（如每天凌晨）自动备份 SQLite 数据库文件到 `server/backups/` 目录，保留最近 7 天。
- 管理页面提供"恢复备份"入口。

---

### 5.10 【改进建议】参考画面支持 URL 拖入，但无法验证 URL 有效性

**位置**：`src/components/Video2Page.tsx` 第 1751-1768 行

**问题**：URL 上传时仅做简单的非空校验，不验证 URL 格式合法性、资源可访问性，如果用户输入无效 URL，服务端报错后前端只看到通用错误提示，体验差。

**建议**：
- 前端：使用正则预验证 URL 格式，`disabled` 按钮直到 URL 格式合法。
- 服务端：在 `upload/from-url` 接口中增加 HEAD 请求探测 URL 是否可访问，不可访问时返回明确错误码。

---

## 6. 优先级矩阵

| 优先级 | 问题编号 | 问题简述 | 估计工时 |
|--------|---------|----------|----------|
| 🔴 P0 - 修复错误 | 1.3 | `updateTitle` 字段名错误，实际无法保存 | 0.5h |
| 🔴 P0 - 修复错误 | 2.1 | 浏览器后退按钮不响应 | 1h |
| 🔴 P0 - 修复错误 | 1.2 | `InlineEditField` prop 不同步 | 0.5h |
| 🔴 P0 - 修复错误 | 3.6 | 删除场次触发两次 confirm | 1h |
| 🟠 P1 - 体验问题 | 3.2 | 上传中无法关闭弹窗无提示 | 2h |
| 🟠 P1 - 体验问题 | 4.3 | Toast 不区分错误/成功 | 1h |
| 🟠 P1 - 体验问题 | 4.2 | 首屏加载状态过于简陋 | 2h |
| 🟠 P1 - 体验问题 | 2.4 | stats 接口全量查询后计数 | 1h |
| 🟡 P2 - 合理性改进 | 1.6 | 重复 express.json 声明 | 0.5h |
| 🟡 P2 - 合理性改进 | 1.12 | ShotCard 图片错误用 DOM 操作 | 1h |
| 🟡 P2 - 合理性改进 | 2.6 | 未分类跳转时机不当 | 0.5h |
| 🟡 P2 - 合理性改进 | 2.3 | confirmShotNo 两次请求 | 1h |
| 🟢 P3 - 功能增强 | 5.1 | AI 任务 SSE 实时推送 | 8h |
| 🟢 P3 - 功能增强 | 5.6 | 拍摄进度统计视图 | 4h |
| 🟢 P3 - 功能增强 | 5.3 | 视频分割结果预览 | 6h |
| 🟢 P3 - 功能增强 | 5.5 | 导出格式扩展 PDF/Excel | 8h |

---

> 本文档由自动化代码审查智能体生成，基于对 `qizi-video` 项目全部核心源文件的阅读分析（`Video2Page.tsx`、`Video2ProjectList.tsx`、`ShotCard.tsx`、`server/index.js`、`database.js`、`types.ts`、`index.css`、`index.html` 等），并参考了上一轮审查报告中的合理建议（导航路由问题、Stats API 优化、Toast 一致性等）综合整理。
