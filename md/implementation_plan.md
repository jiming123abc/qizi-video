# 分镜系统全面升级 — 详细实施计划

## 背景

将现有的「柒子文化拍摄辅助」从简单的媒体管理工具升级为专业的**分镜脚本管理系统**，集成 AI 大语言模型实现脚本自动解析、参考图 AI 生成等功能。

> [!IMPORTANT]
> 本计划涉及**数据库 schema 重大变更**、**新增多个 AI API 端点**、**前端组件大规模重构**。建议先在开发环境充分测试，再部署生产环境。数据库迁移应设计为向后兼容（旧数据自动升级）。

---

## 用户需求合理性分析与建议

### ✅ 合理的需求
- 将媒体卡片升级为分镜卡片（包含画面内容、演员、道具等专业字段）
- 参考画面轮播图展示（每个分镜支持多张参考图/视频，上限10个）
- AI 脚本解析生成分镜、AI 生成参考图
- 分镜合并功能
- 数据导出为可编辑脚本
- 系统设置（模型选择+降级链）
- OSS 按项目ID分文件夹

### ⚠️ 已确认的调整方案

> [!NOTE]
> **1. 视频分割：双方案并行**
> 
> 同时实现**前端手动标记+服务端分割**和**AI辅助自动分割**两种方案：
> - **手动标记**（默认推荐）：精度高、免费、用户完全可控
> - **AI自动分割**（可选）：效率高，但成本高、精度有限
> 
> AI自动分割提示文案：
> ```
> ⚠️ AI自动分割提示
> - 处理时间较长（根据视频时长，约5-30分钟）
> - 需要消耗较多AI tokens（预估费用：¥XX-XX）
> - 分割结果可能需要手动调整
> - ⚠️ 不建议自动分割时长过长的视频（>5分钟），
>   建议使用手动标记分割以获得更精确的结果
> 
> 是否继续？
> ```

> [!NOTE]
> **2. 场景图生图：图生图优先**
> 
> 核心需求：上传场景图片 → 生成在该场景下的分镜参考图 → 帮助拍摄者构图
> 
> **技术实现**：
> - 优先使用支持图生图的模型（gpt-image-2、nano-banana-2）
> - 传入场景图 + 画面内容描述，直接图生图
> - 兜底方案：先用多模态模型分析场景图提取特征，再结合描述文生图

> [!NOTE]
> **3. API 平台与模型配置**
> 
> **平台**：
> - GeekAI（首选）：Base URL = `https://geekai.co/api/v1`
>   API Key = `sk-DbD0R7hJSZFWVKxKsOTv3VVP5M62vdAj6IY2HZ0gNqBGD29F`
> - SiliconFlow（备选降级）：Base URL = `https://api.siliconflow.cn/v1`
>   API Key = `sk-xoljshalzrunfxpmidfuwbqxycezyxqgdmmvcwfqhtognlmd`
> 
> **首选生图模型（按优先级）**：
> 1. `gpt-image-2` (quality: medium) — 质量最好，场景理解强，费用中高
> 2. `z-image-turbo` (quality: standard) — 速度快，性价比高，费用低
> 3. `nano-banana-2` (quality: standard) — Google新模型，质量好，费用中
> 4. `cogview-4` (quality: standard) — 中文理解好，兜底，费用中

> [!NOTE]
> **4. 视频压缩：禁止跳过，强制压缩**
> 
> - **不提供**"跳过压缩直接上传"选项
> - 码率超过阈值的视频必须经过压缩后才能上传
> - 增加分辨率检测，动态调整目标码率（1080p→3000k，720p→2000k，480p→1000k）
> - 移动端支持浏览器端WASM压缩，但增加性能警告

> [!NOTE]
> **5. AI费用统计**
> 
> - 新增 `ai_usage_logs` 表记录每次AI调用的token和费用
> - 模型价格配置存储在settings表中
> - 前端展示费用统计面板

---

## 一、数据库 Schema 升级

### 1.1 现有表结构（video2.db）

现有 `videos` 表将升级为分镜表，同时新增 `shot_media`（分镜参考画面表）、`settings`（系统设置表）、`ai_tasks`（AI任务表）、`ai_usage_logs`（AI费用记录表）。

### 1.2 新增/修改表

#### [MODIFY] videos 表（新增分镜专业字段）

> 采用渐进式迁移：保留 `videos` 表名，通过 ALTER TABLE 新增列，避免数据丢失。

```sql
-- 在 videos 表基础上新增分镜专业字段
ALTER TABLE videos ADD COLUMN sceneContent TEXT DEFAULT '';     -- 画面内容（原 title 迁移过来）
ALTER TABLE videos ADD COLUMN actors TEXT DEFAULT '';           -- 演员/角色
ALTER TABLE videos ADD COLUMN props TEXT DEFAULT '';            -- 道具
ALTER TABLE videos ADD COLUMN location TEXT DEFAULT '';         -- 拍摄地点
ALTER TABLE videos ADD COLUMN focalLength TEXT DEFAULT '';      -- 镜头焦段（如 35mm、50mm、85mm）
ALTER TABLE videos ADD COLUMN narration TEXT DEFAULT '';        -- 旁白/台词
ALTER TABLE videos ADD COLUMN cameraMovement TEXT DEFAULT '';   -- 镜头运动（推、拉、摇、移、跟、升降、甩）
ALTER TABLE videos ADD COLUMN shotType TEXT DEFAULT '';         -- 景别（远景、全景、中景、近景、特写）
ALTER TABLE videos ADD COLUMN shotAngle TEXT DEFAULT '';        -- 拍摄角度（平拍、俯拍、仰拍、荷兰角）
ALTER TABLE videos ADD COLUMN lighting TEXT DEFAULT '';         -- 灯光/光线描述
ALTER TABLE videos ADD COLUMN notes TEXT DEFAULT '';            -- 备注
ALTER TABLE videos ADD COLUMN estimatedDuration TEXT DEFAULT '';-- 预估时长（秒）
ALTER TABLE videos ADD COLUMN aiImagePrompt TEXT DEFAULT '';    -- AI 生图提示词（隐藏字段）
ALTER TABLE videos ADD COLUMN aiStylePrompt TEXT DEFAULT '';    -- AI 风格提示词（用于修改画面内容后生图）
ALTER TABLE videos ADD COLUMN mergedFrom TEXT DEFAULT '';       -- 合并来源 IDs (JSON array)
ALTER TABLE videos ADD COLUMN shotIndex INTEGER DEFAULT 0;     -- 分镜序号（不可编辑）
```

