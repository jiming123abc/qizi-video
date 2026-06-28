# 棋子视频 技术文档

## 1. 项目概述

**项目名称**：棋子视频（qizi-video）

**网站地址**：https://video.qiziwenhua.top

**项目描述**：基于 React + Express 的视频分镜管理系统，支持 AI 生成分镜、视频分割、媒体管理等功能。

---

## 2. 服务器信息

| 项目 | 值 |
|------|-----|
| IP 地址 | 45.77.46.164 |
| 地理位置 | 新加坡 |
| 操作系统 | Ubuntu 22.04.5 LTS |
| SSH 用户 | root |
| 项目路径 | /var/www/qizi-video |
| CDN | Cloudflare |

---

## 3. 技术栈

### 前端
- **框架**：React 19
- **构建工具**：Vite 6
- **语言**：TypeScript 5.8
- **样式**：Tailwind CSS 4
- **动画**：Motion
- **图标**：Lucide React
- **视频处理**：@ffmpeg/ffmpeg

### 后端
- **框架**：Express 4
- **运行时**：Node.js 20.20.2
- **数据库**：SQLite（两个库）
  - `server/video2.db` — 视频分镜主数据库
  - `server/data.db` — 旧企业官网数据库（已废弃）
- **文件上传**：Multer
- **图片处理**：Sharp
- **AI 集成**：GeekAI / SiliconFlow（双供应商降级）/ Google Gemini

### 基础设施
- **进程管理**：PM2
- **Web 服务器**：Nginx（主站）+ Cloudflare CDN（video 子域名）
- **SSL**：Let's Encrypt
- **对象存储**：阿里云 OSS

---

## 4. 部署架构

### 4.1 进程管理（PM2）

| 进程名 | 端口 | 状态 | 说明 |
|--------|------|------|------|
| qizi-video-server | 3001 | ✅ online | 棋子视频主服务（本项目） |
| qizi-website-server | 5000 | ✅ online | 企业官网服务 |

**PM2 配置文件**：`/var/www/qizi-video/ecosystem.config.cjs`

```javascript
module.exports = {
  apps: [{
    name: 'qizi-video-server',
    script: './server/index.js',
    cwd: './',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
```

**常用 PM2 命令**：
```bash
pm2 status                    # 查看状态
pm2 logs qizi-video-server    # 查看日志
pm2 restart qizi-video-server # 重启服务
pm2 stop qizi-video-server    # 停止服务
pm2 monit                     # 监控面板
```

### 4.2 Nginx 配置

**主站配置文件**：`/etc/nginx/sites-available/qizi-website`

主站（qiziwenhua.top）使用 Nginx 全代理模式，转发到 5000 端口（企业官网）。

**video 子域名**：通过 Cloudflare CDN 直接解析到服务器，绕过 Nginx，直接访问 3001 端口的 Express 服务。

**Nginx 常用命令**：
```bash
nginx -t                  # 测试配置
nginx -s reload           # 重载配置
systemctl status nginx    # 查看状态
```

### 4.3 Cloudflare CDN

video.qiziwenhua.top 启用了 Cloudflare CDN：
- 提供 DDoS 防护
- 静态资源缓存
- HTTP/3 支持
- 全球加速

---

## 5. 项目结构

```
qizi-video/
├── src/                    # 前端源码
│   ├── pages/              # 页面级组件
│   │   ├── StoryboardPage.tsx    # 分镜主页面（原 Video2Page）
│   │   └── ProjectListPage.tsx   # 项目列表页（原 Video2ProjectList）
│   ├── components/         # React 组件
│   │   ├── storyboard/     # 分镜相关组件
│   │   │   ├── ShotCard.tsx
│   │   │   ├── ShotSearchBar.tsx
│   │   │   ├── ShotSkeleton.tsx
│   │   │   ├── EmptyState.tsx
│   │   │   ├── BottomTabBar.tsx
│   │   │   ├── MediaCarousel.tsx
│   │   │   ├── MediaManagerDialog.tsx
│   │   │   ├── AddShotDialog.tsx
│   │   │   ├── VideoSplitDialog.tsx
│   │   │   ├── VideoCompressionDialog.tsx
│   │   │   ├── SceneTabs.tsx        # 场次标签栏
│   │   │   ├── SceneManager.tsx     # 场次管理面板
│   │   │   ├── UploadDialog.tsx     # 上传对话框
│   │   │   └── MediaFullscreen.tsx  # 全屏媒体预览
│   │   ├── ai/             # AI 相关组件
│   │   ├── settings/       # 设置相关
│   │   └── ui/             # 通用 UI 组件
│   ├── hooks/              # 自定义 Hooks
│   │   ├── useUpload.ts           # 上传逻辑 hook
│   │   ├── useShots.ts
│   │   ├── useScenes.ts
│   │   ├── useSignedUrl.ts
│   │   ├── useToast.ts
│   │   └── useEscapeKey.ts
│   ├── lib/                # 工具函数和类型定义
│   │   ├── auth.ts               # 鉴权工具
│   │   ├── taskStream.ts         # SSE 任务订阅
│   │   ├── ossUtils.ts
│   │   ├── shareUtils.ts
│   │   ├── types.ts
│   │   ├── utils.ts
│   │   └── videoCompressor.ts
│   ├── App.tsx             # 根组件
│   └── main.tsx            # 入口文件
├── server/                 # 后端源码
│   ├── index.js            # 服务入口
│   ├── database.js         # 数据库操作
│   ├── aiClient.js         # AI 客户端（多供应商降级）
│   ├── video2.db           # 主数据库
│   └── data.db             # 旧数据库（已废弃）
├── dist/                   # 前端构建产物
├── public/                 # 静态资源
├── logs/                   # PM2 日志
├── ecosystem.config.cjs    # PM2 配置
├── vite.config.ts          # Vite 配置
├── tsconfig.json           # TypeScript 配置
└── package.json            # 项目依赖
```

