# 全面审查修复实施计划

> 基于 `comprehensive_review.md`（2026-06-26 第二版）制定
> 范围：代码层面 · 逻辑层面 · 用户操作层面 · 界面视觉层面 · 程序功能层面

---

## 进度概览

| 批次 | 状态 | 完成项 |
|------|------|--------|
| P0（7项） | ✅ 全部完成 | P0-1 ~ P0-7 |
| P1（6项） | ✅ 全部完成 | P1-1 ~ P1-6 |
| P2（12项） | ✅ 全部完成 | P2-1 ~ P2-12 |
| P3（14项） | ✅ 基本完成 | P3-2 ~ P3-14（P3-1 架构重构进行中） |
| 功能增强 | ⏳ 待规划 | - |

---

## 一、总体策略

### 1.1 优先级定义

| 优先级 | 符号 | 说明 |
|--------|------|------|
| P0 | 🔴 | 功能性错误，必须立即修复 |
| P1 | 🟠 | 严重体验问题，优先修复 |
| P2 | 🟡 | 合理性改进，计划修复 |
| P3 | 🟢 | 功能增强，择机实现 |

### 1.2 实施批次

| 批次 | 包含优先级 | 预计总量 |
|------|-----------|----------|
| 第一批 | P0 全部 | 约 7-8 项 |
| 第二批 | P1 全部 | 约 6-7 项 |
| 第三批 | P2 全部 | 约 12-15 项 |
| 第四批 | P3 全部 | 约 8-10 项 |

---

## 二、第一批：P0 功能性错误修复

### P0-1：`updateTitle` 接口字段名错误（§1.3）

**状态**：✅ 已完成

**问题**：前端 `updateTitle` 发送 `{ title }`，但服务端白名单字段是 `sceneContent`，导致实际无法保存。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 381-392 行）

**修改方案**：
- 将 `body: JSON.stringify({ title })` 改为 `body: JSON.stringify({ sceneContent: title })`
- 同时验证前端局部更新 state 的逻辑是否正确对应字段名

**验证方法**：修改分镜标题后刷新页面，确认标题已保存。

---

### P0-2：浏览器后退按钮不响应（§2.1）

**问题**：路由使用 `window.history.pushState` 手动管理，但未监听 `popstate` 事件，按浏览器后退键时 URL 变化但页面不更新。

**涉及文件**：
- `src/App.tsx`

**修改方案**：
- 在 `App` 组件中添加 `useEffect` 监听 `popstate` 事件
- 根据当前路径解析并更新 `route` 状态
- 支持路径：`/`（项目列表）、`/project/:id`（项目详情）

**验证方法**：进入项目后点击浏览器后退按钮，确认正确返回列表页。

---

### P0-3：`InlineEditField` 的 `editValue` 与外部 `value` 不同步（§1.2）

**问题**：`editValue` 只在组件挂载时初始化一次，父组件通过 API 更新 `value` prop 后，编辑框内仍显示旧值。

**涉及文件**：
- `src/components/storyboard/ShotCard.tsx`（第 59-148 行）

**修改方案**：
- 添加 `useEffect`，当 `value` 变化且当前未处于编辑状态时，同步更新 `editValue`
- 依赖项：`[value, isEditing]`

**验证方法**：使用 AI 批量填充字段后，点击编辑确认显示的是新值而非旧值。

---

### P0-4：删除场次触发两次 confirm（§3.6）

**问题**：场次管理面板中删除场次时，`deleteScene()` 函数内部已有一次 `confirm()`，调用方（列表视图和编辑视图）又各有一次 `confirm()`，导致一次删除弹出两次确认框。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 678 行 deleteScene 函数、第 1860 行列表视图、第 1934 行编辑视图）

**修改方案**：
- 移除 `deleteScene()` 函数内部的 `confirm()` 调用
- 将 UI 层的原生 `confirm()` 替换为自定义 `ConfirmDialog`（见 P0-5）
- 确保删除操作只触发一次确认

**验证方法**：在场次管理中删除场次，确认只弹出一次确认对话框。

---