> **设计说明**：
> - `sceneContent` 对应"画面内容"，初始从 `title` 迁移
> - `shotNo` 保留原有字段，作为"镜头编号"（拍摄时使用的编号）
> - `shotIndex` 为分镜的显示序号（自动维护，不可编辑）
> - `aiImagePrompt` 存储 AI 生成的完整生图提示词
> - `aiStylePrompt` 存储从 AI 提示词中提取的风格部分

#### [NEW] shot_media 表（分镜参考画面）

```sql
CREATE TABLE IF NOT EXISTS shot_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shotId INTEGER NOT NULL,           -- 关联 videos.id
  url TEXT NOT NULL,                  -- 媒体 URL
  type TEXT NOT NULL DEFAULT 'image', -- 'image' | 'video'
  filename TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  duration REAL,                      -- 视频时长
  sortOrder INTEGER DEFAULT 0,       -- 在分镜内的排序
  source TEXT DEFAULT 'upload',       -- 'upload' | 'ai_generated' | 'video_split'
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shotId) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shot_media_shot ON shot_media(shotId);
```

> **设计说明**：
> - 每个分镜最多 10 个 `shot_media` 记录
> - 原 `videos.url` 的数据将迁移为第一条 `shot_media` 记录
> - `source` 字段区分来源，便于后续统计和管理

#### [NEW] settings 表（系统设置）

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

默认设置数据：
```json
{
  "llm_provider": "geekai",
  "llm_model": "deepseek-chat",
  "llm_fallback_chain": [
    { "model": "deepseek-chat", "provider": "geekai", "cost": "low" },
    { "model": "deepseek-chat", "provider": "siliconflow", "cost": "low" },
    { "model": "gpt-4o-mini", "provider": "geekai", "cost": "low" },
    { "model": "glm-4-flash", "provider": "geekai", "cost": "free" }
  ],
  "image_provider": "geekai",
  "image_model": "gpt-image-2",
  "image_quality": "medium",
  "image_fallback_chain": [
    { "model": "gpt-image-2", "quality": "medium", "provider": "geekai", "cost": "mid_high", "supportsImageRef": true },
    { "model": "z-image-turbo", "quality": "standard", "provider": "geekai", "cost": "low", "supportsImageRef": false },
    { "model": "nano-banana-2", "quality": "standard", "provider": "geekai", "cost": "mid", "supportsImageRef": true },
    { "model": "cogview-4", "quality": "standard", "provider": "geekai", "cost": "mid", "supportsImageRef": false }
  ],
  "geekai_api_key": "",
  "siliconflow_api_key": "",
  "default_image_size": "1024x576",
  "export_include_images": true,
  "export_format": "docx",
  "video_target_bitrate_1080p": 3000,
  "video_target_bitrate_720p": 2000,
  "video_target_bitrate_480p": 1000,
  "model_prices": {
    "deepseek-chat": { "input": 0.001, "output": 0.002 },
    "gpt-4o-mini": { "input": 0.01, "output": 0.03 },
    "glm-4-flash": { "input": 0, "output": 0 },
    "gpt-image-2": { "per_image_medium": 0.08 },
    "z-image-turbo": { "per_image_standard": 0.02 },
    "nano-banana-2": { "per_image_standard": 0.05 },
    "cogview-4": { "per_image_standard": 0.05 }
  }
}
```

#### [NEW] ai_tasks 表（AI 异步任务追踪）

```sql
CREATE TABLE IF NOT EXISTS ai_tasks (
  id TEXT PRIMARY KEY,                 -- UUID
  type TEXT NOT NULL,                  -- 'script_parse' | 'image_gen' | 'video_split'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'done' | 'error'
  projectId INTEGER,
  input TEXT,                          -- JSON: 输入参数
  output TEXT,                         -- JSON: 输出结果
  error TEXT,
  progress INTEGER DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### [NEW] ai_usage_logs 表（AI 费用统计）

```sql
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId TEXT,                          -- 关联 ai_tasks.id
  type TEXT NOT NULL,                   -- 'chat' | 'image' | 'video_split'
  model TEXT NOT NULL,                  -- 使用的模型
  provider TEXT NOT NULL,               -- 平台（geekai/siliconflow）
  promptTokens INTEGER DEFAULT 0,      -- 输入tokens
  completionTokens INTEGER DEFAULT 0,  -- 输出tokens
  totalTokens INTEGER DEFAULT 0,       -- 总tokens
  imageCount INTEGER DEFAULT 0,        -- 生成图片数量
  estimatedCost REAL DEFAULT 0,        -- 预估费用（元）
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON ai_usage_logs(createdAt);
```

### 1.3 数据迁移策略

```
迁移脚本逻辑（在 initVideo2Database 中执行）：
1. ALTER TABLE 新增所有新列（如已存在则忽略）
2. UPDATE videos SET sceneContent = title WHERE sceneContent IS NULL OR sceneContent = ''
3. 对每条 videos 中有 url 的记录，INSERT INTO shot_media (shotId, url, type, ...)
4. 初始化 settings 表默认值（API Key 从环境变量读取）
5. 重新计算 shotIndex（按 projectId + sceneId + sortOrder 排序）
```

---

## 二、后端 API 升级

### 技术栈新增依赖

```json
// server/package.json 新增
{
  "uuid": "^10.x",         // 生成任务 ID
  "docx": "^9.x",          // 生成 Word 文档（数据导出）
  "archiver": "^7.x"       // 打包导出文件
}
```

> 注意：不使用 `openai` npm 包，直接用 fetch 调用 API（参考 qizi-website 现有实现方式，兼容性更好）

### 2.1 分镜 CRUD 端点升级

#### [MODIFY] `GET /api/video2/list`
- 返回数据增加所有新字段（actors, props, location, focalLength, narration, cameraMovement, shotType, shotAngle, lighting, notes, estimatedDuration, shotIndex）
- 同时返回每个分镜的 `media` 数组（从 shot_media JOIN 查询）

#### [NEW] `POST /api/video2/shots`
新增分镜（无参考画面模式）：
```
POST /api/video2/shots
Body: {
  projectId: number,
  sceneId?: number,
  sceneContent?: string,
  actors?: string,
  props?: string,
  location?: string,
  focalLength?: string,
  narration?: string,
  cameraMovement?: string,
  shotType?: string,
  shotAngle?: string,
  lighting?: string,
  notes?: string,
  estimatedDuration?: string
}
```

#### [MODIFY] `PUT /api/video2/videos/:id/title` → `PUT /api/video2/shots/:id`
支持更新所有分镜字段（一次更新多个字段）：
```
PUT /api/video2/shots/:id
Body: { field: value, ... }  // 支持所有可编辑字段
```

#### [NEW] `POST /api/video2/shots/merge`
合并分镜：
```
POST /api/video2/shots/merge
Body: { shotIds: number[] }
Response: { success: true, mergedShot: Shot }
```
逻辑：
1. 验证所有 shotIds 有效且属于同一项目
2. 合并后的 shot_media 总数不超过 10，否则返回错误
3. 第一个 shot 保留，后续 shot 的 shot_media 迁移过来
4. 合并后的文字字段策略：sceneContent 拼接，其他字段取第一个非空值
5. 删除被合并的 shot 记录
6. 重新计算 shotIndex

### 2.2 参考画面管理端点

#### [NEW] `GET /api/video2/shots/:id/media`
获取某分镜的所有参考画面

#### [NEW] `POST /api/video2/shots/:id/media`
上传参考画面到分镜（复用现有 upload 逻辑，但存入 shot_media 表）

#### [NEW] `DELETE /api/video2/shots/:id/media/:mediaId`
删除某个参考画面

#### [NEW] `PUT /api/video2/shots/:id/media/sort`
参考画面排序

### 2.3 AI 功能端点

#### [NEW] `POST /api/video2/ai/parse-script`
脚本解析生成分镜：
```
POST /api/video2/ai/parse-script
Body: {
  projectId: number,
  sceneId?: number,
  file?: File (上传的脚本文件: .txt/.doc/.docx/.pdf),
  text?: string (直接粘贴的文本),
  mode: 'shooting_script' | 'storyboard_script' | 'copywriting'
}
Response: { taskId: string }
```

**实现细节（参考 qizi-website 现有实现风格，使用 fetch 而非 OpenAI SDK）：**

```javascript
// server/lib/aiClient.js
const GEEKAI_BASE = 'https://geekai.co/api/v1';
const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1';