---

## 6. 数据库结构

### 6.1 video2.db（主数据库）

**核心表**：
- `video2_projects` — 项目表
- `video2_scenes` — 场次表
- `videos` — 分镜表（shots）
- `shot_media` — 分镜媒体文件表
- `video2_items` — 媒体素材表
- `video2_tasks` — 异步任务表（视频压缩等）
- `video2_settings` — 系统设置表（API Key 等）
- `video2_ai_usage` — AI 使用记录表
- `video2_ai_tasks` — AI 任务表

### 6.2 data.db（已废弃）

企业官网旧表，不再使用，仅保留代码参考：
- `portfolio_items`
- `featured_works`
- `home_content`
- `team_members`
- `categories_details`

---

## 7. API 接口

### 7.1 接口前缀

统一前缀：`/api/video2/`

> 历史遗留：早期接口使用 `/api/video2/` 但部分操作接口使用 `/api/video2/shots/` 前缀，已统一。旧路由仍保留（带 deprecation 警告）以兼容历史代码。

### 7.2 主要接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/video2/projects` | 项目列表 |
| POST | `/api/video2/projects` | 创建项目 |
| GET | `/api/video2/projects/:id` | 项目详情 |
| PUT | `/api/video2/projects/:id` | 更新项目 |
| DELETE | `/api/video2/projects/:id` | 删除项目 |
| GET | `/api/video2/projects/:id/scenes` | 场次列表 |
| POST | `/api/video2/projects/:id/scenes` | 创建场次 |
| GET | `/api/video2/shots` | 分镜列表 |
| POST | `/api/video2/shots` | 创建分镜 |
| GET | `/api/video2/shots/:id` | 分镜详情 |
| PUT | `/api/video2/shots/:id` | 更新分镜 |
| DELETE | `/api/video2/shots/:id` | 删除分镜 |
| PUT | `/api/video2/shots/:id/status` | 更新分镜状态 |
| POST | `/api/video2/upload/image` | 图片上传 |
| POST | `/api/video2/upload/video` | 视频上传（异步） |
| POST | `/api/video2/from-url` | URL 转存 |
| GET | `/api/video2/stats` | 统计数据 |
| GET | `/api/video2/settings` | 获取系统设置（API Key 脱敏） |
| PUT | `/api/video2/settings` | 更新系统设置 |
| GET | `/api/video2/ai/usage` | AI 费用统计 |
| POST | `/api/video2/ai/parse-script` | AI 脚本解析生成分镜（异步） |
| POST | `/api/video2/ai/generate-image` | AI 图片生成（参考图模式） |
| GET | `/api/video2/ai/task/:taskId` | 查询 AI 任务状态 |

---

## 8. 环境变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| PORT | 后端端口 | 3001 |
| NODE_ENV | 运行环境 | production |
| REACT_APP_OSS_ACCESS_KEY_ID | 阿里云 OSS AccessKey | LTAI5t6... |
| REACT_APP_OSS_ACCESS_KEY_SECRET | 阿里云 OSS Secret | tDp7cc... |
| REACT_APP_OSS_BUCKET | OSS Bucket 名 | qizi-store |
| REACT_APP_OSS_REGION | OSS 区域 | oss-cn-beijing |
| GEMINI_API_KEY | Google Gemini API Key | （可选） |
| GEEKAI_API_KEY | GeekAI API Key | sk-DbD0R... |
| SILICONFLOW_API_KEY | 硅基流动 SiliconFlow API Key | sk-xolj... |
| WECHAT_APP_ID | 微信 AppID | （可选） |
| WECHAT_APP_SECRET | 微信 AppSecret | （可选） |