### P0-5：原生 `confirm()` 替换为自定义 ConfirmDialog（§1.1 + §3.6）

**问题**：多处使用原生 `window.confirm`，在移动浏览器/PWA 模式下可能被阻止，且与整体视觉风格不一致。

**涉及文件**：
- `src/components/Video2Page.tsx`（约 6 处：第 500、564 行 hardDelete，场次删除等）
- `src/components/Video2ProjectList.tsx`（删除项目等）
- `src/components/ConfirmDialog.tsx`（现有组件，需确认可用性）

**修改方案**：
- 全局搜索所有 `confirm(` 调用
- 为需要确认的操作创建对应的 dialog 状态变量
- 使用 `ConfirmDialog` 组件替代原生 `confirm`
- 涉及操作：彻底删除素材、删除场次、删除项目、取消上传等

**验证方法**：触发所有确认操作，确认显示自定义弹窗且功能正常。

---

### P0-6：`backToProjectList` 降级路径错误（§2.2）

**问题**：`backToProjectList` 的降级路径写死为 `/video2`，该路径不存在，可能导致白屏。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 1096-1102 行）

**修改方案**：
- 将降级路径改为 `window.location.href = '/'`
- 或改为 `window.history.back()`（更符合用户预期）

**验证方法**：在无 `onBack` prop 的情况下测试返回按钮。

---

### P0-7：`loadStats` 在 trash tab 下错误传递 sceneId（§2.5）

**问题**：`loadShots` 在 trash tab 下不传 `sceneId`（正确），但 `loadStats` 仍然传 `sceneId`，导致垃圾桶统计数量不准确。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 262-321 行附近）

**修改方案**：
- 参照 `loadShots` 的逻辑，在 `currentTab === 'trash'` 时不传 `sceneId` 参数

**验证方法**：在垃圾桶 tab 下查看统计数字是否正确。

---

## 三、第二批：P1 体验问题修复

### P1-1：上传中无法关闭弹窗无提示（§3.2）

**问题**：上传进行中时点击遮罩或 X 按钮无任何响应，用户以为 UI 出 Bug。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 1702-1716 行）

**修改方案**：
- 上传进行中时，点击关闭按钮弹出确认提示："文件正在上传中，确定要取消吗？"
- 使用 `ConfirmDialog` 实现
- 提供"继续上传"和"取消上传"两个选项
- 取消上传时：终止正在进行的上传请求，清理 `uploadingFiles` 状态

**验证方法**：开始上传后点击关闭按钮，确认弹出确认框，取消后上传停止。

---

### P1-2：Toast 不区分错误/成功类型（§4.3）

**问题**：所有 Toast 都显示绿色勾勾图标，错误消息也显示成功图标，误导用户。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 2094-2106 行）
- `src/components/Video2ProjectList.tsx`（第 115-118 行）

**修改方案**：
- 为 `showToast` 增加类型参数：`showToast(message, type?: 'success' | 'error' | 'info')`
- 默认类型为 `'success'`
- 根据类型显示不同图标和颜色：
  - success：绿色 + CheckCircle2
  - error：红色 + XCircle
  - info：蓝色 + Info
- 全局搜索所有 `showToast` 调用，为错误场景添加 `'error'` 类型

**验证方法**：触发错误操作（如上传失败），确认显示红色错误图标。

---

### P1-3：首屏加载状态过于简陋（§4.2）

**问题**：全屏黑色背景上只有灰色"加载中..."文字，与整体视觉风格（玻璃拟态、紫色渐变）严重不匹配。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 1105-1111 行）

**修改方案**：
- 实现与整体风格一致的加载状态
- 添加紫色渐变的 Loading Spinner
- 添加项目名称标题
- 参考 `shotsLoading` 时的卡片骨架屏风格

**验证方法**：刷新项目页面，观察加载动画。

---

### P1-4：stats 接口全量查询后计数（§2.4）

**问题**：`/api/video2/stats` 先查出所有记录（含完整字段）再用 `.length` 计数，数据量大时性能差。

**涉及文件**：
- `server/index.js`（第 1784-1840 行）
- `server/database.js`（需添加新的统计查询方法）