async function callLLMWithFallback(messages, fallbackChain, settings, options = {}) {
  for (const item of fallbackChain) {
    const { model, provider } = item;
    const baseUrl = provider === 'siliconflow' ? SILICONFLOW_BASE : GEEKAI_BASE;
    const apiKey = provider === 'siliconflow'
      ? (settings.siliconflow_api_key || process.env.SILICONFLOW_API_KEY)
      : (settings.geekai_api_key || process.env.GEEKAI_API_KEY);
    
    if (!apiKey) continue;
    
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature || 0.3,
          max_tokens: options.max_tokens || 8192,
          ...(options.json ? { response_format: { type: "json_object" } } : {})
        }),
        signal: AbortSignal.timeout(options.timeoutMs || 120000)
      });
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const usage = data.usage || {};
      
      // 记录费用
      await logUsage({
        type: 'chat', model, provider,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        taskId: options.taskId
      }, settings);
      
      return { model, provider, content: data.choices[0].message.content, usage };
    } catch (err) {
      console.warn(`[AI] ${provider}/${model} 调用失败: ${err.message}`);
      continue;
    }
  }
  throw new Error('所有模型均调用失败');
}
```

#### [NEW] `POST /api/video2/ai/generate-image`
AI 生成参考图：
```
POST /api/video2/ai/generate-image
Body: {
  shotId: number,
  prompt?: string,           // 用户自定义 prompt（覆盖 aiImagePrompt）
  sceneImageUrl?: string,    // 上传的场景参考图 URL
  useStoredPrompt: boolean,  // 是否使用存储的 aiImagePrompt
  size?: string              // 图片尺寸，默认 1024x576
}
Response: { taskId: string }
```

**实现逻辑：**

```javascript
async function generateShotReferenceImage(shot, options, settings) {
  const { sceneImageUrl, customPrompt, size = '1024x576' } = options;
  
  // 1. 确定 prompt
  let finalPrompt = customPrompt || shot.aiImagePrompt || shot.sceneContent;
  
  // 2. 根据是否有场景图选择模型链
  const fallbackChain = settings.image_fallback_chain || [];
  
  for (const item of fallbackChain) {
    const { model, quality, provider, supportsImageRef } = item;
    const baseUrl = provider === 'siliconflow' ? SILICONFLOW_BASE : GEEKAI_BASE;
    const apiKey = provider === 'siliconflow'
      ? (settings.siliconflow_api_key || process.env.SILICONFLOW_API_KEY)
      : (settings.geekai_api_key || process.env.GEEKAI_API_KEY);
    
    if (!apiKey) continue;
    
    try {
      let imageUrl;
      
      if (sceneImageUrl && supportsImageRef) {
        // 图生图模式
        const result = await callImageGenerationWithRef(model, finalPrompt, sceneImageUrl, quality, size, baseUrl, apiKey);
        imageUrl = result.url;
      } else if (sceneImageUrl && !supportsImageRef) {
        // 兜底：先用多模态分析场景，再文生图
        const sceneDesc = await analyzeSceneWithLLM(sceneImageUrl, settings);
        const enhancedPrompt = `${sceneDesc}, ${finalPrompt}`;
        const result = await callImageGeneration(model, enhancedPrompt, quality, size, baseUrl, apiKey);
        imageUrl = result.url;
      } else {
        // 普通文生图
        const result = await callImageGeneration(model, finalPrompt, quality, size, baseUrl, apiKey);
        imageUrl = result.url;
      }
      
      // 记录费用
      await logUsage({
        type: 'image', model, provider,
        imageCount: 1, taskId: options.taskId
      }, settings);
      
      return { model, provider, url: imageUrl };
    } catch (err) {
      console.warn(`[AI Image] ${provider}/${model} 失败: ${err.message}`);
      continue;
    }
  }
  throw new Error('所有图片模型均调用失败');
}