> ⚠️ 安全注意：前端代码中不应直接使用 OSS AccessKey，所有上传应通过后端签名接口进行。
>
> 💡 AI 供应商说明：优先使用 GeekAI，SiliconFlow 作为降级备选。也可在前端设置页面中手动配置（存入数据库，优先级高于环境变量）。

---

## 9. 部署流程

### 9.1 手动部署

```bash
# 1. 连接服务器
ssh root@45.77.46.164

# 2. 进入项目目录
cd /var/www/qizi-video

# 3. 拉取最新代码
git pull origin main

# 4. 安装依赖
npm install

# 5. 构建前端
npm run build

# 6. 重启服务
pm2 restart qizi-video-server
```

### 9.2 本地开发

```bash
# 安装依赖
npm install

# 启动前端开发服务器（端口 3002）
npm run dev

# 启动后端（需单独配置）
node server/index.js
```

---

## 10. 常用排查命令

```bash
# 查看服务状态
pm2 status

# 查看实时日志
pm2 logs qizi-video-server --lines 100

# 查看错误日志
pm2 logs qizi-video-server --err

# 查看端口占用
ss -tlnp | grep -E '3001|5000'

# 查看磁盘空间
df -h

# 查看内存使用
free -h

# 测试接口
curl http://127.0.0.1:3001/api/video2/stats
```

---

## 11. 关键技术点

### 11.1 视频上传流程
1. 前端选择视频文件
2. 后端接收到文件后，判断是否需要压缩（码率 > 2Mbps）
3. 如需压缩，创建异步任务，立即返回任务 ID
4. 前端轮询任务状态
5. 压缩完成后，上传到阿里云 OSS
6. 创建分镜和媒体记录

### 11.2 AI 功能架构

**AI 客户端**：`server/aiClient.js`

#### 双供应商降级机制
- **GeekAI**（首选）：`https://geekai.co/api/v1`
- **SiliconFlow**（备选降级）：`https://api.siliconflow.cn/v1`
- API Key 读取优先级：数据库设置 > 环境变量

#### 支持的模型
| 模型 | 供应商 | 用途 |
|------|--------|------|
| deepseek-chat | GeekAI/SiliconFlow | 脚本解析、文本生成 |
| gpt-4o-mini | GeekAI | 备用文本模型 |
| flux-schnell | SiliconFlow | 文生图 |
| realvis-xl-v4.0-turbo | SiliconFlow | 图生图（参考图模式） |

#### AI 功能列表
- **AI 脚本解析**：上传脚本文件或粘贴文本，自动生成分镜（场次 + 分镜 + 画面内容）
- **AI 图片生成**：文生图 / 图生图（带场景参考图），生成后关联到对应分镜
- **AI 费用统计**：按天/月统计 token 消耗和费用
- **设置面板**：前端可配置各供应商 API Key（脱敏展示）

### 11.3 分镜管理
- 支持场次（scene）分组
- 支持拖拽排序
- 支持批量操作（移动、删除、合并）
- 支持状态切换（待拍摄 / 已拍摄）
- 支持搜索和筛选

### 11.4 API 鉴权体系

#### 当前方案：管理员 Token 模式

基于 `ADMIN_TOKEN` 环境变量的简单鉴权，适合单人/小团队使用。

**鉴权开关**：
- 未设置 `ADMIN_TOKEN`（默认）：所有接口公开访问
- 设置 `ADMIN_TOKEN` 后：写操作需要 token

**鉴权规则**：

| 请求方法 | 是否需要鉴权 | 说明 |
|----------|-------------|------|
| GET | ❌ 不需要 | 读取操作公开 |
| POST / PUT / DELETE | ✅ 需要 | 写入操作需验证 |

**例外接口**（始终公开）：
- `GET /api/video2/auth/check` — 检查鉴权状态
- `POST /api/video2/auth/login` — 管理员登录

**Token 传递方式**（二选一）：
```
x-admin-token: your_token
Authorization: Bearer your_token
```

**核心代码**：
- 后端中间件：`server/index.js` 中的 `requireAuth` 函数
- 前端拦截器：`src/lib/auth.ts` 中的 fetch 拦截（自动添加 token 头）
- 前端 UI：`src/components/settings/SettingsDialog.tsx` 中的管理员登录区

#### 未来扩展：用户系统方案

当前架构为接入用户系统预留了平滑扩展路径，无需推翻重写。

**演进路线**：