**修改方案**：
- 在 `database.js` 中添加 `video2Items.getStats(projectId)` 方法
- 使用 `SELECT status, COUNT(*) as cnt FROM video2_items WHERE projectId = ? AND deleted = 0 GROUP BY status`
- 同样优化场次相关的统计查询
- 前端调用方式不变

**验证方法**：检查 stats 接口响应时间和返回数据正确性。

---

### P1-5：场次 Tab 拖拽只有选中场次可以拖（§3.1）

**问题**：场次 Tab 拖拽要求"先点击选中再拖拽"，与直觉相悖。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 1357 行）

**修改方案**：
- 移除 `isActive` 限制，允许所有场次 Tab 都可拖拽
- `draggable={!isMobile}`
- 确保拖拽时不会误触发点击选中（在拖拽开始时设置标志位）

**验证方法**：直接拖拽未选中的场次 Tab，确认排序成功。

---

### P1-6：搜索时 selectedIds 不跟随过滤（§3.3）

**问题**：搜索后 `selectedIds` 中可能包含当前不可见的 ID，导致"已选 X 项"数量与实际可见项不一致。

**涉及文件**：
- `src/components/Video2Page.tsx`（搜索框 onChange 处）

**修改方案**：
- 搜索词变化时清除选中状态：`setSelectedIds(new Set())`
- 同时清除播放状态：`setPlayingVideoKey(null)`

**验证方法**：先选中几个分镜，再输入搜索词，确认已选数量清零。

---

## 四、第三批：P2 合理性改进

### P2-1：重复 `express.json` 声明（§1.6）

**问题**：全局已挂载 `express.json`，但约 20 余个路由又重复传入。

**涉及文件**：
- `server/index.js`（多处路由定义）

**修改方案**：
- 删除各路由中的 `express.json({ limit: '1mb' })` 重复声明
- 仅保留第 110 行的全局中间件
- 注意：如果某些路由需要不同的 limit，则保留差异化的声明

**验证方法**：启动服务，测试各 POST/PUT 接口正常解析 JSON。

---

### P2-2：ShotCard 图片错误用 DOM 操作（§1.12）

**问题**：图片加载失败时直接操作 DOM 创建占位符，绕过 React 虚拟 DOM。

**涉及文件**：
- `src/components/storyboard/ShotCard.tsx`（第 361-374 行）

**修改方案**：
- 使用 React state 控制降级显示：`const [imgError, setImgError] = useState(false)`
- 条件渲染：`imgError ? <占位符组件> : <img onError={() => setImgError(true)} ... />`
- 移除所有 `document.createElement`、`appendChild` 等 DOM 操作

**验证方法**：故意使用无效图片 URL，确认显示占位符且无 DOM 操作。

---

### P2-3：未分类跳转时机不当（§2.6 + P3-6 + 功能#5）

**问题**：自动跳转场次的 effect 缺少 `currentTab` 条件，垃圾桶 tab 下也会错误触发。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 354-359 行）

**修改方案**：
- 增加条件 `currentTab === 'pending'`
- 完整条件：`if (currentTab === 'pending' && currentSceneId === null && stats.unclassified === 0 && scenes.length > 0)`

**验证方法**：在垃圾桶 tab 下清空未分类分镜，确认不会意外跳转到场次。

---

### P2-4：`confirmShotNo` 两次请求缺少原子性（§2.3）

**问题**：确认镜头号时分别发送更新 shotNo 和更新 status 两个请求，中间出错会导致数据不一致。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 426-452 行）
- `server/index.js`（PUT /api/video2/shots/:id 白名单）

**修改方案**：
- 合并为一次请求，在 body 中同时传递 `shotNo` 和 `status: 'done'`
- 确认服务端 `PUT /api/video2/shots/:id` 的字段白名单已包含 `status`
- 如未包含，需在服务端添加 `status` 到白名单

**验证方法**：确认镜头号后刷新，验证 shotNo 和 status 都已更新。

---

### P2-5：内联调用 `require`（§1.7）

**问题**：多处请求处理时动态 `require` 模块，代码可读性差且不符合规范。