// 调用文生图 API（参考 qizi-website 实现 callGeekAIModel）
async function callImageGeneration(model, prompt, quality, size, baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model, prompt, size, quality,
      watermark: false, n: 1, response_format: 'url'
    }),
    signal: AbortSignal.timeout(60000)
  });
  
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  
  // 兼容多种返回格式（参考 qizi-website 实现）
  if (data.data?.[0]?.url) return { url: data.data[0].url };
  if (data.url) return { url: data.url };
  if (data.output?.url) return { url: data.output.url };
  if (data.images?.[0]?.url) return { url: data.images[0].url };
  
  throw new Error('返回数据格式异常');
}
```

#### [NEW] `GET /api/video2/ai/task/:taskId`
AI 任务状态查询（统一的轮询端点）

#### [NEW] `POST /api/video2/ai/split-video`
视频分割为分镜（支持两种模式）：
```
POST /api/video2/ai/split-video
Body: {
  videoUrl: string,
  projectId: number,
  sceneId?: number,
  mode: 'manual' | 'ai',
  splitPoints?: number[]  // manual模式下的分割时间点数组（秒）
}
Response: { taskId: string }
```

**AI模式实现逻辑**：
1. 服务端用 ffmpeg 提取视频关键帧（每5-10秒一帧）
2. 将关键帧发送给多模态大模型分析镜头切换点
3. 返回建议的分割时间点
4. 用户确认/调整后，用 ffmpeg 按时间点切割
5. 每段生成一个分镜

### 2.4 设置端点

#### [NEW] `GET /api/video2/settings`
获取所有设置（敏感信息脱敏）

#### [NEW] `PUT /api/video2/settings`
更新设置：
```
PUT /api/video2/settings
Body: { key: string, value: any } 或 { settings: { key: value, ... } }
```

#### [NEW] `GET /api/video2/ai/usage`
获取AI费用统计：
```
GET /api/video2/ai/usage?period=month
Response: {
  totalCost: number,
  breakdown: { chat: number, image: number, video_split: number },
  modelStats: [{ model: string, tokens: number, cost: number }]
}
```

### 2.5 数据导出端点

#### [NEW] `GET /api/video2/projects/:id/export`
导出分镜脚本：
```
GET /api/video2/projects/:id/export?format=docx&includeImages=true
Response: application/vnd.openxmlformats-officedocument.wordprocessingml.document
```

**实现细节（使用 `docx` npm 包）：**
```javascript
// 1. 查询项目所有分镜（按 sceneId + shotIndex 排序）
// 2. 按场次分组
// 3. 生成 Word 文档：
//    - 标题页：项目名称、导出日期
//    - 每个场次一节
//    - 每个分镜一个表格行：
//      | 分镜序号 | 参考画面（缩略图） | 画面内容 | 景别 | 镜头运动 |
//      | 焦段 | 演员 | 道具 | 台词/旁白 | 灯光 | 备注 | 预估时长 |
//    - 参考画面：如果 includeImages=true，从 OSS 下载图片嵌入文档
// 4. 返回 .docx 文件流
```

### 2.6 OSS 路径变更（按项目ID分文件夹）

**OSS 路径结构变更：**
```
旧: qizi-store.oss-cn-beijing.aliyuncs.com/video2/{filename}
    qizi-store.oss-cn-beijing.aliyuncs.com/imges2/{filename}

新: {bucket}.oss-cn-beijing.aliyuncs.com/{projectId}/videos/{filename}
    {bucket}.oss-cn-beijing.aliyuncs.com/{projectId}/images/{filename}
    {bucket}.oss-cn-beijing.aliyuncs.com/{projectId}/scene_images/{filename}  (场景参考图)
```

修改 `server/index.js` 中所有上传函数的 OSS key 生成逻辑：
- 图片上传: `const ossKey = `${projectId}/images/${uniqueFilename}`;`
- 视频上传: `const ossKey = `${projectId}/videos/${uniqueFilename}`;`
- 场景图上传: `const ossKey = `${projectId}/scene_images/${uniqueFilename}`;`
- presign 端点也需同步修改

> [!IMPORTANT]
> **迁移注意**：旧 bucket 中的文件 URL 已被存储在数据库中，不应修改已有记录的 URL。新上传的文件使用新路径，旧文件保持旧 URL 可访问。

---

## 三、前端组件重构

### 3.1 文件拆分计划

当前 `Video2Page.tsx` 单文件 1827 行，需拆分为模块化组件：

```
src/
├── components/
│   ├── Video2Page.tsx              [MODIFY] 主页面容器（精简到 ~400 行）
│   ├── Video2ProjectList.tsx       [MODIFY] 项目列表（增加导出/设置入口）
│   ├── ConfirmDialog.tsx           保持
│   ├── WeChatShareHint.tsx         保持
│   ├── storyboard/                 [NEW] 分镜相关组件
│   │   ├── ShotCard.tsx            [NEW] 分镜卡片组件
│   │   ├── ShotDetailDialog.tsx    [NEW] 分镜详情编辑对话框
│   │   ├── MediaCarousel.tsx       [NEW] 参考画面轮播图组件
│   │   ├── MediaManagerDialog.tsx  [NEW] 参考画面管理对话框
│   │   ├── AddShotDialog.tsx       [NEW] 新增分镜对话框
│   │   ├── MergeShotsDialog.tsx    [NEW] 分镜合并对话框
│   │   ├── ShotFieldEditor.tsx     [NEW] 分镜字段行内编辑组件
│   │   └── VideoSplitDialog.tsx    [NEW] 视频分割对话框（手动+AI双模式）
│   ├── ai/                         [NEW] AI 功能组件
│   │   ├── AIScriptDialog.tsx      [NEW] AI 脚本分析对话框
│   │   ├── AIImageGenDialog.tsx    [NEW] AI 生图对话框
│   │   ├── AITaskProgress.tsx      [NEW] AI 任务进度显示
│   │   └── AIUsagePanel.tsx        [NEW] AI 费用统计面板
│   ├── settings/                   [NEW] 设置组件
│   │   └── SettingsDialog.tsx      [NEW] 系统设置对话框
│   └── export/                     [NEW] 导出组件
│       └── ExportDialog.tsx        [NEW] 导出选项对话框
├── lib/
│   ├── ossUtils.ts                 [MODIFY] 更新路径逻辑、压缩逻辑
│   ├── shareUtils.ts               保持
│   ├── videoCompressor.ts          [MODIFY] 优化压缩参数
│   ├── aiService.ts                [NEW] AI API 调用封装
│   └── types.ts                    [NEW] TypeScript 类型定义
```

### 3.2 TypeScript 类型定义 — [NEW] `types.ts`

```typescript
// 分镜数据结构（升级后的 MediaItem）
export interface Shot {
  id: number;
  // 原有字段
  title: string;           // 保留兼容
  filename: string;
  url: string;             // 第一个参考画面的 URL（向后兼容）
  type: 'image' | 'video';
  status: 'pending' | 'done';
  size: number;
  duration?: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deleted?: number;
  deletedAt?: string;
  projectId?: number;
  sceneId?: number;
  shotNo?: string;
  
  // 分镜新增字段
  sceneContent: string;     // 画面内容
  actors: string;           // 演员/角色
  props: string;            // 道具
  location: string;         // 拍摄地点
  focalLength: string;      // 镜头焦段
  narration: string;        // 旁白/台词
  cameraMovement: string;   // 镜头运动
  shotType: string;         // 景别
  shotAngle: string;        // 拍摄角度
  lighting: string;         // 灯光
  notes: string;            // 备注
  estimatedDuration: string;// 预估时长
  aiImagePrompt: string;    // AI 生图提示词（不展示）
  aiStylePrompt: string;    // AI 风格提示词（不展示）
  shotIndex: number;        // 分镜序号（不可编辑）
  mergedFrom: string;       // 合并来源
  
