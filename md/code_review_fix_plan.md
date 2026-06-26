# 柒子文化拍摄辅助系统 — Code Review 修复计划

## 📊 问题验证总结

已验证 code review 报告中的大部分问题确实存在，以下是按优先级排序的修复计划。

---

## 🔴 P0 — 致命缺陷（立即修复）

### P0-1. `processImageGen` 使用未定义的 `OSS_ENDPOINT` 和 `OSS_BUCKET`
- **文件**：`server/index.js` 第 911 行
- **问题**：`imageUrl = \`${OSS_ENDPOINT}/${OSS_BUCKET}/${ossKey}\``，两个常量未定义
- **影响**：AI 生成的图片 URL 为 `undefined/undefined/...`，无法显示
- **修复方案**：使用 `ossClient.put()` 返回的 `result.url`
- **工时**：10 分钟

### P0-2. 前端 AI 生图轮询字段与后端不匹配
- **文件**：`src/components/ai/AIImageGenDialog.tsx` 第 193 行
- **问题**：前端读 `task.output?.imageUrl`，后端存的是 `{ media }`
- **影响**：AI 生图完成后前端永远认为"生成结果无效"
- **修复方案**：
  1. 检查接口返回结构：后端返回 `{ success: true, data: task }`
  2. 前端读取 `task.data.output?.media?.url`
- **工时**：30 分钟

### P0-3. 图片上传接口 `projectId` 变量先使用后定义
- **文件**：`server/index.js` 第 2118 行
- **问题**：OSS 上传时使用 `projectId`，但 `const { projectId } = req.body` 在第 2134 行才解构
- **影响**：所有图片存入 `undefined/images/` 文件夹
- **修复方案**：将 `req.body` 解构移到 OSS 上传逻辑之前
- **工时**：10 分钟

### P0-4. 缺少 `POST /api/video2/shots/:id/media` 端点
- **文件**：`server/index.js` + `src/components/ai/AIImageGenDialog.tsx`
- **问题**：前端调用 POST 端点添加 media，但后端只有 GET/DELETE
- **影响**：「添加到分镜」按钮无效，生成的图片无法保存
- **修复方案**：后端新增 POST 端点，调用 `db.video2ShotMedia.create()`
- **工时**：20 分钟

### P0-5. API 路由路径前后端不匹配
- **问题**：前端用 `/api/video2/shots/...`，后端是 `/api/video2/videos/...` 或 `/api/video2/:id/...`
- **不匹配列表**：

| 前端调用 | 后端实际路由 |
|---------|------------|
| `PUT /api/video2/shots/:id/status` | `PUT /api/video2/:id/status` |
| `DELETE /api/video2/shots/:id` | 不存在 ❓ |
| `POST /api/video2/shots/:id/restore` | `POST /api/video2/videos/:id/restore` |
| `DELETE /api/video2/shots/:id/hard` | `DELETE /api/video2/videos/:id/hard` |
| `PUT /api/video2/shots/batch-update` | `PUT /api/video2/videos/batch-update` |
| `POST /api/video2/shots/merge` | `POST /api/video2/shots/merge` ✅ |
| `GET /api/video2/shots/:id/media` | 不存在（但有 DELETE 和 PUT sort） |

- **影响**：状态切换、删除、恢复、彻底删除、批量操作全部 404
- **修复方案**：**将后端所有旧路由重命名为 `/api/video2/shots/...` 前缀**，保持与前端一致
- **工时**：1 小时

> **小计**：P0 共 5 项，预估 2.5 小时

---

## 🟠 P1 — 高优先级（核心功能修复）

### P1-1. `aiClient.js` 中 `totalTokens` 字段名不一致
- **文件**：`server/aiClient.js` 第 86、147 行
- **问题**：`usage.totalTokens` → 实际是 `usage.total_tokens`（下划线风格）
- **影响**：token 统计永远为 0，费用不准
- **修复方案**：`usage.total_tokens || usage.totalTokens || 0`
- **工时**：10 分钟