**涉及文件**：
- `server/index.js`（第 746、788、816 行等多处）

**修改方案**：
- 将 `crypto`、`uuid`、`aiClient`、`aliyunVideo` 等常用模块移至文件顶部统一引入
- 使用顶部引入的变量直接调用
- 注意：保留延迟加载的合理场景（如非常用大模块）

**验证方法**：代码检查无内联 require，服务启动正常。

---

### P2-6：`timeAgo` 函数重复实现（§1.4）

**问题**：`Video2ProjectList.tsx` 和 `Video2Page.tsx` 各有一个 `timeAgo` 函数，功能相同但实现略有差异。

**涉及文件**：
- `src/components/Video2ProjectList.tsx`（第 42-50 行）
- `src/components/Video2Page.tsx`（第 48-56 行）
- `src/lib/utils.ts`（需新建或确认已有）

**修改方案**：
- 抽取统一版本到 `src/lib/utils.ts`
- 采用更精细的版本（项目列表版本：刚刚/分钟前/小时前/天前）
- 在两个组件中导入使用

**验证方法**：检查时间显示正常，代码无重复。

---

### P2-7：CORS 配置完全开放（§1.9）

**问题**：`cors()` 不指定来源白名单，任何域名均可跨域请求。

**涉及文件**：
- `server/index.js`（第 103 行）

**修改方案**：
- 配置来源白名单：从环境变量读取 `ALLOWED_ORIGINS`
- 默认包含 `http://localhost:3000`、`http://localhost:3002`、`http://localhost:5173` 等开发地址
- 生产环境从环境变量配置正式域名

**验证方法**：测试跨域请求正常，非白名单域名被拒绝。

---

### P2-8：`handleUploadFiles` 暂停逻辑后续文件状态错误（§2.7）

**问题**：当第 i 个文件需要压缩时，后续文件状态仍为 `uploading`，显示假进度条。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 922-936 行）

**修改方案**：
- `break` 前将后续文件的状态设置为 `'pending'` 或从列表中移除
- 仅保留当前文件的错误/压缩提示状态

**验证方法**：上传多个文件，触发压缩中断，确认后续文件状态正确。

---

### P2-9：已拍摄/未拍摄 Tab 卡片外观区分度不足（§4.8）

**问题**：两个 Tab 的卡片外观几乎相同，只有左下角标签变化，无法一眼区分。

**涉及文件**：
- `src/components/storyboard/ShotCard.tsx`

**修改方案**：
- 「已拍摄」的卡片在左侧添加一条绿色高亮边框（`border-l-4 border-green-500`）
- 或在卡片背景增加轻微绿色调（`bg-green-900/10`）
- 通过 prop 控制不同状态的样式

**验证方法**：切换已拍摄/未拍摄 Tab，视觉上有明显区分。

---

### P2-10：展开/收起详情按钮难以发现（§4.6）

**问题**：按钮文字极小且颜色暗淡，新用户难以发现卡片可展开。

**涉及文件**：
- `src/components/storyboard/ShotCard.tsx`（第 512-521 行）

**修改方案**：
- 按钮文字颜色改为 `text-slate-300`
- 添加 ChevronDown/ChevronUp 图标
- 当卡片有填充字段（演员、地点等不为空）时默认展开

**验证方法**：卡片有内容时默认展开，收起状态下按钮清晰可见。

---

### P2-11：统计数字徽标对比度不足（§4.5）

**问题**：非激活 Tab 的 `text-slate-400` 在深色背景上对比度不满足 WCAG AA。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 1580-1582 行）

**修改方案**：
- 将非激活 Tab 的统计数字改为 `text-slate-300`
- 确保对比度 ≥ 4.5:1

**验证方法**：视觉检查文字清晰度。

---

### P2-12：移动端按钮触摸区域太小（§4.4）

**问题**：卡片底部操作按钮触摸面积约 24×24px，低于 44×44px 建议值。

**涉及文件**：
- `src/components/storyboard/ShotCard.tsx`（第 688-703 行）