  // 关联数据
  media: ShotMedia[];       // 参考画面列表
}

export interface ShotMedia {
  id: number;
  shotId: number;
  url: string;
  type: 'image' | 'video';
  filename: string;
  size: number;
  duration?: number;
  sortOrder: number;
  source: 'upload' | 'ai_generated' | 'video_split';
}

export interface ModelConfig {
  model: string;
  quality?: string;
  provider: 'geekai' | 'siliconflow';
  cost: 'free' | 'low' | 'mid' | 'mid_high' | 'high';
  supportsImageRef?: boolean;
}

export interface Settings {
  llm_provider: string;
  llm_model: string;
  llm_fallback_chain: ModelConfig[];
  image_provider: string;
  image_model: string;
  image_quality: string;
  image_fallback_chain: ModelConfig[];
  geekai_api_key: string;
  siliconflow_api_key: string;
  default_image_size: string;
  export_include_images: boolean;
  export_format: string;
  video_target_bitrate_1080p: number;
  video_target_bitrate_720p: number;
  video_target_bitrate_480p: number;
  model_prices: Record<string, any>;
}
```

### 3.3 分镜卡片组件 — [NEW] `ShotCard.tsx`

**设计要点：**

```
┌─────────────────────────────────┐
│  [☐选择]    参考画面轮播区     [⛶全屏]│
│  ←  图片/视频  →  (轮播指示器)    │
│  [▶播放]  (视频时显示)           │
│  [未拍摄/已拍摄]       [编号 01]  │
├─────────────────────────────────┤
│  画面内容：xxxxx（可点击编辑）      │
│  分镜 #3                         │
│  ─ ─ ─ ─ ─ ─ ─ (折叠线) ─ ─ ─ │
│  ▼ 展开详情 (点击展开/折叠)        │
├─ (展开后) ─────────────────────┤
│  演员：xxx     道具：xxx          │
│  地点：xxx     焦段：xxx          │
│  景别：xxx     角度：xxx          │
│  镜头运动：xxx  灯光：xxx          │
│  旁白：xxx                       │
│  预估时长：xxx  备注：xxx          │
│  [管理参考画面]                   │
├─────────────────────────────────┤
│  [↑↓排序]  [🗑删除]              │
└─────────────────────────────────┘
```

**关键实现：**
1. **默认折叠状态**：显示参考画面 + 画面内容 + 分镜序号
2. **展开状态**：显示所有字段（可点击编辑），加"管理参考画面"按钮
3. **无参考画面时**：视频/图片区域高度变低（`aspect-[16/6]` 替代 `aspect-video`），显示"上传或AI生成参考画面"按钮
4. **轮播图**：使用 `MediaCarousel` 组件，支持左右滑动、点指示器
5. **视频播放**：轮播到视频时显示播放按钮，点击后在卡片内播放，按钮消失

### 3.4 参考画面轮播组件 — [NEW] `MediaCarousel.tsx`

```typescript
interface MediaCarouselProps {
  media: ShotMedia[];
  onPlayVideo?: (media: ShotMedia) => void;
  onFullscreen?: (media: ShotMedia) => void;
  autoPlay?: boolean;
}
```

**实现要点：**
- 手势滑动（Touch events for mobile）
- 点指示器（底部小圆点）
- 左右箭头按钮（hover 时显示）
- 视频项：显示 OSS 截图作为 poster + 中间播放按钮
- 播放视频时：切换为 `<video>` 元素直接播放，播放按钮消失

### 3.5 参考画面管理对话框 — [NEW] `MediaManagerDialog.tsx`

功能：
- 显示当前所有参考画面缩略图
- 每个缩略图有删除按钮
- 拖拽排序
- 上传新图片/视频
- AI 生成参考图（跳转到 AI 生图对话框）
- 显示 N/10 的计数器
- 支持上传场景参考图（单独区域，用于AI生图参考）

### 3.6 新增分镜的两种方式

**方式一：批量上传参考画面**
- 在现有上传对话框基础上修改
- 上传后每个文件创建一个分镜
- `sceneContent` 默认为文件名（去扩展名）
- 可点击修改 sceneContent

**方式二：点击"增加分镜"按钮**
- 弹出分镜管理对话框
- 表单包含所有分镜字段（无必填项）
- 包含"上传或AI生成参考画面"按钮
- 提交后创建分镜记录

### 3.7 分镜合并 — [NEW] `MergeShotsDialog.tsx`

- 当用户选择了多个分镜卡片时，在批量操作栏显示"合并分镜"按钮
- 点击后弹出确认对话框，显示：
  - 将合并的分镜列表
  - 合并后的参考画面总数（必须 ≤ 10）
  - 合并后的画面内容预览（拼接所有 sceneContent）
  - 其他字段的合并策略说明
- 确认后调用 `POST /api/video2/shots/merge`

### 3.8 视频分割对话框 — [NEW] `VideoSplitDialog.tsx`

```
┌──────────────────────────────────┐
│  视频分割为分镜              [×]   │
├──────────────────────────────────┤
│  选择分割方式：                    │
│  [手动标记分割] [AI自动分割]       │
│                                   │
│  ┌─────────────────────────────┐ │
│  │                             │ │
│  │      视频播放器区域          │ │
│  │                             │ │
│  └─────────────────────────────┘ │
│                                   │
│  时间轴：                          │
│  ──●────●────●────●────●──        │
│     分割点（可拖动调整）            │
│                                   │
│  [+ 添加分割点] [清除全部]         │
│                                   │
│  已标记 N 个分割点，将生成 N+1 个分镜│
│                                   │
│        [开始分割] [取消]          │
└──────────────────────────────────┘
```

**AI自动分割时的提示**：
```
⚠️ AI自动分割提示
• 处理时间较长（根据视频时长，约5-30分钟）
• 需要消耗较多AI tokens（预估费用：¥XX-XX）
• 分割结果可能需要手动调整
• ⚠️ 不建议自动分割时长过长的视频（>5分钟），
  建议使用手动标记分割以获得更精确的结果

