# 柒子文化拍摄辅助系统 — 全面代码审查报告

## 审查范围
- **前端**：`Video2Page.tsx`、`ShotCard.tsx`、`AIImageGenDialog.tsx`、`VideoSplitDialog.tsx`、`AddShotDialog.tsx`、`MediaManagerDialog.tsx`、`SettingsDialog.tsx`、`AIUsagePanel.tsx`、`ossUtils.ts`、`types.ts` 等 23 个文件
- **后端**：`index.js` (2479行)、`database.js` (1822行)、`aiClient.js` (480行)、`aliyunVideo.js` (224行) 等 6 个文件

---

## 🔴 CRITICAL — 严重错误（会直接导致功能崩溃）

### C1. 后端 `processImageGen` 使用未定义的常量 `OSS_ENDPOINT` 和 `OSS_BUCKET`
- **文件**：[index.js](file:///c:/Users/jimin/Documents/qizi-video/server/index.js#L911)
- **问题**：第 911 行使用了 `OSS_ENDPOINT` 和 `OSS_BUCKET`，但这两个常量从未在 `index.js` 中定义。代码中只有 `ossClient` 和 `process.env.REACT_APP_OSS_BUCKET`。
- **影响**：AI 生成的参考图上传到 OSS 后，返回的 URL 会是 `undefined/undefined/...`，图片无法显示。
- **修复**：
```diff
- imageUrl = `${OSS_ENDPOINT}/${OSS_BUCKET}/${ossKey}`;
+ const ossResult = await ossClient.put(ossKey, Buffer.from(buffer));
+ imageUrl = ossResult.url;
```

### C2. 前端 AI 生图轮询检查的字段与后端返回不匹配
- **文件**：[AIImageGenDialog.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/ai/AIImageGenDialog.tsx#L185-L206)
- **问题**：前端检查 `task.output?.imageUrl`，但后端 `processImageGen` 返回的任务 output 中存储的是 `{ media }`（第 932-933 行），没有 `imageUrl` 字段。`task.data` 的实际结构是 `task.data.output.media`。
- **影响**：AI 图片生成完成后，前端永远认为「生成结果无效」，抛出错误。**核心 AI 生图功能完全不可用。**
- **修复**：前端需要先读取 `task.data`，然后检查 `task.data.output?.media?.url`。同时注意后端返回的是 `{ success: true, data: task }`，不是直接的 task。

### C3. 前端图片上传端点 `projectId` 变量使用未定义
- **文件**：[index.js](file:///c:/Users/jimin/Documents/qizi-video/server/index.js#L2118)
- **问题**：第 2118 行使用 `projectId`，但该变量在 `upload/image` 路由的当前作用域中还未从 `req.body` 解构出来（第 2134 行才做 `const { projectId, sceneId, reference } = req.body || {}`）。
- **影响**：图片上传到 OSS 时，`projectId` 为 `undefined`，导致所有图片都存储在 `undefined/images/` 文件夹下，后续清理和查找困难。
- **修复**：将 `req.body` 的解构移到 OSS 上传之前。

### C4. 前端 `handleAddToShot` 调用不存在的 POST 端点
- **文件**：[AIImageGenDialog.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/ai/AIImageGenDialog.tsx#L225)
- **问题**：前端调用 `POST /api/video2/shots/:id/media`，但后端只有 `GET` 和 `DELETE` 方法，**没有 POST 端点**来添加 media。
- **影响**：用户点击「添加到分镜」按钮后会报 404 或 405 错误，生成的图片无法保存到分镜中。
- **修复**：在后端新增 `POST /api/video2/shots/:id/media` 端点。

---

## 🟠 HIGH — 高优先级问题（影响核心功能）

### H1. API 路径新旧不一致 — 前端调用的路径与后端定义不匹配
- **前端** `Video2Page.tsx` 多处调用与后端路由不一致：
  | 前端调用 | 后端实际路由 | 状态 |
  |---------|------------|------|
  | `PUT /api/video2/shots/:id/status` | `PUT /api/video2/:id/status` | ❌ 不匹配 |
  | `DELETE /api/video2/shots/:id` | `DELETE /api/video2/:id` | ❌ 不匹配 |
  | `POST /api/video2/shots/:id/restore` | `POST /api/video2/videos/:id/restore` | ❌ 不匹配 |
  | `DELETE /api/video2/shots/:id/hard` | `DELETE /api/video2/videos/:id/hard` | ❌ 不匹配 |
  | `PUT /api/video2/shots/batch-update` | `PUT /api/video2/videos/batch-update` | ❌ 不匹配 |
- **影响**：状态切换、删除、恢复、彻底删除、批量操作等核心功能全部会返回 404。
- **修复**：统一路由前缀。建议将后端旧路由全部重命名为 `/api/video2/shots/...` 前缀，或者在后端增加 alias 路由。

### H2. `aiClient.js` 中 `totalTokens` 字段名不一致
- **文件**：[aiClient.js](file:///c:/Users/jimin/Documents/qizi-video/server/aiClient.js#L147)
- **问题**：第 147 行使用 `usage.totalTokens`，但 OpenAI 兼容 API 返回的是 `usage.total_tokens`（下划线风格）。
- **影响**：token 总数永远记录为 0，费用统计不准。
- **修复**：改为 `usage.total_tokens || 0`。

### H3. 视频压缩同时使用 `-b:v` 和 `-crf`，相互冲突
- **文件**：[index.js](file:///c:/Users/jimin/Documents/qizi-video/server/index.js#L337-L346)
- **问题**：ffmpeg 选项同时设置了 `-b:v 3000k`（指定码率）和 `-crf 28`（质量系数）。在 libx264 中，这两者是冲突的：`-crf` 会覆盖 `-b:v` 或反之，导致不可预测的压缩结果。
- **影响**：视频压缩效果不稳定，可能比特率过高或过低。
- **修复**：二选一。推荐使用 CRF 模式：
```diff
- `-b:v ${maxBitrateKbps}k`,
- `-maxrate ${maxBitrateKbps + 500}k`,
- `-bufsize ${maxBitrateKbps * 2}k`,
  '-preset ultrafast',
  '-c:v libx264',
  '-c:a aac',
  '-crf 28',
+ `-maxrate ${maxBitrateKbps}k`,
+ `-bufsize ${maxBitrateKbps * 2}k`,
  '-movflags +faststart'
```

### H4. `findExecutable` 使用 `which` 命令在 Windows 服务器上不可用
- **文件**：[index.js](file:///c:/Users/jimin/Documents/qizi-video/server/index.js#L33-L47)
- **问题**：使用 `which` 和 `command -v`，这些是 Unix 命令，在 Windows 上不存在。
- **影响**：在 Windows 服务器上部署时，ffmpeg 路径查找会失败，视频压缩和分割功能不可用。
- **修复**：使用 `where` 命令或 cross-platform 方案。

### H5. `Video2Page` 的 `loadShots` 条件判断冗余且逻辑有误
- **文件**：[Video2Page.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/Video2Page.tsx#L229-L233)
- **问题**：
```javascript
if (currentSceneId === null) {
  params.set('sceneId', 'null');
} else if (currentSceneId !== null) { // 这个 else if 永远为 true
  params.set('sceneId', String(currentSceneId));
}
```
`else if (currentSceneId !== null)` 始终成立（因为前面已经排除了 `null`），应简化为 `else`。虽然不是 bug，但表明可能遗漏了 `undefined` 状态。

### H6. 导出 Word 文档时场次名称错误
- **文件**：[index.js](file:///c:/Users/jimin/Documents/qizi-video/server/index.js#L1649-L1654)
- **问题**：场次标题使用 `sceneKey`（数字 ID），显示为 `第 3 场` 而不是实际场次名称。
- **影响**：导出的 Word 文档场次标题无意义。
- **修复**：先查询 scenes 表获取名称。

---

## 🟡 MEDIUM — 中等优先级（影响用户体验或存在安全隐患）

### M1. 安全隐患：OSS AccessKey 暴露在前端代码中
- **文件**：[.env](file:///c:/Users/jimin/Documents/qizi-video/.env#L14-L15)
- **问题**：`REACT_APP_OSS_ACCESS_KEY_ID` 和 `REACT_APP_OSS_ACCESS_KEY_SECRET` 以 `REACT_APP_` 前缀定义，会被打包到前端代码中。
- **影响**：任何用户可以通过浏览器 DevTools 获取阿里云 AccessKey，存在严重的安全风险。
- **修复**：前端上传应全部通过后端 API 转发（实际代码中已经这样做），但 `.env` 中的 `REACT_APP_` 前缀的变量名应改为 `SERVER_OSS_` 之类的非前端暴露前缀。

### M2. `ossUtils.ts` 中 `uploadVideoDirectToOSS` 调用不存在的 presign 端点
- **文件**：[ossUtils.ts](file:///c:/Users/jimin/Documents/qizi-video/src/lib/ossUtils.ts#L195)
- **问题**：调用 `POST /api/oss/presign`，但后端 `index.js` 中没有这个端点。
- **影响**：直传 OSS 功能不可用。虽然可能不会被调用到，但代码中有引用路径。

### M3. 缺少分镜数据加载的 loading/error 状态反馈
- **文件**：[Video2Page.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/Video2Page.tsx#L285-L289)
- **问题**：初始加载只设置了全局 loading，后续切换场次/tab 时的 `loadShots` 没有局部 loading 状态。如果网络慢，用户切换场次时会看到旧数据短暂显示再刷新。
- **影响**：用户体验差，数据切换时无过渡状态。

### M4. `InlineEditField` 在 `ShotCard` 中发起双重 API 调用
- **文件**：[ShotCard.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/storyboard/ShotCard.tsx#L130-L135)
- **问题**：`handleFieldUpdate` 先调用 `onUpdate`（Video2Page 中也会发起 `fetch` API 调用），又在内部调用 `updateShotField`。相同的更新发送了两次到后端。
- **影响**：每次编辑分镜字段会发送 2 个 HTTP 请求，造成资源浪费和潜在的竞态条件。
- **修复**：移除 `ShotCard` 内部的 `updateShotField` 调用，只通过 `onUpdate` 回调由父组件处理。

### M5. `ShotCard` 中 AI 生成按钮没有连接到正确的回调
- **文件**：[ShotCard.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/storyboard/ShotCard.tsx#L252-L258)
- **问题**：「AI生成」按钮的 `onClick` 调用的是 `onUploadMedia?.(shot)` 而不是 AI 生成的回调。`Video2Page.tsx` 中给 `ShotCard` 传递了 `onAiGenerate` 但没有在 props 接口中声明。
- **影响**：用户点击卡片上的「AI生成」按钮，打开的是媒体管理器而不是 AI 生图对话框。

### M6. 视频分割对话框的 `videoUrl` 为空时不处理
- **文件**：[Video2Page.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/Video2Page.tsx#L1705-L1716)
- **问题**：`VideoSplitDialog` 始终渲染，`videoUrl` 传入 `selectedVideoForSplit || ''`。但 `showVideoSplitDialog` 被设为 true 的触发逻辑在哪里没有找到——`selectedVideoForSplit` 始终是 `null`。
- **影响**：视频分割功能无法被用户触发，没有入口。

### M7. `aliyunVideo.js` 中 `splitVideo` 函数返回结果调用了自身的 `parseSplitResult`
- **文件**：[aliyunVideo.js](file:///c:/Users/jimin/Documents/qizi-video/server/aliyunVideo.js#L164)
- **问题**：`splitVideo` 中调用了 `parseSplitResult(result.result)`，但 `index.js` 中 `processVideoSplitAliyun` 获取 `getSplitVideoResult` 后也调用了 `parseSplitResult`。如果改用 `splitVideo`（本地调用），结果会被解析两次。
- **当前影响**：不大，因为 `splitVideo` 没有被直接使用。

### M8. `Content-Disposition` 响应头语法错误
- **文件**：[index.js](file:///c:/Users/jimin/Documents/qizi-video/server/index.js#L1729)
- **问题**：`filename=\"${encodeURIComponent(project.name)}_分镜脚本.docx\")`，末尾多了一个右括号 `)`。
- **影响**：浏览器可能无法正确解析文件名，导致下载的文件名异常。

### M9. `docx` 导出使用不存在的 `ImageRun` 导入路径
- **文件**：[index.js](file:///c:/Users/jimin/Documents/qizi-video/server/index.js#L1618)
- **问题**：`require('docx/build/image-run')` 不是 `docx` 库的有效导入路径。
- **影响**：导出功能会在运行时崩溃（如果尝试使用图片嵌入）。实际代码中没有用到 `ImageRun`，但声明会导致启动时崩溃。

---

## 🔵 LOW — 低优先级（代码质量、视觉细节）

### L1. `Video2Page.tsx` 体量过大（1783 行）
- **问题**：单个组件文件包含所有页面逻辑、状态、弹窗、UI 渲染，难以维护和测试。
- **建议**：按功能拆分为独立的 hooks（`useShots`、`useScenes`、`useUpload`）和子组件。

### L2. 视觉问题：顶部栏按钮过多，手机端拥挤
- **文件**：[Video2Page.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/Video2Page.tsx#L1028-L1104)
- **问题**：顶部栏包含返回、项目名称、分享、AI 生成、费用统计、设置、上传 共 7 个元素。在 320px 宽的手机上会非常拥挤或溢出。
- **建议**：将分享、AI 生成、费用统计、设置合并到一个「更多」下拉菜单中。

### L3. `renderShotCard` 中每次渲染都重新排序 shots 数组
- **文件**：[Video2Page.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/Video2Page.tsx#L934)
- **问题**：`renderShotCard` 内部对每个卡片都创建排序后的 `sortedShots` 数组来计算 `isFirst`/`isLast`，但外层已经有 `sortedShots`。
- **影响**：N 个卡片做 N 次排序，时间复杂度从 O(N) 变为 O(N² log N)。
- **修复**：直接使用外层的 `index` 参数判断 `isFirst`/`isLast`。

### L4. 拖拽排序缺少触觉反馈和视觉动画
- **问题**：拖拽卡片和场次时，只改变了 `opacity` 和 `ring`，没有平滑的位移动画。
- **建议**：使用 `motion`（已安装的 framer-motion 兼容包）添加 `LayoutGroup` 和 `layout` 属性实现平滑排序动画。

### L5. Toast 没有出场动画
- **文件**：[Video2Page.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/Video2Page.tsx#L1774-L1779)
- **问题**：Toast 突然出现和消失，没有淡入淡出动画。
- **建议**：使用 CSS transition 或 motion 组件添加进出场动画。

### L6. 空场次时初始状态不明确
- **问题**：项目刚创建时没有任何场次，`currentSceneId` 为 `null`（未分类），但 `loadShots` 会立即发送 `sceneId=null` 参数，表示只加载「未分类」的分镜。如果脚本生成了分镜并自动创建了场次，用户需要手动点击场次 tab 才能看到。
- **建议**：新项目首次进入时，自动选中第一个有数据的场次。

### L7. 全屏查看视频/图片时 `fullscreenItem.title` 属性不存在
- **文件**：[Video2Page.tsx](file:///c:/Users/jimin/Documents/qizi-video/src/components/Video2Page.tsx#L1748-L1761)
- **问题**：`ShotMedia` 类型中没有 `title` 属性（只有 `filename`），所以 `fullscreenItem.title` 显示为 `undefined`。
- **修复**：改为 `fullscreenItem.filename`。

### L8. 多处使用 `confirm()` 原生弹窗
- **文件**：多处（`Video2Page.tsx` 第 446、510、628、1573、1643 行）
- **问题**：使用浏览器原生 `confirm()` 弹窗，与深色主题 UI 风格不一致。项目已有 `ConfirmDialog` 组件但没有使用。
- **建议**：使用自定义的 `ConfirmDialog` 组件替代所有 `confirm()` 调用。

---

## 📋 修复优先级建议

| 优先级 | 编号 | 问题描述 | 预估工时 |
|-------|------|---------|---------|
| 🔴 P0 | C1, C2, C3, C4 | AI 生图功能完全不可用（OSS 变量未定义、字段不匹配、端点缺失） | 2-3h |
| 🔴 P0 | H1 | API 路由路径前后端不匹配，核心操作（删除/恢复/状态切换）全部 404 | 1-2h |
| 🟠 P1 | H2, H3, H4 | token 统计不准、ffmpeg 参数冲突、Windows 兼容 | 1h |
| 🟠 P1 | H5, H6, M8, M9 | 逻辑冗余、导出错误、Content-Disposition 语法 | 1h |
| 🟡 P2 | M1 | OSS AccessKey 安全风险 | 0.5h |
| 🟡 P2 | M4, M5, M6 | 双重 API 调用、AI 按钮连接错误、视频分割无入口 | 1-2h |
| 🔵 P3 | L1-L8 | 代码质量、视觉优化、性能优化 | 3-4h |

> [!CAUTION]
> **最关键的问题**：C1-C4 和 H1 是致命缺陷，表明分镜系统的 AI 功能和基础 CRUD 操作**目前无法正常工作**。建议立即修复。
