# qizi-video

柒子文化视频拍摄辅助系统 - 独立子站

## 项目简介

基于 React + Express + SQLite 的视频拍摄项目管理工具，支持多项目管理、场次管理、图片/视频上传、微信分享等功能。

## 技术栈

- **前端**: React 19 + TypeScript + Vite + Tailwind CSS
- **后端**: Express.js + SQLite
- **存储**: Alibaba Cloud OSS
- **部署**: PM2 + Nginx

## 功能特性

- 多项目管理
- 场次（场景）管理
- 图片/视频批量上传
- 镜头编号管理
- 已拍摄/未拍摄状态管理
- 微信分享支持
- 视频压缩（ffmpeg）

## 快速开始

### 安装依赖

```bash
# 前端依赖
npm install

# 后端依赖
cd server
npm install
cd ..
```

### 配置环境变量

复制 `.env.example` 为 `.env` 并填入配置：

```bash
cp .env.example .env
```

### 开发模式

```bash
# 启动前端开发服务器（端口 3002）
npm run dev

# 启动后端服务（端口 3001）
cd server && npm start
```

### 生产构建

```bash
# 构建前端
npm run build

# 启动后端（同时托管前端静态文件）
cd server && npm start
```

## 部署

使用 PM2 部署：

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## 目录结构

```
qizi-video/
├── src/                    # 前端源码
│   ├── components/         # React 组件
│   ├── lib/                # 工具函数
│   ├── App.tsx             # 主应用组件
│   ├── main.tsx            # 入口文件
│   └── index.css           # 全局样式
├── server/                 # 后端源码
│   ├── index.js            # 后端入口
│   ├── database.js         # 数据库操作
│   └── package.json        # 后端依赖
├── public/                 # 静态资源
├── .env.example            # 环境变量示例
├── ecosystem.config.cjs    # PM2 配置
├── vite.config.ts          # Vite 配置
└── package.json            # 项目配置
```

## License

Private