是否继续？   [确定] [取消]
```

### 3.9 AI 脚本分析对话框 — [NEW] `AIScriptDialog.tsx`

```
┌──────────────────────────────────┐
│  AI 自动生成分镜            [×]   │
├──────────────────────────────────┤
│  选择输入方式：                    │
│  [拍摄/分镜脚本] [视频文案/旁白]   │
│                                   │
│  ┌─────────────────────────┐     │
│  │ 上传文件 (.txt/.docx)    │     │
│  │ 或直接粘贴文本           │     │
│  └─────────────────────────┘     │
│  ┌─────────────────────────┐     │
│  │                          │     │
│  │  (文本输入区)             │     │
│  │                          │     │
│  └─────────────────────────┘     │
│                                   │
│  ☐ 自动生成 AI 参考图              │
│  (不勾选则仅生成分镜数据)          │
│                                   │
│  使用模型：DeepSeek V3  ⓘ(费用低) │
│                                   │
│           [开始分析] [取消]        │
├──────── (分析中) ────────────────┤
│  ⏳ 正在分析脚本...  45%          │
│  已识别 12 个分镜                  │
├──────── (完成后) ────────────────┤
│  ✅ 分析完成！已生成 12 个分镜     │
│  预估费用：¥0.85                  │
│  [查看并确认] [取消]              │
└──────────────────────────────────┘
```

### 3.10 AI 生图对话框 — [NEW] `AIImageGenDialog.tsx`

```
┌──────────────────────────────────┐
│  AI 生成参考图               [×]  │
├──────────────────────────────────┤
│  画面内容：                        │
│  ┌─────────────────────────┐     │
│  │ （可编辑的画面描述）       │     │
│  └─────────────────────────┘     │
│                                   │
│  场景参考图（可选）：               │
│  ┌──────┐                         │
│  │ 上传 │  （帮助生成特定场景的图） │
│  └──────┘                         │
│                                   │
│  图片尺寸：[1024×576 (16:9) ▼]   │
│                                   │
│  使用模型：GPT-Image-2  ⓘ(费用中高)│
│                                   │
│         [生成参考图] [取消]        │
├──────── (生成中) ────────────────┤
│  ⏳ 正在生成参考图...              │
│  模型：GPT-Image-2 (medium)       │
│  预计时间：15-30秒                 │
├──────── (完成后) ────────────────┤
│  ✅ 生成完成！                     │
│  费用：¥0.08/张                   │
│  [添加到分镜] [重新生成]           │
└──────────────────────────────────┘
```

### 3.11 系统设置对话框 — [NEW] `SettingsDialog.tsx`

```
┌──────────────────────────────────┐
│  系统设置                   [×]   │
├──────────────────────────────────┤
│  ◆ AI 模型配置                    │
│                                   │
│  大语言模型平台：                  │
│  [GeekAI ▼] API Key: [sk-***]    │
│                                   │
│  首选文本模型：                    │
│  [DeepSeek V3 ▼] ⓘ 费用: ¥低     │
│                                   │
│  降级链（首选失败时按顺序尝试）：   │
│  1. DeepSeek V3 (GeekAI)  ¥低 [×]│
│  2. DeepSeek V3 (硅基流动) ¥低 [×]│
│  3. GPT-4o-mini (GeekAI)  ¥低 [×]│
│  4. GLM-4-Flash (GeekAI)  ¥免费[×]│
│  [+ 添加降级模型]                  │
│                                   │
│  首选生图模型：                    │
│  [GPT-Image-2 (medium) ▼] ⓘ ¥中高 │
│                                   │
│  降级链：                          │
│  1. GPT-Image-2 (medium)  ¥中高[×]│
│  2. Z-Image-Turbo         ¥低  [×]│
│  3. Nano Banana 2        ¥中  [×]│
│  4. CogView-4            ¥中  [×]│
│  [+ 添加降级模型]                  │
│                                   │
│  ─────────────────────────────── │
│  ◆ 视频压缩设置                    │
│  1080p 目标码率：[3000] kbps      │
│  720p 目标码率： [2000] kbps      │
│  480p 目标码率： [1000] kbps      │
│                                   │
│  ─────────────────────────────── │
│  ◆ 导出设置                       │
│  默认导出格式：[Word (.docx) ▼]   │
│  ☑ 导出时包含参考画面               │
│                                   │
│  ─────────────────────────────── │
│  ◆ 默认参考图尺寸                  │
│  [1024×576 (16:9) ▼]             │
│                                   │
│  ─────────────────────────────── │
│  ◆ AI 费用统计                    │
│  本月总费用：¥12.50                │
│  [查看详细统计]                    │
│                                   │
│              [保存设置] [取消]     │
└──────────────────────────────────┘
```

### 3.12 AI 费用统计面板 — [NEW] `AIUsagePanel.tsx`

```
┌──────────────────────────────────┐
│  💰 AI费用统计              [×]   │
├──────────────────────────────────┤
│  统计时间范围：[本月 ▼]           │
│                                   │
│  总费用：¥12.50                   │
│                                   │
│  分类统计：                        │
│  ┌─────────────────────────────┐ │
│  │ 脚本分析      ¥5.20  [████  ] │ │
│  │ 参考图生成    ¥7.30  [██████] │ │
│  │ 视频分割      ¥0.00  [      ] │ │
│  └─────────────────────────────┘ │
│                                   │
│  模型使用排行：                    │
│  1. DeepSeek V3     125K tokens  ¥3.50│
│  2. GPT-Image-2     15 张        ¥1.20│
│  3. Z-Image-Turbo   12 张        ¥0.24│
│                                   │
│  [导出账单]                       │
└──────────────────────────────────┘
```

---

## 四、视频压缩方案升级

### 4.1 当前方案分析（参考 qizi-website 实现）

现有压缩方式：
- 浏览器端 FFmpeg WASM：用于大文件（>95MB）绕过 Cloudflare 限制
- 服务端 ffmpeg：用于小文件（≤95MB）
- 目标码率：固定 3000kbps

### 4.2 升级方案

#### 4.2.1 码率检测升级

```
上传前检测流程：
1. 检测视频分辨率（1080p / 720p / 480p）
2. 检测当前码率
3. 根据分辨率确定目标码率
4. 如果当前码率 > 目标码率 → 必须压缩
5. 如果当前码率 ≤ 目标码率 → 直传
```

动态目标码率：
| 分辨率 | 目标码率 | 说明 |
|--------|---------|------|
| 1080p (1920×1080) | 3000 kbps | 高清，平衡质量与大小 |
| 720p (1280×720) | 2000 kbps | 标清，适合网络传输 |
| 480p (854×480) | 1000 kbps | 流畅，节省空间 |

#### 4.2.2 压缩策略（禁止跳过）

```
用户选择视频
    ↓
检测分辨率 + 码率
    ├─ 码率 ≤ 目标码率 → 直接上传
    └─ 码率 > 目标码率 → 必须压缩
                            ↓
                    选择压缩方式：
                    ├─ 文件 ≤ 95MB → 服务端压缩（推荐，快）
                    └─ 文件 > 95MB → 浏览器WASM压缩