### P1-2. ffmpeg 同时使用 `-b:v` 和 `-crf` 冲突
- **文件**：`server/index.js` 第 339-345 行
- **问题**：`-b:v`（指定码率）和 `-crf`（质量系数）冲突，结果不可预测
- **修复方案**：保留 CRF 模式，移除 `-b:v`，保留 `-maxrate` 和 `-bufsize` 作为上限
- **工时**：10 分钟

### P1-3. `findExecutable` 在 Windows 上不可用
- **文件**：`server/index.js` 第 33-47 行
- **问题**：使用 `which` / `command -v`，Windows 没有这些命令
- **影响**：Windows 部署时 ffmpeg 查找失败
- **修复方案**：
  1. 优先使用 `ffmpeg-static` / `ffprobe-static`（代码中已有此逻辑）
  2. `findExecutable` 增加 Windows 的 `where` 命令支持
- **工时**：20 分钟

### P1-4. `loadShots` 条件判断冗余
- **文件**：`src/components/Video2Page.tsx` 第 229-233 行
- **问题**：`else if (currentSceneId !== null)` 可简化为 `else`
- **修复方案**：简化条件，同时确认 `undefined` 状态的处理
- **工时**：5 分钟

### P1-5. 导出 Word 文档场次名称错误
- **文件**：`server/index.js` 第 1649-1654 行
- **问题**：用 `sceneKey`（数字 ID）显示场次标题，如「第 3 场」而非实际名称
- **修复方案**：先查询 scenes 表获取场次名称
- **工时**：20 分钟

### P1-6. `Content-Disposition` 响应头语法错误
- **文件**：`server/index.js` 第 1729 行
- **问题**：末尾多了一个 `)`：`..._分镜脚本.docx")`
- **影响**：下载文件名可能异常
- **修复方案**：移除多余的右括号
- **工时**：5 分钟

### P1-7. `docx` 导出 `ImageRun` 导入路径错误
- **文件**：`server/index.js` 第 1618 行
- **问题**：`require('docx/build/image-run')` 不是有效路径
- **影响**：如果代码运行到这里会崩溃（但当前可能未触发）
- **修复方案**：检查 `docx` 库的正确导入方式，或移除未使用的导入
- **工时**：15 分钟

> **小计**：P1 共 7 项，预估 1.5 小时

---

## 🟡 P2 — 中等优先级（体验与安全）

### P2-1. OSS AccessKey 暴露在前端（安全隐患）
- **文件**：`.env` 第 14-15 行
- **问题**：`REACT_APP_OSS_` 前缀会被打包到前端
- **修复方案**：
  1. 变量名改为 `SERVER_OSS_` 前缀
  2. 确认后端读取使用新变量名
  3. 前端上传全部走后端转发（代码中已是这样）
- **工时**：20 分钟

### P2-2. `ShotCard` 双重 API 调用
- **文件**：`src/components/storyboard/ShotCard.tsx` 第 130-135 行
- **问题**：`handleFieldUpdate` 既调 `onUpdate`（父组件又发一次请求），又调 `updateShotField`
- **修复方案**：移除 `ShotCard` 内部的 `updateShotField`，统一由父组件处理
- **工时**：15 分钟

### P2-3. `ShotCard` 中 AI 生成按钮回调错误
- **文件**：`src/components/storyboard/ShotCard.tsx` 第 246-257 行
- **问题**：「AI生成」按钮调用 `onUploadMedia` 而不是 `onAiGenerate`
- **修复方案**：
  1. 在 props 接口中添加 `onAiGenerate`
  2. 按钮点击改为调用 `onAiGenerate?.(shot)`
- **工时**：15 分钟

### P2-4. 视频分割功能缺少触发入口
- **文件**：`src/components/Video2Page.tsx`
- **问题**：`VideoSplitDialog` 始终渲染，但 `selectedVideoForSplit` 始终为 null，没有找到触发入口
- **修复方案**：
  1. 检查 `selectedVideoForSplit` 的设置逻辑
  2. 在 ShotCard 或顶部工具栏添加入口