**修改方案**：
- 移动端（`isMobile` 为 true）增大按钮 padding
- 使用 `py-2.5 px-4` 替代 `py-1.5 px-2.5`
- 确保最小触摸目标 44×44px

**验证方法**：在移动设备上测试按钮点击。

---

## 五、第四批：P3 功能增强与架构改进

### P3-1：Video2Page.tsx 体量过大（2110 行）（§1.13）

**状态**：⏳ 进行中（已起步）

**问题**：单文件 2110 行，维护困难。

**涉及文件**：
- `src/components/Video2Page.tsx`

**修改方案**（渐进式拆分）：
1. 提取 hooks：`useShots`、`useScenes`、`useUpload`、`useToast` 等
   - ✅ `useToast` 已提取到 `src/hooks/useToast.ts`
2. 提取子组件：顶部栏、场次 Tab 栏、搜索栏、上传弹窗、场次管理弹窗、全屏查看器等
3. 提取工具函数到 `src/lib/`
4. 目标：主文件控制在 500 行以内

**注意**：此为架构重构，需谨慎实施，确保每一步都可验证。

---

### P3-2：OSS AccessKey 残留旧前缀（§1.14 + P2-1）

**状态**：✅ 已完成

**问题**：`ossUtils.ts` 仍保留 `REACT_APP_OSS_*` 作为 fallback，若配置了旧前缀会暴露 AccessKey。

**涉及文件**：
- `server/aliyunVideo.js`（第 10-17 行，228-231 行）