```

> 不提供"跳过压缩直接上传"选项，高码率视频必须压缩

#### 4.2.3 移动端兼容性

| 环境 | 支持情况 | 策略 |
|------|---------|------|
| iOS Safari | ✅ 支持 | 可用，但性能较慢 |
| 安卓 Chrome | ✅ 支持 | 正常使用 |
| iOS微信 | ⚠️ 基本支持 | WKWebView，内存限制严，建议限制文件≤50MB |
| 安卓微信 | ✅ 支持 | 正常使用 |

**移动端提示**：
```
⚠️ 移动端压缩提示
• 移动端压缩速度较慢且耗电
• 建议使用电脑进行视频压缩
• 大文件可能导致页面卡顿或崩溃
• 正在压缩，请勿关闭页面
```

---

## 五、执行步骤与优先级

### Phase 1：基础架构（预估 2-3 天）

- [ ] 数据库 Schema 升级（新增列 + shot_media 表 + settings 表 + ai_tasks 表 + ai_usage_logs 表）
- [ ] 数据迁移脚本
- [ ] TypeScript 类型定义 `types.ts`
- [ ] OSS 路径变更（按项目ID分文件夹 + 向后兼容）
- [ ] AI API 封装（参考 qizi-website 实现，使用 fetch）
- [ ] 费用统计函数实现

### Phase 2：分镜卡片核心（预估 3-4 天）

- [ ] 分镜 CRUD API 升级
- [ ] 参考画面管理 API (`shot_media` CRUD)
- [ ] `ShotCard.tsx` 组件（含折叠/展开、字段编辑）
- [ ] `MediaCarousel.tsx` 轮播图组件
- [ ] `MediaManagerDialog.tsx` 参考画面管理对话框
- [ ] `AddShotDialog.tsx` 新增分镜对话框
- [ ] 两种新增方式：上传 + 手动创建
- [ ] 分镜合并功能
- [ ] `Video2Page.tsx` 重构（集成新组件）

### Phase 3：AI 功能（预估 3-4 天）

- [ ] AI 脚本解析 API + 降级链 + 费用记录
- [ ] `AIScriptDialog.tsx` 对话框
- [ ] AI 生成参考图 API（支持场景图参考）
- [ ] `AIImageGenDialog.tsx` 对话框
- [ ] 视频分割 API（手动 + AI 双模式）
- [ ] `VideoSplitDialog.tsx` 对话框
- [ ] AI 任务进度追踪
- [ ] 费用统计面板

### Phase 4：辅助功能（预估 1-2 天）

- [ ] `SettingsDialog.tsx` 系统设置
- [ ] 数据导出 API + `ExportDialog.tsx`
- [ ] 视频压缩逻辑升级（动态码率、禁止跳过）
- [ ] 项目列表页更新（增加设置/导出/费用入口）

### Phase 5：测试与优化（预估 1 天）

- [ ] 数据库迁移回归测试
- [ ] 全功能联调测试
- [ ] 移动端适配验证
- [ ] 微信浏览器兼容性测试

---

## 六、验证计划

### 自动化测试
- 数据库迁移脚本：验证旧数据正确迁移到新 schema
- API 端点：使用 curl/Postman 测试所有新端点
- AI API 集成：验证 GeekAI/SiliconFlow API 调用和降级链
- 费用统计：验证 token 记录和费用计算准确性

### 手动验证
- [ ] 分镜卡片：创建、编辑、删除、排序、合并
- [ ] 参考画面：上传、AI生成、排序、删除、轮播展示
- [ ] AI 脚本分析：上传脚本文件、粘贴文本，验证分镜生成结果
- [ ] AI 参考图生成：验证 prompt 生成、场景图参考、图片质量
- [ ] 视频分割：手动标记模式 + AI自动分割模式
- [ ] 数据导出：验证 Word 文档格式和内容完整性
- [ ] 系统设置：验证模型切换和降级链配置
- [ ] 费用统计：验证 token 记录和费用计算
- [ ] OSS：验证新文件按项目ID分文件夹 + 旧文件仍可访问
- [ ] 视频压缩：验证动态码率、禁止跳过、移动端兼容性
- [ ] 移动端：分镜卡片折叠/展开、轮播手势
- [ ] 微信：视频播放兼容性

---

## 七、关键技术实现细节

### 7.1 AI 调用模式（带降级链）

参考 qizi-website 现有 [callGeekAIModel](file:///C:/Users/jimin/Documents/qizi-website/server/server.js#L1636-L1698) 实现方式，使用 fetch 直接调用 API：

```javascript
// server/lib/aiClient.js

const GEEKAI_BASE = 'https://geekai.co/api/v1';
const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1';

// 获取 API Key
function getApiKey(provider, settings) {
  if (provider === 'siliconflow') {
    return settings.siliconflow_api_key || process.env.SILICONFLOW_API_KEY;
  }
  return settings.geekai_api_key || process.env.GEEKAI_API_KEY;
}

// 文本模型调用
async function callChatWithFallback(messages, fallbackChain, settings, options = {}) {
  for (const item of fallbackChain) {
    const { model, provider } = item;
    const baseUrl = provider === 'siliconflow' ? SILICONFLOW_BASE : GEEKAI_BASE;
    const apiKey = getApiKey(provider, settings);
    
    if (!apiKey) continue;
    
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature || 0.3,
          max_tokens: options.max_tokens || 8192,
          stream: false,
          ...(options.json ? { response_format: { type: "json_object" } } : {})
        }),
        signal: AbortSignal.timeout(options.timeoutMs || 120000)
      });
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const usage = data.usage || {};
      
      // 记录费用
      await recordUsage({
        type: 'chat', model, provider,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        taskId: options.taskId
      }, settings);
      
      return { model, provider, content: data.choices[0].message.content, usage };
    } catch (err) {
      console.warn(`[AI Chat] ${provider}/${model} 失败: ${err.message}`);
      continue;
    }
  }
  throw new Error('所有文本模型均调用失败');
}