```
阶段1（当前）    阶段2           阶段3
单管理员 Token → 多用户登录   → 角色权限(RBAC)
所有人可读写  → 登录才能操作  → 不同角色不同权限
```

**改造步骤**：

1. **数据库新增用户表**
   ```sql
   CREATE TABLE users (
     id TEXT PRIMARY KEY,
     username TEXT UNIQUE NOT NULL,
     passwordHash TEXT NOT NULL,
     role TEXT DEFAULT 'user', -- user / admin
     createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
   );
   ```

2. **替换 `requireAuth` 中间件**
   - 从验证 `x-admin-token` 改为验证 JWT 或 Session Cookie
   - 解析出用户信息后挂载到 `req.user`
   - 示例：
   ```javascript
   const requireAuth = async (req, res, next) => {
     const token = req.headers.authorization?.replace('Bearer ', '');
     if (!token) return res.status(401).json({ error: '未登录' });
     
     try {
       const payload = jwt.verify(token, JWT_SECRET);
       const user = await db.users.getById(payload.userId);
       if (!user) return res.status(401).json({ error: '用户不存在' });
       req.user = user;
       next();
     } catch {
       return res.status(401).json({ error: 'Token 无效' });
     }
   };
   ```

3. **数据权限隔离（可选）**
   - 在查询层增加 `userId` 过滤，确保用户只能看到自己的数据
   - 管理员角色可查看所有数据

4. **前端适配**
   - 管理员登录页改为通用登录/注册页
   - 存储 JWT 替代当前的 admin token
   - fetch 拦截器逻辑不变（只需改 header 名称）

**兼容策略**：
- 可保留 `ADMIN_TOKEN` 作为超级管理员后门
- 新老鉴权方式可共存一段时间，逐步迁移
- 中间件接口保持一致，业务代码无需改动

### 11.5 SSE 任务推送

使用 Server-Sent Events 实现 AI 任务状态实时推送。

**端点**：`GET /api/video2/ai/task/:taskId/stream`

**架构**：
- 后端：`EventEmitter` 作为事件总线，任务更新时 emit 事件
- Monkey-patch `db.video2AiTasks.update`，每次更新自动发事件
- 前端：`EventSource` 监听，失败时自动回退到轮询

**优点**：
- 比轮询更高效、延迟更低
- 比 WebSocket 更轻量，基于 HTTP，无需额外协议
- 天然支持降级（SSE 不可用时自动回退轮询）

**前端工具**：`src/lib/taskStream.ts` 中的 `subscribeToTask` 函数

---

## 12. 重构记录

### 2026-06-28 重命名与代码拆分重构

**目标**：移除 Video2 前缀，拆分大文件，提升代码可维护性。

**完成内容**：

#### 程序名修改
- "柒子文化拍摄辅助" → "柒子文化AI拍摄辅助系统"
- 涉及文件：index.html、scripts/postbuild.cjs、server/index.js、前端组件

#### 文件重命名与目录调整
| 旧路径 | 新路径 | 说明 |
|--------|--------|------|
| `src/components/Video2Page.tsx` | `src/pages/StoryboardPage.tsx` | 分镜主页面 |
| `src/components/Video2ProjectList.tsx` | `src/pages/ProjectListPage.tsx` | 项目列表页 |
| `src/components/VideoCompressionDialog.tsx` | `src/components/storyboard/VideoCompressionDialog.tsx` | 移入 storyboard 目录 |
| `src/main-video2.tsx` | `src/main.tsx` | 统一入口文件 |
| `Video2App` (组件名) | `App` | 根组件重命名 |

#### StoryboardPage 拆分
**原文件行数**：2214 行 → **重构后**：1674 行（减少 24.4%）

**新增组件/Hook**：
- `src/hooks/useUpload.ts` — 上传逻辑 hook（文件/URL上传、压缩处理、进度管理）
- `src/components/storyboard/SceneTabs.tsx` — 场次标签栏组件
- `src/components/storyboard/SceneManager.tsx` — 场次管理面板组件
- `src/components/storyboard/UploadDialog.tsx` — 上传对话框组件
- `src/components/storyboard/MediaFullscreen.tsx` — 全屏媒体预览组件

**保留在 StoryboardPage 中的内容**：
- 页面整体布局和状态管理
- 顶层数据加载（项目信息、统计数据）
- 对话框开关状态管理
- 视频分割专用上传逻辑
- URL 输入验证逻辑

---

## 13. GitHub 仓库

**仓库地址**：https://github.com/jiming123abc/qizi-video

**默认分支**：main

**本地关联**：`origin` → `https://github.com/jiming123abc/qizi-video.git`

---

*最后更新：2026-06-28*