**修改方案**：
- 更新 `getAliyunCredentials()` 和 `getOSSConfig()` 函数
- 移除 `REACT_APP_` 前缀，使用 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET`、`OSS_REGION`
- 添加 `_DEV` 后缀作为开发环境 fallback

**验证方法**：代码搜索无 REACT_APP_OSS 引用。

---

### P3-3：拖拽排序缺少视觉反馈动画（§4.9 + P3-4）

**状态**：✅ 已完成

**问题**：拖拽时只有位置变化，无平滑动画和视觉指示。

**涉及文件**：
- `src/components/Video2Page.tsx`（场次 Tab 拖拽）
- `src/components/storyboard/ShotCard.tsx`（分镜卡片拖拽）

**修改方案**：
- 拖拽时被拖拽元素降低透明度 + 轻微缩放
- 拖拽目标位置显示高亮边框
- 添加放置位置指示线（紫色渐变）
- 拖拽完成后的平滑过渡动画

---

### P3-4：长文本编辑体验差（§3.9 + 功能#6）

**状态**：✅ 已完成

**问题**：旁白/sceneContent/备注等长文本字段在卡片内编辑空间有限。

**涉及文件**：
- `src/components/storyboard/ShotCard.tsx`

**修改方案**：
- 为多行字段添加"展开编辑"按钮
- 点击后弹出更大的编辑弹窗（全屏弹窗）
- 支持键盘快捷键（Ctrl/Cmd+Enter 保存，Esc 取消）
- 长文本自动截断显示（3行），显示展开图标

---

### P3-5：合并分镜后 `mergedFrom` UI 体验不完整（§5.11 + 功能#9）

**状态**：✅ 已完成（UI 增强部分）

**问题**：合并分镜后用户无法直观看到哪些分镜被合并了。

**涉及文件**：
- `src/components/storyboard/ShotCard.tsx`

**修改方案**：
- 在卡片上显示"由 N 个分镜合并"的标识
- 点击"详情"可展开查看被合并的分镜 ID 列表
- 支持展开/收起切换
- 撤销合并操作需服务端配合，待后续实现

---

### P3-6：键盘操作支持不完整（§3.8）

**状态**：✅ 已完成

**问题**：全屏弹窗无 Escape 键关闭支持。

**涉及文件**：
- `src/hooks/useEscapeKey.ts`（新建）
- `src/components/Video2Page.tsx`（全屏弹窗）
- `src/components/settings/SettingsDialog.tsx`
- `src/components/ai/AIScriptDialog.tsx`
- `src/components/ai/AIImageGenDialog.tsx`
- `src/components/ai/AIUsagePanel.tsx`
- `src/components/storyboard/MediaManagerDialog.tsx`

**修改方案**：
- 封装 `useEscapeKey` hook
- 为所有 Modal/Dialog 添加 Escape 关闭支持
- 镜头号输入弹窗的 Enter/Escape 已支持，复用此模式

---

### P3-7：场次 Tab 滚动无视觉指示（§3.5）

**问题**：场次较多时 Tab 栏横向滚动，但无视觉提示用户可以滚动。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 1347 行）

**修改方案**：
- 在 Tab 栏两侧添加渐变阴影遮罩（CSS `mask-image` 或伪元素）
- 暗示可滚动内容的存在

---

### P3-8：搜索框在垃圾桶 Tab 下无效仍显示（§3.7）

**问题**：垃圾桶 Tab 下搜索无实际价值但仍显示搜索框。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 1476-1495 行）

**修改方案**：
- `currentTab === 'trash'` 时隐藏搜索框
- 或修改 placeholder 为"搜索已删除素材..."（如果实现了垃圾桶搜索功能）

---

### P3-9：顶部栏图标按钮无标签（§4.7 + P3-2）

**问题**：顶部栏 5 个圆形图标按钮在移动端无法辨识。

**涉及文件**：
- `src/components/Video2Page.tsx`（第 1286-1343 行）

**修改方案**：
- 方案 A：在图标下方添加极小文字标签（8-9px）
- 方案 B：移动端折叠为汉堡菜单，展开后显示带文字的列表
- 推荐方案 B，更符合移动端 UX 规范

---

### P3-10：`og:url` 为空字符串（§4.1）

**问题**：`index.html` 中 `og:url` 内容为空，影响社交分享。

**涉及文件**：
- `index.html`（第 14 行）

**修改方案**：
- 填写站点根 URL（可从环境变量注入）
- 或由服务端在响应首页时动态注入

---

### P3-11：数据库遗留旧表清理（§1.5）

**状态**：✅ 已完成

**问题**：`video2Items` 表定义中仍有企业官网时代的旧表，且有两个数据库文件。

**涉及文件**：
- `server/database.js`（第 160-162 行，第 1786-1803 行）

**修改方案**：
- 清理 `insertInitialData()` 中企业官网旧表的初始数据插入逻辑
- 从 `module.exports` 中移除旧表模块（`portfolioItems`、`featuredWorks`、`homeContent`、`teamMembers`、`categoriesDetails`）
- 保留表定义（向后兼容现有数据文件）

---

### P3-12：转码任务状态持久化（§1.11）

**状态**：✅ 已完成

**问题**：`transcodeTasks` 使用内存 Map，重启后数据丢失。

**涉及文件**：
- `server/index.js`（第 1662-1797 行）
- `server/database.js`（第 820-839 行，第 1859-1929 行）

**修改方案**：
- 新建 `transcode_tasks` 表
- 任务创建、更新、查询都走数据库
- 与 `video2AiTasks` 表设计保持一致

---

### P3-13：视频压缩流式处理（§1.10）

**状态**：✅ 已完成

**问题**：`compressVideo` 将整个文件读入内存，大文件可能内存溢出。

**涉及文件**：
- `server/index.js`（第 295-328 行，第 428-518 行，第 2598-2657 行）

**修改方案**：
- 新增 `compressVideoFile()` 函数，使用文件路径而非 Buffer 进行压缩
- 改造 `getVideoBitrate()` 函数，直接接收文件路径而非 Buffer
- 视频上传流程改为文件路径传递，不将整个文件读入内存
- OSS 上传使用 `ossClient.put(ossKey, filePath)` 直接传文件路径

---

### P3-14：`Shot` 类型冗余字段清理（§1.8）

**问题**：`Shot` 同时有旧版 `url/filename` 和新版 `media[]`，新旧路径混用。

**涉及文件**：
- `src/lib/types.ts`
- `src/components/Video2Page.tsx`
- `src/components/storyboard/ShotCard.tsx`
- `server/index.js`

**修改方案**（渐进式迁移）：
1. 第一步：在服务端解析 `mergedFrom` JSON 字符串，前端接收 `number[]`
2. 第二步：将 `reference: number` 改为 `reference: boolean`
3. 第三步：逐步废弃 `Shot.url`，统一通过 `Shot.media[0]` 访问主媒体

---

## 六、第五批：功能增强（长线规划）

> 以下为较大的功能增强项，建议单独制定规格文档后实施。

### 5.1 AI 任务 SSE 实时推送（§5.1）
- 引入 Server-Sent Events，替代轮询
- 一条连接复用多个任务
- 任务进度变化时主动推送

### 5.2 批量 AI 生图队列管理（§5.2）
- 服务端任务队列，控制并发上限
- 失败自动重试（最多 2 次）
- 超出重试次数通知用户

### 5.3 视频分割结果预览（§5.3）
- 分割前展示每段首帧截图
- 支持调整、删除分割段
- 减少不必要的分镜创建

### 5.4 分镜快速定位功能（§5.4）
- 跳转到指定镜头号
- 搜索支持 `#编号` 语法
- 滚动到对应卡片并高亮