// 图像生成调用
async function callImageWithFallback(prompt, fallbackChain, settings, options = {}) {
  const { sceneImageUrl, size = '1024x576', taskId } = options;
  
  for (const item of fallbackChain) {
    const { model, quality = 'standard', provider, supportsImageRef } = item;
    const baseUrl = provider === 'siliconflow' ? SILICONFLOW_BASE : GEEKAI_BASE;
    const apiKey = getApiKey(provider, settings);
    
    if (!apiKey) continue;
    
    try {
      let finalPrompt = prompt;
      let imageUrl;
      
      if (sceneImageUrl && supportsImageRef) {
        // 图生图模式（模型支持图片参考）
        const result = await callImageGenWithRef(model, finalPrompt, sceneImageUrl, quality, size, baseUrl, apiKey);
        imageUrl = result.url;
      } else if (sceneImageUrl && !supportsImageRef) {
        // 兜底：先用LLM分析场景，再文生图
        const sceneDesc = await analyzeSceneImage(sceneImageUrl, settings);
        finalPrompt = `${sceneDesc}, ${prompt}`;
        const result = await callImageGen(model, finalPrompt, quality, size, baseUrl, apiKey);
        imageUrl = result.url;
      } else {
        // 普通文生图
        const result = await callImageGen(model, finalPrompt, quality, size, baseUrl, apiKey);
        imageUrl = result.url;
      }
      
      // 记录费用
      await recordUsage({
        type: 'image', model, provider,
        imageCount: 1, taskId
      }, settings);
      
      return { model, provider, url: imageUrl };
    } catch (err) {
      console.warn(`[AI Image] ${provider}/${model} 失败: ${err.message}`);
      continue;
    }
  }
  throw new Error('所有图片模型均调用失败');
}

// 文生图 API 调用（兼容多种返回格式）
async function callImageGen(model, prompt, quality, size, baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model, prompt, size, quality,
      watermark: false, n: 1, response_format: 'url'
    }),
    signal: AbortSignal.timeout(60000)
  });
  
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  
  // 兼容多种返回格式
  if (data.data?.[0]?.url) return { url: data.data[0].url };
  if (data.url) return { url: data.url };
  if (data.output?.url) return { url: data.output.url };
  if (data.images?.[0]?.url) return { url: data.images[0].url };
  
  throw new Error('返回数据格式异常，无法提取图片URL');
}
```

### 7.2 费用计算与记录

```javascript
// server/lib/aiClient.js

function calculateCost(type, model, usage, modelPrices) {
  const price = modelPrices[model];
  if (!price) return 0;
  
  if (type === 'image') {
    // 找匹配的质量档位
    const qualityKeys = Object.keys(price).filter(k => k.startsWith('per_image'));
    if (qualityKeys.length > 0) {
      return price[qualityKeys[0]] * (usage.imageCount || 1);
    }
    return 0;
  }
  
  if (type === 'chat') {
    const inputCost = (usage.promptTokens || 0) * (price.input || 0) / 1000;
    const outputCost = (usage.completionTokens || 0) * (price.output || 0) / 1000;
    return inputCost + outputCost;
  }
  
  return 0;
}

async function recordUsage(usageData, settings) {
  try {
    const modelPrices = settings.model_prices || {};
    const estimatedCost = calculateCost(usageData.type, usageData.model, usageData, modelPrices);
    
    db.run(`INSERT INTO ai_usage_logs 
      (taskId, type, model, provider, promptTokens, completionTokens, totalTokens, imageCount, estimatedCost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        usageData.taskId || null,
        usageData.type,
        usageData.model,
        usageData.provider,
        usageData.promptTokens || 0,
        usageData.completionTokens || 0,
        usageData.totalTokens || 0,
        usageData.imageCount || 0,
        estimatedCost
      ]
    );
  } catch (err) {
    console.error('[Usage Log] 记录失败:', err.message);
  }
}
```

### 7.3 脚本解析 Prompt 设计

```javascript
const SCRIPT_ANALYSIS_PROMPT = `你是一个专业的影视分镜脚本分析师。

## 任务
分析用户提供的拍摄脚本/视频文案，拆解为分镜列表。

## 输出格式
返回一个 JSON 对象，包含 "shots" 数组，每个元素为：
{
  "sceneContent": "画面内容的详细描述",
  "actors": "出场演员或角色",
  "props": "需要的道具",
  "location": "拍摄地点",
  "focalLength": "建议焦段（如 35mm, 50mm, 85mm, 24mm）",
  "narration": "旁白或台词",
  "cameraMovement": "镜头运动（推/拉/摇/移/跟/升降/固定/手持）",
  "shotType": "景别（远景/全景/中景/近景/特写/大特写）",
  "shotAngle": "角度（平拍/俯拍/仰拍/主观/客观）",
  "lighting": "灯光要求",
  "notes": "拍摄备注",
  "estimatedDuration": "预估时长（秒数）",
  "aiImagePrompt": "英文的AI图像生成提示词，应该是专业的、适合文生图模型的描述，包含场景、人物、光线、构图等视觉要素"
}

## 规则
1. 如果脚本中某个字段没有提及，填空字符串""
2. aiImagePrompt 必须是英文，描述要具体、视觉化
3. 按脚本中的顺序排列分镜
4. 每个镜头应该是一个独立的画面单位
5. 注意区分对话/旁白和画面描述`;
```

### 7.4 Word 导出格式

使用 `docx` 包生成专业的拍摄脚本文档：

```javascript
// 每个分镜生成一个表格
// 列：序号 | 参考画面 | 画面内容 | 景别+角度 | 焦段 | 镜头运动 |
//     演员 | 道具 | 台词旁白 | 灯光 | 地点 | 备注 | 时长
// 参考画面列支持嵌入缩略图（从 OSS 下载后嵌入）
```

### 7.5 长时操作用户提示规范

所有耗时操作必须显示清晰的进度和提示：

```
┌──────────────────────────────────┐
│  ⏳ 正在处理...                   │
├──────────────────────────────────┤
│  [████████░░░░░░░░] 45%          │
│                                   │
│  当前阶段：正在分析脚本内容        │
│  预估剩余时间：约 2 分钟           │
│                                   │
│  ℹ️ 提示：                        │
│  - AI正在识别分镜结构             │
│  - 已识别 8 个分镜                │
│  - 请勿关闭页面                   │
│                                   │
│  [取消处理]                       │
└──────────────────────────────────┘
```

各操作提示内容：

| 操作类型 | 提示内容 | 预估时间 |
|---------|---------|---------|
| AI脚本分析 | "正在分析脚本...已识别X个分镜" | 1-3分钟 |
| AI生成参考图 | "正在生成参考图...模型：XXX" | 10-60秒 |
| AI视频分割 | "正在分析视频关键帧...进度X%" | 5-30分钟 |
| 视频压缩（服务端） | "正在压缩视频...当前进度X%" | 1-5分钟 |
| 视频压缩（浏览器） | "正在浏览器中压缩视频...请勿关闭页面" | 根据文件大小 |
| 图片压缩 | "正在优化图片..." | 1-5秒 |