- **工时**：30 分钟

### P2-5. 缺少分镜加载的 loading/error 状态
- **文件**：`src/components/Video2Page.tsx`
- **问题**：切换场次/tab 时没有局部 loading，用户看到旧数据
- **修复方案**：添加 `shotsLoading` 状态，切换时显示骨架屏或 loading 提示
- **工时**：30 分钟

> **小计**：P2 共 5 项，预估 1.8 小时

---

## 🔵 P3 — 低优先级（代码质量与优化）

### P3-1. `Video2Page.tsx` 体量过大（1783 行）
- **建议**：拆分为 hooks（`useShots`、`useScenes`、`useUpload`）和子组件
- **工时**：4-6 小时（较大重构）

### P3-2. 顶部栏按钮过多，移动端拥挤
- **建议**：分享、AI 生成、费用统计、设置合并到「更多」下拉菜单
- **工时**：1 小时

### P3-3. `renderShotCard` 重复排序
- **文件**：`src/components/Video2Page.tsx` 第 934 行
- **问题**：每个卡片内都重新排序计算 `isFirst`/`isLast`
- **修复方案**：直接用外层 index 判断
- **工时**：10 分钟

### P3-4. 拖拽排序缺少动画
- **建议**：用 motion 库的 LayoutGroup 实现平滑动画
- **工时**：1 小时

### P3-5. Toast 没有进出场动画
- **文件**：`src/components/Video2Page.tsx` 第 1774-1779 行
- **修复方案**：加 CSS transition 或 motion
- **工时**：15 分钟

### P3-6. 空场次时自动选中第一个有数据的场次
- **建议**：新项目首次进入时，自动选中第一个有分镜的场次
- **工时**：20 分钟

### P3-7. 全屏查看时 `fullscreenItem.title` 不存在
- **文件**：`src/components/Video2Page.tsx` 第 1748-1761 行
- **问题**：`ShotMedia` 只有 `filename`，没有 `title`
- **修复方案**：改为 `fullscreenItem.filename`
- **工时**：5 分钟

### P3-8. 多处使用原生 `confirm()` 弹窗
- **建议**：用自定义 `ConfirmDialog` 替换，保持 UI 一致
- **工时**：1 小时

> **小计**：P3 共 8 项，预估 9 小时（多数为可选优化）

---

## 📋 修复执行顺序建议

### 第一轮（必须做，2.5 小时）
1. P0-1: `OSS_ENDPOINT`/`OSS_BUCKET` 未定义
2. P0-2: AI 生图轮询字段不匹配
3. P0-3: 图片上传 `projectId` 先使用后定义
4. P0-4: 缺少 `POST /shots/:id/media` 端点
5. P0-5: API 路由统一为 `/shots/` 前缀

### 第二轮（重要，1.5 小时）
6. P1-1: `totalTokens` 字段名
7. P1-2: ffmpeg 参数冲突
8. P1-3: Windows `findExecutable` 兼容
9. P1-5: Word 导出场次名称
10. P1-6: `Content-Disposition` 语法错误
11. P1-7: `ImageRun` 导入路径

### 第三轮（体验优化，1.8 小时）
12. P2-1: OSS Key 安全重命名
13. P2-2: ShotCard 双重调用
14. P2-3: AI 生成按钮回调错误
15. P2-4: 视频分割入口
16. P2-5: 加载 loading 状态

### 第四轮（代码质量，可选）
17. P3-3: 重复排序优化
18. P3-7: 全屏 title 修复
19. P3-5: Toast 动画
20. ... 其他 P3 项按需

---

## ⚠️ 注意事项

1. **P0-5（路由统一）风险最高**：涉及 10+ 个路由改动，需逐一验证每个前端调用点
2. **P0-2（字段不匹配）**：需要同时确认后端 AI 任务查询接口返回的完整结构
3. **P2-1（OSS Key 重命名）**：需要同步检查后端所有读取 OSS 配置的地方
4. **建议每修复完 P0 和 P1 后进行完整测试**，确保核心功能正常