### 5.5 导出格式扩展（§5.5 + 功能#10）
- PDF 导出（适合甲方审阅）
- Excel/CSV 导出（适合数据统计）
- PPT 导出（适合导演会议）
- 导出选项：场次范围、是否含图片、图片尺寸

### 5.6 拍摄进度统计视图（§5.6）
- 项目列表卡片添加圆形进度条
- 项目详情页分场次统计面板
- 已拍/未拍/总数可视化

### 5.7 AI 脚本增量生成（§5.7）
- 流式解析，每解析一个分镜立即写库
- 通过 SSE/WebSocket 推送给前端
- 改善长脚本等待体验

### 5.8 API Key 安全性（§5.8）
- 设置接口添加 IP 白名单或 HTTP 基本认证
- 长期：实现 Session/JWT 鉴权体系

### 5.9 分镜备份/恢复功能（§5.9）
- 定期自动备份 SQLite 数据库
- 保留最近 7 天备份
- 管理页面提供恢复入口

### 5.10 参考图 URL 有效性验证（§5.10）
- 前端正则预验证 URL 格式
- 服务端 HEAD 请求探测可访问性
- 不可访问时返回明确错误码

---

## 七、实施顺序建议

### 第一阶段（P0）：立即修复
预计耗时：约 4-6 小时
1. P0-1: updateTitle 字段名错误
2. P0-2: 浏览器后退按钮
3. P0-3: InlineEditField 不同步
4. P0-4/P0-5: 删除场次两次 confirm + 统一替换 ConfirmDialog
5. P0-6: backToProjectList 路径错误
6. P0-7: loadStats trash tab sceneId 问题

### 第二阶段（P1）：优先修复
预计耗时：约 8-10 小时
1. P1-1: 上传中关闭弹窗确认
2. P1-2: Toast 类型区分
3. P1-3: 首屏加载状态美化
4. P1-4: stats 接口性能优化
5. P1-5: 场次 Tab 拖拽限制移除
6. P1-6: 搜索清除选中状态

### 第三阶段（P2）：合理性改进
预计耗时：约 12-16 小时
按 P2-1 到 P2-12 顺序实施

### 第四阶段（P3）：功能增强
预计耗时：约 20-30 小时
按优先级和依赖关系逐步实施

### 第五阶段（功能增强）：长线规划
每个大功能单独制定规格和计划

---

## 八、风险与注意事项

1. **ConfirmDialog 替换风险**：全局替换原生 confirm 时需确保每个调用点的确认逻辑正确，避免误删数据。
2. **路由重构风险**：修改 popstate 监听时需 thoroughly 测试所有导航路径。
3. **数据库修改风险**：修改数据库表结构或新增表时需考虑已有数据的迁移。
4. **大文件重构风险**：拆分 Video2Page.tsx 需渐进式进行，每一步都要验证功能完整性。
5. **接口兼容性**：修改接口返回格式时需确保前端兼容，避免 Breaking Change。

---

> 本计划基于 `comprehensive_review.md` 全面分析制定，实施前请确认优先级排序是否符合预期。
