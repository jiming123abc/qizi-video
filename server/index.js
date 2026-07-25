const express = require('express');
const cors = require('cors');
const compression = require('compression');
const OSS = require('ali-oss');
const multer = require('multer');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { EventEmitter } = require('events');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('./database');
const aliyunVideo = require('./aliyunVideo');
const aiClient = require('./aiClient');

const taskEvents = new EventEmitter();
taskEvents.setMaxListeners(100);

const _originalAiTaskUpdate = db.aiTasks.update.bind(db.aiTasks);
db.aiTasks.update = async function(taskId, updates) {
  const success = await _originalAiTaskUpdate(taskId, updates);
  if (success) {
    const task = await db.aiTasks.get(taskId);
    if (task) {
      taskEvents.emit('taskUpdate', task);
    }
  }
  return success;
};

const deprecatedRoutes = new Set();
function warnDeprecated(route, newRoute) {
  if (!deprecatedRoutes.has(route)) {
    deprecatedRoutes.add(route);
    console.warn(`[DEPRECATED] 路由 ${route} 已废弃，请改用 ${newRoute}`);
  }
}

const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(path.join(uploadDir, 'images'))) {
  fs.mkdirSync(path.join(uploadDir, 'images'));
}
if (!fs.existsSync(path.join(uploadDir, 'videos'))) {
  fs.mkdirSync(path.join(uploadDir, 'videos'));
}
// P5-1：文档上传目录（与 image/video 隔离）
if (!fs.existsSync(path.join(uploadDir, 'docs'))) {
  fs.mkdirSync(path.join(uploadDir, 'docs'));
}

// 阿里云配置（优先使用 ALIYUN_ 前缀，向后兼容 OSS_ 前缀，旧的 REACT_APP_ 前缀已废弃）
const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID || process.env.ALIYUN_ACCESS_KEY_ID_DEV || process.env.OSS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID_DEV;
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET_DEV || process.env.OSS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET_DEV;
const OSS_BUCKET = process.env.OSS_BUCKET || process.env.OSS_BUCKET_DEV;
const OSS_REGION = process.env.OSS_REGION || process.env.OSS_REGION_DEV || 'oss-cn-beijing';

const isOSSConfigured = 
  ALIYUN_ACCESS_KEY_ID && 
  ALIYUN_ACCESS_KEY_ID !== '你的OSS AccessKey ID' &&
  ALIYUN_ACCESS_KEY_ID !== 'your_oss_access_key_id' &&
  ALIYUN_ACCESS_KEY_SECRET && 
  ALIYUN_ACCESS_KEY_SECRET !== '你的OSS AccessKey Secret' &&
  ALIYUN_ACCESS_KEY_SECRET !== 'your_oss_access_key_secret' &&
  OSS_BUCKET && 
  OSS_BUCKET !== '你的Bucket名称' &&
  OSS_BUCKET !== 'your_oss_bucket_name';

function findExecutable(names) {
  const { execSync } = require('child_process');
  const isWindows = process.platform === 'win32';
  for (const name of names) {
    try {
      let result;
      if (isWindows) {
        result = execSync(`where ${name} 2>nul`, { encoding: 'utf8' }).trim().split('\r\n')[0];
      } else {
        result = execSync(`which ${name} 2>/dev/null || command -v ${name} 2>/dev/null`, { encoding: 'utf8' }).trim();
      }
      if (result) {
        try {
          if (isWindows) {
            execSync(`"${result}" -version 2>nul`, { stdio: 'ignore' });
          } else {
            execSync(`${result} -version 2>/dev/null`, { stdio: 'ignore' });
          }
          return result;
        } catch (e) { }
      }
    } catch (e) { }
  }
  return null;
}

const systemFfmpeg = findExecutable(['ffmpeg']);
const systemFfprobe = findExecutable(['ffprobe']);

if (systemFfmpeg) {
  ffmpeg.setFfmpegPath(systemFfmpeg);
  console.log(`[server] 使用系统 ffmpeg: ${systemFfmpeg}`);
} else {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
    console.log(`[server] 使用 ffmpeg-static: ${ffmpegPath}`);
  }
}

if (systemFfprobe) {
  ffmpeg.setFfprobePath(systemFfprobe);
  console.log(`[server] 使用系统 ffprobe: ${systemFfprobe}`);
} else {
  const ffprobePath = require('ffprobe-static');
  if (ffprobePath && ffprobePath.path) {
    ffmpeg.setFfprobePath(ffprobePath.path);
    console.log(`[server] 使用 ffprobe-static: ${ffprobePath.path}`);
  }
}

const app = express();
const port = process.env.PORT || 3001;

app.use((req, res, next) => {
  res.setTimeout(1800000, () => {
    console.warn('请求超时');
    if (!res.headersSent) {
      res.status(408).json({ error: '请求超时' });
    }
  });
  next();
});

app.use(compression());

// CORS 配置：从环境变量读取允许的来源，默认包含常见开发端口和生产域名
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'https://video.qiziwenhua.top',
      'https://qiziwenhua.top',
      'https://www.qiziwenhua.top',
      'https://video.qingyungongxiang.com',
      'https://qingyungongxiang.com',
      'https://www.qingyungongxiang.com'
    ];

// P4-6：CORS 收紧——无 Origin 头时仅放行读操作（GET/HEAD/OPTIONS），
// 写操作（POST/PUT/DELETE）必须带合法 Origin，防范 CSRF/扫描器绕过白名单
function isAllowedOrigin(origin, method) {
  const isSafeMethod = !method || method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (!origin) return isSafeMethod;  // 无 Origin 仅放行读操作（兼容健康检查/SEO 爬虫）
  if (allowedOrigins.indexOf(origin) !== -1) return true;
  // 开发环境：允许所有 localhost 和 127.0.0.1 来源（任意端口）
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
    return true;
  }
  return false;
}

// P4-6：cors 中间件的 origin 函数签名是 (origin, callback)，无法直接访问 req。
// 用一个前置中间件把 req.method 写入 res.locals，origin 函数通过闭包读取。
let _currentReqMethod = 'GET';
app.use((req, res, next) => {
  _currentReqMethod = req.method;
  next();
});

app.use(cors({
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin, _currentReqMethod)) {
      callback(null, true);
    } else {
      console.warn('[CORS] 拒绝请求来源:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Content-Type: ${req.headers['content-type'] || 'none'}`);
  next();
});

app.use(express.json({ limit: '1mb' }));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) {
    return next();
  }
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: '未授权，请先登录' });
  }
  next();
}

app.get('/api/auth/check', (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.json({ enabled: false, authenticated: true });
  }
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  res.json({ enabled: true, authenticated: token === ADMIN_TOKEN });
});

app.post('/api/auth/login', (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.json({ success: true, authenticated: true });
  }
  const { token } = req.body || {};
  if (token === ADMIN_TOKEN) {
    res.json({ success: true, authenticated: true });
  } else {
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

// 鉴权白名单：仅 auth 与 share 公开
const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/check'
]);
const PUBLIC_PREFIXES = ['/share/', '/api/share/'];

app.use((req, res, next) => {
  if (!ADMIN_TOKEN) return next();
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/share/')) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();
  return requireAuth(req, res, next);
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    console.error(`[JSON Parse Error] ${req.method} ${req.url} - ${err.message}`);
    return res.status(400).json({ success: false, message: '请求体格式错误，请检查 JSON 格式' });
  }
  if (err && err.status === 413) {
    console.error(`[Payload Too Large] ${req.method} ${req.url} - ${err.message}`);
    return res.status(413).json({ success: false, message: '请求体过大' });
  }
  next(err);
});

app.use('/images', express.static(path.join(__dirname, '../public/images')));
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));
app.use('/ffmpeg', express.static(path.join(__dirname, '../public/ffmpeg')));

const distDir = process.env.DIST_DIR || path.join(__dirname, '../dist');
app.use(express.static(distDir));

const FILE_SIZE_LIMITS = {
  image: 20 * 1024 * 1024,
  video: 1024 * 1024 * 1024
};

const ALLOWED_MIME_TYPES = {
  image: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']
};

const ALLOWED_EXTENSIONS = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  video: ['mp4', 'webm', 'ogg', 'mov']
};

function validateFileExtension(filename, type) {
  const ext = filename.split('.').pop().toLowerCase();
  return ALLOWED_EXTENSIONS[type].includes(ext);
}

function validateFileSize(size, type) {
  return size <= FILE_SIZE_LIMITS[type];
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    const uploadPath = isImage 
      ? path.join(uploadDir, 'images') 
      : path.join(uploadDir, 'videos');
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const extension = file.originalname.split('.').pop();
    const randomStr = Math.random().toString(36).substr(2, 9);
    const fileName = `${timestamp}-${randomStr}.${extension}`;
    cb(null, fileName);
  }
});

const fileFilter = (req, file, cb) => {
  const isImage = file.mimetype.startsWith('image/');
  const isVideo = file.mimetype.startsWith('video/');
  const fileType = isImage ? 'image' : (isVideo ? 'video' : null);
  
  if (!fileType) {
    return cb(new Error('只支持图片和视频文件'), false);
  }
  
  if (!ALLOWED_MIME_TYPES[fileType].includes(file.mimetype)) {
    return cb(new Error(`不支持的${fileType === 'image' ? '图片' : '视频'}格式`), false);
  }
  
  if (!validateFileExtension(file.originalname, fileType)) {
    return cb(new Error(`不支持的文件扩展名`), false);
  }
  
  cb(null, true);
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: FILE_SIZE_LIMITS.video
  }
});

// P5-1：文档上传 multer（独立于 image/video upload，避免 fileFilter 拒绝文档文件）
const ALLOWED_DOC_MIMES = [
  'text/plain',                                                                                  // .txt
  'text/markdown',                                                                               // .md
  'application/pdf',                                                                             // .pdf
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'                      // .docx
];
const scriptStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(uploadDir, 'docs')),
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${ext}`);
  }
});
const scriptUpload = multer({
  storage: scriptStorage,
  fileFilter: (req, file, cb) => {
    if (ALLOWED_DOC_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('不支持的文档格式，仅支持 .txt/.md/.docx/.pdf'), false);
  },
  limits: { fileSize: 10 * 1024 * 1024 }  // 文档 10MB 限制
});

/**
 * P5-1：从上传的文档中提取纯文本
 * 支持 .txt/.md（直接读取）、.docx（mammoth）、.pdf（pdf-parse，仅文本型）
 */
async function extractDocText(filePath, mimetype) {
  if (mimetype === 'text/plain' || mimetype === 'text/markdown') {
    return fs.readFileSync(filePath, 'utf-8');
  }
  if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  if (mimetype === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    if (!data.text || !data.text.trim()) {
      throw new Error('PDF 无可提取文本，请上传文本型 PDF（非扫描件）');
    }
    return data.text;
  }
  throw new Error('不支持的文档格式');
}

let ossClient = null;
if (isOSSConfigured) {
  ossClient = new OSS({
    accessKeyId: ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: ALIYUN_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET,
    region: OSS_REGION,
    secure: true
  });
}

// 从 OSS URL（含 aliyuncs.com virtual-hosted-style 与自定义域名）提取 key
// 兼容纯 key 字符串与带 query 参数的 URL
function extractOssKeyFromUrl(url) {
  if (!url) return null;
  const str = String(url);
  // 已经是纯 key（无 :// 也无 /）
  if (!str.includes('://') && !str.includes('/')) return str;
  try {
    const u = new URL(str);
    // pathname 形如 /projects/123/videos/xxx.mp4，去掉前导 / 即为 key
    const key = decodeURIComponent(u.pathname).replace(/^\//, '');
    return key || null;
  } catch {
    // 非 URL，按 lastSlash 兜底
    const lastSlash = str.lastIndexOf('/');
    if (lastSlash !== -1) return str.substring(lastSlash + 1);
    return str;
  }
}

async function deleteOssFile(url) {
  if (!url || !ossClient) return;
  try {
    const key = extractOssKeyFromUrl(url);
    if (key) {
      await ossClient.delete(key);
      console.log('[OSS] 已删除文件:', key);
    }
  } catch (e) {
    console.warn('[OSS] 删除文件失败（可能不存在）:', url, e.message);
  }
}

// 获取 OSS 文件大小（用于媒体统计；失败返回 0）
async function getOssFileSize(url) {
  if (!url || !ossClient) return 0;
  try {
    const key = extractOssKeyFromUrl(url);
    if (!key) return 0;
    const result = await ossClient.head(key);
    return Number(result?.res?.headers?.['content-length'] || 0);
  } catch (e) {
    console.warn('[OSS] 获取文件大小失败:', url, e.message);
    return 0;
  }
}

// P3-6：并发删除多个 OSS 文件（容错：单个失败不影响其他）
async function deleteOssFiles(urls) {
  await Promise.all((urls || []).map(url => deleteOssFile(url).catch(e => console.error('[app] OSS 批量删除失败:', e.message))));
}

// P2-12 URL 引用计数：检查 url 是否仍被其他 shot_media / videos / digital_asset_images 引用
// excludeMediaId: 排除的 shot_media id（删除当前 media 时不算自身引用）
// excludeVideoId: 排除的 videos id（删除参考文件时不算自身引用）
// 返回 true 表示仍被引用（应跳过 OSS 删除），false 表示可安全删除
async function isUrlReferenced(url, options = {}) {
  if (!url) return false;
  const { excludeMediaId = null, excludeVideoId = null } = options;
  try {
    const mediaSql = excludeMediaId != null
      ? 'SELECT COUNT(*) as cnt FROM shot_media WHERE url = ? AND id != ?'
      : 'SELECT COUNT(*) as cnt FROM shot_media WHERE url = ?';
    const mediaParams = excludeMediaId != null ? [url, excludeMediaId] : [url];
    const mediaRefs = await db.storyboardAsync.all(mediaSql, mediaParams);

    const videoSql = excludeVideoId != null
      ? 'SELECT COUNT(*) as cnt FROM videos WHERE (url = ? OR coverUrl = ?) AND id != ?'
      : 'SELECT COUNT(*) as cnt FROM videos WHERE url = ? OR coverUrl = ?';
    const videoParams = excludeVideoId != null ? [url, url, excludeVideoId] : [url, url];
    const videoRefs = await db.storyboardAsync.all(videoSql, videoParams);

    const assetRefs = await db.storyboardAsync.all(
      'SELECT COUNT(*) as cnt FROM digital_asset_images WHERE imageUrl = ?',
      [url]
    );
    // digital_assets.imageUrl（主图）
    const assetMainRefs = await db.storyboardAsync.all(
      'SELECT COUNT(*) as cnt FROM digital_assets WHERE imageUrl = ?',
      [url]
    );

    const total = (mediaRefs[0]?.cnt || 0) + (videoRefs[0]?.cnt || 0)
      + (assetRefs[0]?.cnt || 0) + (assetMainRefs[0]?.cnt || 0);
    return total > 0;
  } catch (e) {
    console.warn('[app] isUrlReferenced 检查失败，按被引用处理以保护共享文件:', e.message);
    return true;
  }
}

// 删除 OSS 文件前先检查引用计数（P2-12 统一入口）
async function deleteOssFileIfNotReferenced(url, options = {}) {
  if (!url) return;
  const stillReferenced = await isUrlReferenced(url, options);
  if (stillReferenced) {
    console.log(`[app] URL 仍被其他记录引用，跳过 OSS 删除: ${url}`);
    return;
  }
  await deleteOssFile(url);
}

// 判断是否为 OSS 派生 URL（视频截图/图片处理），这类 URL 不是独立文件，
// 直接 delete 会误删源文件，必须跳过
function isDerivedOssUrl(url) {
  if (!url) return false;
  return String(url).includes('x-oss-process=');
}

// 删除独立 OSS 文件（派生 URL 跳过 + 引用计数感知）
// 用于封面/资产主图等「可能被替换或清除」的场景
async function deleteStandaloneOssFile(url, options = {}) {
  if (!url) return;
  if (isDerivedOssUrl(url)) {
    console.log('[app] 跳过派生 OSS URL，不删除源文件:', url);
    return;
  }
  await deleteOssFileIfNotReferenced(url, options);
}

async function compressImage(buffer, maxSizeKB = 300, mimetype = 'image/jpeg') {
  const maxSizeBytes = maxSizeKB * 1024;

  if (buffer.length <= maxSizeBytes) {
    return buffer;
  }

  const originalSize = buffer.length;
  let bestBuffer = buffer;

  // 统一转为 JPEG 格式压缩，从高质量逐步降低直到达标或质量下限
  let quality = 0.9;
  while (quality > 0.1) {
    const compressedBuffer = await sharp(buffer)
      .jpeg({ quality: Math.round(quality * 100) })
      .toBuffer();
    if (compressedBuffer.length < bestBuffer.length) {
      bestBuffer = compressedBuffer;
    }
    if (bestBuffer.length <= maxSizeBytes) break;
    quality -= 0.05;
  }

  // 保留较小者：如果压缩结果比原 buffer 大，返回原 buffer
  if (bestBuffer.length >= originalSize) {
    console.warn(`[compressImage] 压缩结果不小于原图，返回原 buffer (${(originalSize / 1024).toFixed(2)}KB)`);
    return buffer;
  }

  return bestBuffer;
}

const DEFAULT_PROJECT_COVER_PREFIX = 'data:image/svg+xml';

async function trySetProjectCoverIfDefault(projectId, mediaUrl, mediaType) {
  if (!projectId || !mediaUrl) return false;
  try {
    const project = await db.projects.getById(projectId);
    if (!project) return false;
    if (project.coverUrl && !project.coverUrl.startsWith(DEFAULT_PROJECT_COVER_PREFIX)) {
      return false;
    }
    const refs = await db.items.getByFilter({ projectId, deleted: 0, reference: 1 });
    if (refs && refs.length > 0) {
      return false;
    }
    let coverUrl = mediaUrl;
    if (mediaType === 'video' && (mediaUrl.includes('aliyuncs.com') || mediaUrl.includes('qiziwenhua.top'))) {
      coverUrl = mediaUrl + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
    }
    await db.projects.update(projectId, { coverUrl });
    console.log(`[app] 自动设置项目 ${projectId} 封面: ${coverUrl}`);
    return true;
  } catch (e) {
    console.warn('[app] 自动设置项目封面失败:', e.message);
    return false;
  }
}

// 获取视频信息（码率、分辨率等）
async function getVideoInfo(inputPath) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.warn('获取视频信息超时');
      resolve({ bitrateKbps: null, width: null, height: null, resolution: 'other' });
    }, 30000);

    try {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        clearTimeout(timeoutId);
        if (err) {
          console.warn('无法获取视频信息:', err.message);
          resolve({ bitrateKbps: null, width: null, height: null, resolution: 'other' });
          return;
        }

        const result = {
          bitrateKbps: null,
          width: null,
          height: null,
          resolution: 'other'
        };

        if (metadata && metadata.streams) {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          if (videoStream) {
            // 获取码率
            if (videoStream.bit_rate) {
              result.bitrateKbps = Math.round(parseInt(videoStream.bit_rate) / 1000);
            }
            // 获取分辨率
            if (videoStream.width && videoStream.height) {
              result.width = videoStream.width;
              result.height = videoStream.height;
              // 使用 aliuyunVideo 中的统一分辨率判断函数
              result.resolution = aliyunVideo.getResolutionFromMaxRes(Math.max(videoStream.width, videoStream.height));
            }
          }
        }

        resolve(result);
      });
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('获取视频信息出错:', err.message);
      resolve({ bitrateKbps: null, width: null, height: null, resolution: 'other' });
    }
  });
}

// 根据分辨率获取目标码率（使用 aliuyunVideo 中的统一配置）
// 从数据库读取视频压缩目标码率（分辨率阶梯判断）
async function getTargetBitrate(width, height) {
  // 分辨率判断使用短边（与前端 getResolutionTier 一致）：横屏视频用 height，竖屏视频用 width
  const maxRes = Math.max(width, height);
  const minRes = Math.min(width, height);
  // 短边决定清晰度阶梯：≥1080 → 1080p，≥720 → 720p，≥480 → 480p，更低用 480p
  const shortSide = minRes > 0 ? minRes : maxRes;
  let key;
  if (shortSide >= 1080) {
    key = 'video_target_bitrate_1080p';
  } else if (shortSide >= 720) {
    key = 'video_target_bitrate_720p';
  } else if (shortSide >= 480) {
    key = 'video_target_bitrate_480p';
  } else {
    // 低于 480p 的情况，使用 480p 的设置值（和图片压缩逻辑一致）
    key = 'video_target_bitrate_480p';
  }

  // 从数据库读取设置值
  const bitrateValue = await db.settings.get(key);
  // 返回码率值（kbps），如果数据库无值则使用默认值
  return bitrateValue !== null ? parseInt(bitrateValue) : 1000;
}

// P2-3：将 getTargetBitrate 注入 aliyunVideo，统一码率来源（数据库设置）
aliyunVideo.setBitrateProvider(getTargetBitrate);

// 保留旧函数名以保持向后兼容
async function getVideoBitrate(inputPath) {
  const info = await getVideoInfo(inputPath);
  return info.bitrateKbps;
}

async function compressVideoFile(inputPath, targetBitrateKbps, onProgress) {
  return new Promise((resolve, reject) => {
    // P3-6：临时文件改用 os.tmpdir()，避免污染应用目录
    const tempOutputPath = path.join(os.tmpdir(), `qizi_temp_${Date.now()}_output.mp4`);
    let inputIsTemp = false;

    const statSyncSafe = (p) => {
      try { return fs.statSync(p); } catch (_) { return null; }
    };

    const originalStat = statSyncSafe(inputPath);
    const originalSize = originalStat ? originalStat.size : 0;
    const sizeMB = originalSize / (1024 * 1024);
    const timeoutMs = Math.max(300000, Math.min(1800000, Math.ceil(sizeMB / 10) * 60000));
    console.log(`视频压缩超时设置: ${Math.round(timeoutMs / 1000)}秒 (文件大小: ${sizeMB.toFixed(2)}MB)`);

    let ffmpegCommand = null;
    const timeoutId = setTimeout(() => {
      console.warn('视频压缩超时，取消压缩');
      if (ffmpegCommand) {
        try {
          ffmpegCommand.kill('SIGKILL');
        } catch (e) { }
      }
      try {
        if (fs.existsSync(tempOutputPath)) {
          fs.unlinkSync(tempOutputPath);
        }
      } catch (e) { }
      resolve({ success: false, outputPath: null });
    }, timeoutMs);

    const cleanup = () => {
      try {
        if (fs.existsSync(tempOutputPath)) {
          fs.unlinkSync(tempOutputPath);
        }
      } catch (e) { }
    };

    try {
      ffmpegCommand = ffmpeg(inputPath)
        .outputOptions([
          `-b:v ${targetBitrateKbps}k`,                      // 平均目标码率
          `-maxrate ${targetBitrateKbps}k`,                   // 最大码率 = 目标码率（和浏览器端保持一致）
          `-bufsize ${targetBitrateKbps * 2}k`,
          '-preset fast',                                 // 和浏览器端保持一致
          '-c:v libx264',
          '-c:a aac',
          '-movflags +faststart'
        ])
        .on('progress', (progress) => {
          const percent = progress.percent || 0;
          console.log(`视频压缩进度: ${percent.toFixed(1)}%`);
          if (onProgress) {
            onProgress({ type: 'compress', progress: Math.round(percent) });
          }
        })
        .on('end', () => {
          clearTimeout(timeoutId);
          try {
            const outputStat = statSyncSafe(tempOutputPath);
            const compressedSize = outputStat ? outputStat.size : 0;
            console.log(`视频压缩完成: ${(originalSize / 1024 / 1024).toFixed(2)}MB -> ${(compressedSize / 1024 / 1024).toFixed(2)}MB`);

            if (compressedSize < originalSize) {
              resolve({ success: true, outputPath: tempOutputPath, size: compressedSize, isTempOutput: true });
            } else {
              cleanup();
              resolve({ success: false, outputPath: null, reason: '压缩后体积未减小' });
            }
          } catch (err) {
            console.error('读取压缩后视频失败:', err.message);
            cleanup();
            resolve({ success: false, outputPath: null, error: err.message });
          }
        })
        .on('error', (err) => {
          clearTimeout(timeoutId);
          console.warn('视频压缩失败:', err.message);
          cleanup();
          resolve({ success: false, outputPath: null, error: err.message });
        })
        .save(tempOutputPath);
    } catch (err) {
      clearTimeout(timeoutId);
      console.error('视频压缩出错:', err.message);
      cleanup();
      resolve({ success: false, outputPath: null, error: err.message });
    }
  });
}

const videoTasks = new Map();
const deleteProjectTasks = new Map();
const MAX_CONCURRENT_COMPRESSIONS = 2;
let currentCompressions = 0;
const pendingCompressions = [];

// 心跳超时阈值：完成时检查，若用户超过此时间未查询状态，视为已离开，清理 OSS 文件避免残留
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;  // 5 分钟
// 孤儿任务兜底扫描阈值：超过此时间的 pending/processing 任务视为孤儿，定时清理
const ORPHAN_TASK_TIMEOUT_MS = 30 * 60 * 1000;  // 30 分钟

// P4-7：任务终态后延迟清理 Map 条目，避免长期运行内存累积
// 延迟 10 分钟给前端轮询窗口（前端 1 秒轮询，600 次足够）
function scheduleTaskCleanup(map, taskId, delayMs = 10 * 60 * 1000) {
  setTimeout(() => {
    if (map.has(taskId)) {
      map.delete(taskId);
      console.log(`[taskCleanup] 已清理任务 ${taskId}`);
    }
  }, delayMs);
}

// P4-7：兜底定时器，每小时扫描清理超过 1 小时的终态任务
setInterval(() => {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  [videoTasks, deleteProjectTasks].forEach(map => {
    map.forEach((task, id) => {
      if ((task.status === 'done' || task.status === 'error') && task.createdAt) {
        const age = now - new Date(task.createdAt).getTime();
        if (age > ONE_HOUR) {
          map.delete(id);
          console.log(`[taskCleanup] 兜底清理超时任务 ${id}（age=${Math.round(age / 1000)}s）`);
        }
      }
    });
  });
}, 60 * 60 * 1000);

async function runWithCompressionLimit(fn) {
  if (currentCompressions < MAX_CONCURRENT_COMPRESSIONS) {
    currentCompressions++;
    try {
      return await fn();
    } finally {
      currentCompressions--;
      if (pendingCompressions.length > 0) {
        const next = pendingCompressions.shift();
        next();
      }
    }
  } else {
    return new Promise((resolve, reject) => {
      pendingCompressions.push(async () => {
        currentCompressions++;
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          currentCompressions--;
          if (pendingCompressions.length > 0) {
            const next = pendingCompressions.shift();
            next();
          }
        }
      });
    });
  }
}

// ==================== 分镜管理 API（升级版） ====================

app.get('/api/list', async (req, res) => {
  try {
    const { projectId, sceneId, status, deleted } = req.query;
    const items = await db.items.getByFilter({
      projectId: projectId !== undefined ? parseInt(projectId) : undefined,
      sceneId: sceneId !== undefined ? (sceneId === 'null' ? null : parseInt(sceneId)) : undefined,
      status,
      deleted: deleted !== undefined ? parseInt(deleted) : 0,
      reference: 0
    });
    
    // 为每个分镜关联 media 数组
    const itemsWithMedia = await Promise.all(items.map(async (item) => {
      const media = await db.shotMedia.getByShotId(item.id);
      return { ...item, media };
    }));
    
    res.json({ success: true, data: itemsWithMedia });
  } catch (error) {
    console.error('[app] 获取列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== 分镜管理端点 ==========

// 创建分镜（无参考画面）
app.post('/api/shots', async (req, res) => {
  try {
    const { projectId, sceneId, sceneContent, actors, props, costume, location, focalLength, narration,
            cameraMovement, shotType, shotAngle, lighting, notes, estimatedDuration,
            aiImagePrompt, aiStylePrompt } = req.body;
    
    const shot = await db.items.createShot({
      projectId: projectId ? parseInt(projectId) : null,
      sceneId: sceneId !== undefined ? (sceneId === null ? null : parseInt(sceneId)) : null,
      sceneContent: sceneContent || '新分镜',
      actors: actors || '',
      props: props || '',
      costume: costume || '',
      location: location || '',
      focalLength: focalLength || '',
      narration: narration || '',
      cameraMovement: cameraMovement || '',
      shotType: shotType || '',
      shotAngle: shotAngle || '',
      lighting: lighting || '',
      notes: notes || '',
      estimatedDuration: estimatedDuration || '',
      aiImagePrompt: aiImagePrompt || '',
      aiStylePrompt: aiStylePrompt || '',
      status: 'pending'
    });
    
    res.json({ success: true, data: { ...shot, media: [] } });
  } catch (error) {
    console.error('[app] 创建分镜失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 批量更新分镜（必须在 /api/shots/:id 之前定义，否则 batch-update 会被当作 :id 匹配）
app.put('/api/shots/batch-update', batchUpdateShots);

// 更新分镜字段
app.put('/api/shots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    
    // 过滤允许更新的字段
    const allowedFields = [
      'sceneContent', 'actors', 'props', 'costume', 'location', 'focalLength',
      'narration', 'cameraMovement', 'shotType', 'shotAngle', 'lighting',
      'notes', 'estimatedDuration', 'aiImagePrompt', 'aiStylePrompt', 'shotNo', 'status'
    ];
    
    const updateData = {};
    for (const f of allowedFields) {
      if (fields[f] !== undefined) {
        updateData[f] = fields[f];
      }
    }
    
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, message: '没有需要更新的字段' });
    }
    
    await db.items.updateShotFields(parseInt(id), updateData);
    
    // 返回更新后的分镜
    const shot = await db.items.getById(parseInt(id));
    const media = await db.shotMedia.getByShotId(parseInt(id));
    
    res.json({ success: true, data: { ...shot, media } });
  } catch (error) {
    console.error('[app] 更新分镜失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 合并分镜
app.post('/api/shots/merge', async (req, res) => {
  try {
    const { shotIds } = req.body;
    
    if (!shotIds || !Array.isArray(shotIds) || shotIds.length < 2) {
      return res.status(400).json({ success: false, message: '至少需要2个分镜才能合并' });
    }
    
    const merged = await db.items.mergeShots(shotIds.map(id => parseInt(id)));
    
    res.json({ success: true, data: merged });
  } catch (error) {
    console.error('[app] 合并分镜失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== 参考画面管理端点 ==========

// 获取分镜的参考画面
app.get('/api/shots/:id/media', async (req, res) => {
  try {
    const { id } = req.params;
    const media = await db.shotMedia.getByShotId(parseInt(id));
    res.json({ success: true, data: media });
  } catch (error) {
    console.error('[app] 获取参考画面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 新增参考画面到分镜
app.post('/api/shots/:id/media', async (req, res) => {
  const { url } = req.body || {};
  try {
    const { id } = req.params;
    const { type, filename, size, source, startTime, duration } = req.body;
    
    const shot = await db.items.getById(parseInt(id));
    if (!shot) {
      return res.status(404).json({ success: false, message: '分镜不存在' });
    }

    // 兜底：如果 size 为 0 或未传入，且 URL 是 OSS URL，自动从 OSS 获取文件大小
    let finalSize = size || 0;
    if (!finalSize && url && url.startsWith('http') && isOSSConfigured && ossClient) {
      try {
        finalSize = await getOssFileSize(url);
        if (finalSize > 0) {
          console.log(`[shot-media] 自动获取 OSS 文件大小: ${url} → ${finalSize} bytes`);
        }
      } catch (e) {
        console.warn('[shot-media] 获取 OSS 文件大小失败:', url, e.message);
      }
    }
    
    // 去重检查：如果同一 shot 已有相同 url 的媒体记录，直接返回已有记录
    const existingMedia = await db.shotMedia.getByUrlAndShotId(url, parseInt(id));
    if (existingMedia) {
      console.log(`[shot-media] 去重：shot ${id} 已存在相同 url 的媒体记录 (id=${existingMedia.id})`);
      return res.json({ success: true, data: existingMedia });
    }

    const media = await db.shotMedia.create({
      shotId: parseInt(id),
      url,
      type: type || 'image',
      filename: filename || '',
      size: finalSize,
      source: source || 'upload',
      startTime: startTime !== undefined ? startTime : 0,
      duration: duration !== undefined ? duration : null
    });
    
    res.json({ success: true, data: media });
  } catch (error) {
    console.error('[app] 新增参考画面失败:', error.message);
    // DB 写入失败时清理已上传的 OSS 文件避免残留
    if (url) {
      try {
        await deleteOssFileIfNotReferenced(url);
      } catch (e) {
        console.warn('[app] 新增参考画面失败后清理 OSS 失败:', e.message);
      }
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// 上传参考画面到分镜（复用现有上传逻辑，但存储到 shot_media 表）
// 注意：此端点由 upload/video 和 upload/image 调用后自动处理

// OSS 残留文件清理接口（前端上传成功但关联分镜失败时调用）
app.post('/api/oss/cleanup', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.json({ success: true, cleaned: 0 });
    }
    let cleaned = 0;
    for (const url of urls) {
      try {
        await deleteOssFileIfNotReferenced(url);
        cleaned++;
      } catch (e) {
        console.warn('[oss/cleanup] 清理单个文件失败:', url, e.message);
      }
    }
    console.log(`[oss/cleanup] 请求清理 ${urls.length} 个文件，实际处理 ${cleaned} 个`);
    res.json({ success: true, cleaned });
  } catch (error) {
    console.error('[oss/cleanup] 清理失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除参考画面
app.delete('/api/shots/:id/media/:mediaId', async (req, res) => {
  try {
    const { id, mediaId } = req.params;
    const shotId = parseInt(id);
    const mId = parseInt(mediaId);
    // 先查媒体记录拿到 url（用于 OSS 清理）
    const mediaList = await db.shotMedia.getByShotId(shotId);
    const media = (mediaList || []).find(m => m.id === mId);
    if (!media) {
      return res.status(404).json({ success: false, message: '参考画面不存在' });
    }
    const mediaUrl = media.url;

    // 获取 shot 对应的 projectId（用于封面检查）
    const shot = await db.items.getById(shotId);
    const projectId = shot ? shot.projectId : null;

    // 1. 删 shot_media 记录
    await db.shotMedia.delete(mId);
    // 2. 检查是否还有其他 shot_media 引用同一 URL
    const otherMediaRows = await db.storyboardAsync.all(
      'SELECT COUNT(*) as cnt FROM shot_media WHERE url = ?',
      [mediaUrl]
    );
    const otherMediaCount = otherMediaRows[0]?.cnt || 0;
    if (otherMediaCount === 0) {
      // 检查并清除项目封面（如果封面是该媒体）
      if (projectId) {
        try {
          const project = await db.projects.getById(projectId);
          if (project && project.coverUrl && !project.coverUrl.startsWith(DEFAULT_PROJECT_COVER_PREFIX)) {
            const coverBaseUrl = project.coverUrl.split('?')[0];
            const mediaBaseUrl = mediaUrl.split('?')[0];
            if (coverBaseUrl === mediaBaseUrl) {
              await db.projects.update(projectId, { coverUrl: '' });
              console.log(`[app] 删除分镜参考画面，清除项目 ${projectId} 封面`);
            }
          }
        } catch (e) {
          console.warn('[app] 检查/清除项目封面失败:', e.message);
        }
      }

      // 3. 无其他 shot_media 引用：删 videos(reference=1) 记录（统计占用空间由此而来）
      //    必须在 deleteOssFileIfNotReferenced 之前删除，否则 isUrlReferenced 会因
      //    videos(reference=1) 记录仍存在而返回 true，阻止 OSS 删除
      try {
        await db.storyboardAsync.run(
          'DELETE FROM videos WHERE url = ? AND reference = 1',
          [mediaUrl]
        );
      } catch (e) {
        console.warn('[app] 删除 videos(reference=1) 记录失败:', e.message);
      }
      // 4. 删 OSS 文件（此时 videos(reference=1) 已删，isUrlReferenced 不会误判）
      try {
        await deleteOssFileIfNotReferenced(mediaUrl);
      } catch (e) {
        console.error('[app] 删除参考画面 OSS 文件失败:', e.message);
      }
    } else {
      console.log(`[app] URL 仍被其他 shot_media 引用，跳过删除: ${mediaUrl}`);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 删除参考画面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 排序参考画面
app.put('/api/shots/:id/media/sort', async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body; // [{ id: number, sortOrder: number }]
    await db.shotMedia.updateSort(parseInt(id), items);
    const media = await db.shotMedia.getByShotId(parseInt(id));
    res.json({ success: true, data: media });
  } catch (error) {
    console.error('[app] 排序参考画面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== 设置端点 ==========

// API Key 脱敏工具函数
function maskApiKey(key) {
  if (!key || key.includes('****')) return key;  // 已脱敏则跳过
  if (key.length <= 7) return '****';
  return key.substring(0, 3) + '****' + key.substring(key.length - 4);
}

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.settings.getAll();
    
    // 自动迁移：首次加载时若 ai_platforms 不存在，从 .env 创建内置平台
    if (!settings.ai_platforms) {
      settings.ai_platforms = [
        {
          id: 'geekai',
          name: 'GeekAI',
          baseUrl: 'https://geekai.co/api/v1',
          apiKey: process.env.GEEKAI_API_KEY || '',
          docsUrl: 'https://geekai.co/docs',
          builtIn: true
        }
      ];
      await db.settings.set('ai_platforms', settings.ai_platforms);
    }
    
    // 脱敏 ai_platforms 中的 apiKey
    if (settings.ai_platforms && Array.isArray(settings.ai_platforms)) {
      settings.ai_platforms = settings.ai_platforms
        .filter(p => p.id !== 'siliconflow')
        .map(p => ({
          ...p,
          apiKey: p.apiKey ? maskApiKey(p.apiKey) : ''
        }));
    }
    
    // 保留旧的脱敏逻辑（兼容）
    if (settings.geekai_api_key) {
      settings.geekai_api_key = maskApiKey(settings.geekai_api_key);
    }
    if (settings.siliconflow_api_key) {
      settings.siliconflow_api_key = maskApiKey(settings.siliconflow_api_key);
    }
    
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('[app] 获取设置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    
    if (!key) {
      return res.status(400).json({ success: false, message: '缺少 key 参数' });
    }
    
    // ai_platforms 特殊处理：保留未修改的真实 apiKey
    if (key === 'ai_platforms' && Array.isArray(value)) {
      const existingSettings = await db.settings.getAll();
      const existingPlatforms = existingSettings.ai_platforms || [];
      const mergedValue = value.map(newPlatform => {
        // 如果新值中 apiKey 包含 ****（脱敏值）或为空，保留旧的真实值
        if (!newPlatform.apiKey || (newPlatform.apiKey && newPlatform.apiKey.includes('****'))) {
          const oldPlatform = existingPlatforms.find(p => p.id === newPlatform.id);
          if (oldPlatform && oldPlatform.apiKey && !oldPlatform.apiKey.includes('****')) {
            return { ...newPlatform, apiKey: oldPlatform.apiKey };
          }
          return { ...newPlatform, apiKey: '' };
        }
        return newPlatform;
      });
      await db.settings.set(key, mergedValue);
    } else {
      await db.settings.set(key, value);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 保存设置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== AI 费用统计端点 ==========

app.get('/api/ai/usage', async (req, res) => {
  try {
    const { period } = req.query;
    const stats = await db.aiUsage.getStats(period || 'month');
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[app] 获取费用统计失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== AI 任务端点 ==========

// 查询 AI 任务状态
app.get('/api/ai/task/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await db.aiTasks.get(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: '任务不存在' });
    }
    res.json({ success: true, data: task });
  } catch (error) {
    console.error('[app] 查询 AI 任务失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// SSE 监听任务状态
app.get('/api/ai/task/:taskId/stream', (req, res) => {
  const { taskId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(': SSE connected\n\n');

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const handleUpdate = (updatedTask) => {
    if (updatedTask.id === taskId) {
      sendEvent('update', updatedTask);
      if (updatedTask.status === 'done' || updatedTask.status === 'failed' || updatedTask.status === 'error') {
        taskEvents.removeListener('taskUpdate', handleUpdate);
        res.end();
      }
    }
  };

  taskEvents.on('taskUpdate', handleUpdate);

  db.aiTasks.get(taskId).then(task => {
    if (task) {
      sendEvent('update', task);
      if (task.status === 'done' || task.status === 'failed' || task.status === 'error') {
        taskEvents.removeListener('taskUpdate', handleUpdate);
        res.end();
      }
    } else {
      sendEvent('error', { message: '任务不存在' });
      res.end();
    }
  }).catch(err => {
    console.error('[SSE] 获取任务失败:', err);
    sendEvent('error', { message: err.message });
    res.end();
  });

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    taskEvents.removeListener('taskUpdate', handleUpdate);
  });
});

// AI 脚本解析生成分镜
// P5-1：重构 parse-script 路由
// - 改用 scriptUpload 处理文档（.txt/.md/.docx/.pdf），修复 multer fileFilter 拒绝文档文件的 bug
// - 移除 mode 参数（改为 AI 自动判断）
// - 新增 stage 参数：auto / intent / intent_confirmed / scene_confirmed / storyboard / shooting
app.post('/api/ai/parse-script', scriptUpload.array('file', 1), async (req, res) => {
  try {
    const { projectId, sceneId, provider, model, stage = 'auto' } = req.body;
    const file = req.files && req.files[0];

    let scriptContent = '';

    if (file) {
      // 提取文档文本（.txt/.md/.docx/.pdf）
      try {
        scriptContent = await extractDocText(file.path, file.mimetype);
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      } finally {
        try { fs.unlinkSync(file.path); } catch (e) {}
      }
    } else if (req.body.text) {
      // 制片意图（stage='intent'）或确认后的脚本文本（intent_confirmed/scene_confirmed/storyboard/shooting）
      scriptContent = req.body.text;
    } else {
      return res.status(400).json({ success: false, message: '请上传文档或输入制片意图' });
    }

    // 创建 AI 任务
    const task = await db.aiTasks.create({
      id: crypto.randomUUID(),
      type: 'script_parse',
      status: 'processing',
      projectId: projectId ? parseInt(projectId) : null,
      input: { stage, textLength: scriptContent.length, provider, model }
    });

    // 异步处理（后台执行）
    processScriptParse(task.id, scriptContent, stage, {
      projectId: projectId ? parseInt(projectId) : null,
      sceneId: sceneId !== undefined && sceneId !== null ? parseInt(sceneId) : null,
      provider: provider || 'geekai',
      model: model || 'deepseek-chat'
    });

    res.json({ success: true, taskId: task.id });
  } catch (error) {
    console.error('[app] AI 脚本解析失败:', error.message);
    // 清理 multer 临时文件
    if (req.files && req.files[0] && req.files[0].path) {
      try { fs.unlinkSync(req.files[0].path); } catch (e) {}
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// P5-1：脚本下载接口（供用户下载 AI 生成的视频文案/场次划分/分镜脚本/拍摄脚本）
// 第一版仅支持 .txt 下载（.docx 生成需额外库，价值不大）
app.post('/api/ai/download-script', (req, res) => {
  try {
    const { content, filename = 'script', format = 'txt' } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, message: '缺少脚本内容' });
    }
    // 简化：仅支持 .txt 下载
    const safeFilename = encodeURIComponent(filename);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.txt"`);
    res.send(content);
  } catch (error) {
    console.error('[app] 脚本下载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 创建分镜（前端确认后提交）
app.post('/api/ai/create-shots', async (req, res) => {
  try {
    const { projectId, sceneId, shots, sceneMap } = req.body;

    if (!projectId || !shots || shots.length === 0) {
      return res.status(400).json({ success: false, message: '缺少必要参数' });
    }

    const createdShots = [];

    // 使用传入的 sceneMap 或根据 sceneId 分配场次
    const sceneIdMap = sceneMap || {};
    const defaultSceneId = sceneId ? parseInt(sceneId) : null;

    for (const shotData of shots) {
      let shotSceneId = shotData.sceneId || defaultSceneId;

      // 如果有 sceneMap，使用它来获取场次 ID
      if (shotData.sceneName && sceneIdMap[shotData.sceneName.toLowerCase()]) {
        shotSceneId = sceneIdMap[shotData.sceneName.toLowerCase()];
      }

      const shot = await db.items.createShot({
        projectId: parseInt(projectId),
        sceneId: shotSceneId,
        sceneContent: shotData.sceneContent || '',
        actors: shotData.actors || '',
        props: shotData.props || '',
        costume: shotData.costume || '',
        location: shotData.location || '',
        focalLength: shotData.focalLength || '',
        narration: shotData.narration || '',
        cameraMovement: shotData.cameraMovement || '',
        shotType: shotData.shotType || '',
        shotAngle: shotData.shotAngle || '',
        lighting: shotData.lighting || '',
        notes: shotData.notes || '',
        estimatedDuration: shotData.estimatedDuration || '',
        aiImagePrompt: shotData.aiImagePrompt || '',
        aiStylePrompt: shotData.aiStylePrompt || '',
        status: 'pending'
      });

      createdShots.push({ ...shot, media: [] });
    }

    console.log(`[AI] 创建分镜完成: 创建了 ${createdShots.length} 个分镜`);

    res.json({ success: true, shots: createdShots, total: createdShots.length });
  } catch (error) {
    console.error('[app] AI 创建分镜失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 生成参考图
app.post('/api/ai/generate-image', async (req, res) => {
  try {
    // P3-24：refImages 优先于 sceneImageUrl（向后兼容）
    // Q1：previewOnly=true 时仅生成预览（不上传 OSS），用于多图暂存
    const { shotId, prompt, sceneImageUrl, refImages, size, provider, model, quality, previewOnly } = req.body;
    
    if (!shotId) {
      return res.status(400).json({ success: false, message: '缺少 shotId' });
    }
    
    if (!provider || !model) {
      return res.status(400).json({ success: false, message: '缺少 provider 或 model 参数' });
    }
    
    const shot = await db.items.getById(parseInt(shotId));
    if (!shot) {
      return res.status(404).json({ success: false, message: '分镜不存在' });
    }
    
    // 检查 shot_media 数量
    const existingMedia = await db.shotMedia.getByShotId(parseInt(shotId));
    if (existingMedia.length >= 10) {
      return res.status(400).json({ success: false, message: '参考画面已达上限（10个）' });
    }
    
    // P3-24：归一化参考图为 URL 数组
    // refImages 优先；若仅传 sceneImageUrl（旧客户端），转为单元素数组
    let normalizedRefUrls = [];
    if (Array.isArray(refImages) && refImages.length > 0) {
      normalizedRefUrls = refImages.filter(u => typeof u === 'string' && u);
    } else if (sceneImageUrl) {
      normalizedRefUrls = [sceneImageUrl];
    }
    
    // 创建 AI 任务
    const task = await db.aiTasks.create({
      id: crypto.randomUUID(),
      type: 'image_gen',
      status: 'processing',
      projectId: shot.projectId,
      input: { 
        shotId: parseInt(shotId), 
        prompt: prompt || shot.aiImagePrompt || shot.sceneContent, 
        refImages: normalizedRefUrls,
        size,
        provider,
        model,
        quality: quality || 'standard'
      }
    });
    
    // 异步处理
    processImageGen(task.id, shot, prompt, normalizedRefUrls, size, provider, model, quality || 'standard', { previewOnly: !!previewOnly });
    
    res.json({ success: true, taskId: task.id });
  } catch (error) {
    console.error('[app] AI 生图失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 通用生图（不需要 shotId，用于数字资产、演员/道具/场景图片生成）
app.post('/api/ai/generic-image-gen', async (req, res) => {
  try {
    // P3-22：新增 ownerType/ownerId 参数，用于持久化历史图
    // P3-24：refImages 优先于 refImageUrl（向后兼容）
    const { prompt, refImageUrl, refImages, size, provider, model, quality, ownerType, ownerId, projectId, previewOnly } = req.body;

    if (!prompt || !provider || !model) {
      return res.status(400).json({ success: false, message: '缺少必要参数: prompt, provider, model' });
    }

    // P3-24：归一化参考图为 URL 数组
    let normalizedRefUrls = [];
    if (Array.isArray(refImages) && refImages.length > 0) {
      normalizedRefUrls = refImages.filter(u => typeof u === 'string' && u);
    } else if (refImageUrl) {
      normalizedRefUrls = [refImageUrl];
    }

    // 创建 AI 任务
    const task = await db.aiTasks.create({
      id: crypto.randomUUID(),
      type: 'image_gen',
      status: 'processing',
      projectId: null,
      input: { prompt, refImages: normalizedRefUrls, size, provider, model, quality: quality || 'standard', ownerType, ownerId }
    });

    // 异步处理
    processGenericImageGen(task.id, prompt, normalizedRefUrls, size, provider, model, quality || 'standard', { ownerType, ownerId, projectId, previewOnly: !!previewOnly });

    res.json({ success: true, taskId: task.id });
  } catch (error) {
    console.error('[app] AI 通用生图失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// P3-22：AI 生图历史图片持久化 - 查询某 owner 的历史图
app.get('/api/ai/generated-images', async (req, res) => {
  try {
    const { ownerType, ownerId } = req.query;
    if (!ownerType || !ownerId) {
      return res.status(400).json({ success: false, message: '缺少 ownerType 或 ownerId' });
    }
    const rows = await db.storyboardAsync.all(
      'SELECT * FROM ai_generated_images WHERE ownerType = ? AND ownerId = ? ORDER BY sortOrder ASC, id DESC',
      [ownerType, parseInt(ownerId)]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[app] 查询 AI 生图历史失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// P3-22：用户明确删除单张历史图（清理 OSS，已被引用的跳过）
app.delete('/api/ai/generated-images/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = await db.storyboardAsync.get('SELECT url FROM ai_generated_images WHERE id = ?', [id]);
    if (!row) {
      return res.status(404).json({ success: false, message: '图片不存在' });
    }
    // 检查是否已被 shot_media / digital_asset_images 引用
    const stillReferenced = await isUrlReferenced(row.url);
    if (!stillReferenced) {
      try { await deleteOssFile(row.url); }
      catch (e) { console.error('[app] AI 历史图 OSS 删除失败:', e.message); }
    }
    await db.storyboardAsync.run('DELETE FROM ai_generated_images WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 删除 AI 生图历史失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Q1：上传预览图到 OSS（用户从多图暂存中确认选择后调用）
// 下载 AI 临时 URL → 压缩 → 上传 OSS → 写入 ai_generated_images 历史 → 返回 OSS URL
app.post('/api/ai/upload-preview-image', async (req, res) => {
  try {
    const { url, projectId, ownerType, ownerId, prompt, model, provider, size } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, message: '缺少 url 参数' });
    }
    if (!projectId) {
      return res.status(400).json({ success: false, message: '缺少 projectId' });
    }

    // 下载 AI 临时图片
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(400).json({ success: false, message: '下载 AI 图片失败（URL 可能已过期）' });
    }
    const buffer = await response.arrayBuffer();
    let fileBuffer = Buffer.from(buffer);
    let fileSize = fileBuffer.length;

    // 压缩
    const aiThresholdStr = await db.settings.get('image_compress_threshold_kb');
    const aiThresholdKB = aiThresholdStr ? parseInt(aiThresholdStr) : 300;
    if (fileSize > aiThresholdKB * 1024) {
      try {
        fileBuffer = await compressImage(fileBuffer, aiThresholdKB, 'image/png');
        fileSize = fileBuffer.length;
        console.log(`[AI] 预览图已压缩: ${buffer.byteLength} -> ${fileSize} bytes`);
      } catch (e) {
        console.warn('[AI] 预览图压缩失败，使用原图:', e.message);
      }
    }

    // 上传到 OSS
    let ossUrl = url;
    if (isOSSConfigured && ossClient) {
      const ext = 'png';
      const fileName = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 8)}.${ext}`;
      const effectiveOwnerType = ownerType || 'asset';
      const folder = effectiveOwnerType === 'shot'
        ? `projects/${projectId}/shot-references/images`
        : `projects/${projectId}/digital-assets`;
      const ossKey = `${folder}/${fileName}`;
      const ossResult = await ossClient.put(ossKey, fileBuffer);
      ossUrl = ossResult.url;
      console.log(`[AI] 预览图已上传到 OSS: ${ossKey}`);
    }

    // 写入 ai_generated_images 历史记录
    if (ownerType && ownerId) {
      try {
        await db.storyboardAsync.run(
          `INSERT INTO ai_generated_images (ownerType, ownerId, url, prompt, model, provider, size, fileSize, sortOrder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ownerType, parseInt(ownerId), ossUrl, prompt || '', model || '', provider || '', size || '', fileSize, 0]
        );
      } catch (e) {
        console.warn('[AI] 预览图写入历史失败:', e.message);
      }
    }

    res.json({ success: true, url: ossUrl, fileSize });
  } catch (error) {
    console.error('[app] 上传预览图失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// P3-22：内部函数 - 收集某 owner 的所有历史图 URL
async function collectAiGeneratedUrls(ownerType, ownerId) {
  const rows = await db.storyboardAsync.all(
    'SELECT url FROM ai_generated_images WHERE ownerType = ? AND ownerId = ?',
    [ownerType, ownerId]
  );
  return rows.map(r => r.url);
}

// P3-22：内部函数 - 删除某 owner 的所有历史图（联动删除）
// 仅删未被其他引用的 OSS（与 P2-12 引用计数一致）
async function deleteAiGeneratedByOwner(ownerType, ownerId) {
  const urls = await collectAiGeneratedUrls(ownerType, ownerId);
  for (const url of urls) {
    // 检查除当前 owner 外是否还有其他引用
    const smRefs = await db.storyboardAsync.all('SELECT COUNT(*) as cnt FROM shot_media WHERE url = ?', [url]);
    const aiRefs = await db.storyboardAsync.all('SELECT COUNT(*) as cnt FROM digital_asset_images WHERE imageUrl = ?', [url]);
    const assetMainRefs = await db.storyboardAsync.all('SELECT COUNT(*) as cnt FROM digital_assets WHERE imageUrl = ?', [url]);
    const videoRefs = await db.storyboardAsync.all('SELECT COUNT(*) as cnt FROM videos WHERE url = ? AND deleted = 0', [url]);
    const otherHist = await db.storyboardAsync.all(
      'SELECT COUNT(*) as cnt FROM ai_generated_images WHERE url = ? AND NOT (ownerType = ? AND ownerId = ?)',
      [url, ownerType, ownerId]
    );
    const total = (smRefs[0]?.cnt || 0) + (aiRefs[0]?.cnt || 0) + (assetMainRefs[0]?.cnt || 0)
      + (videoRefs[0]?.cnt || 0) + (otherHist[0]?.cnt || 0);
    if (total === 0) {
      try { await deleteOssFile(url); } catch (e) { /* 忽略，记录日志 */ }
    }
  }
  await db.storyboardAsync.run(
    'DELETE FROM ai_generated_images WHERE ownerType = ? AND ownerId = ?',
    [ownerType, ownerId]
  );
}

// AI 视频分割
app.post('/api/ai/split-video', async (req, res) => {
  try {
    const { videoUrl, projectId, sceneId, mode, splitPoints, videoDuration, provider, model, sensitivity } = req.body;

    console.log(`[AI] 收到视频分割请求: mode=${mode}, videoUrl=${videoUrl.substring(0, 100)}...`);

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: '缺少 videoUrl' });
    }
    
    // 创建 AI 任务
    const task = await db.aiTasks.create({
      id: crypto.randomUUID(),
      type: 'video_split',
      status: 'processing',
      projectId: projectId ? parseInt(projectId) : null,
      input: { videoUrl, mode, splitPoints: splitPoints || [] }
    });
    
    // 异步处理
    processVideoSplit(task.id, videoUrl, {
      projectId: projectId ? parseInt(projectId) : null,
      sceneId: sceneId !== undefined && sceneId !== null ? parseInt(sceneId) : null,
      mode,
      splitPoints: splitPoints || [],
      videoDuration: videoDuration || 0,
      provider: provider || null,
      model: model || null,
      sensitivity: sensitivity || null
    });
    
    res.json({ success: true, taskId: task.id });
  } catch (error) {
    console.error('[app] AI 视频分割失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 场次分析：分析未分类分镜的第一帧，给出场次划分建议
app.post('/api/ai/analyze-shot-scenes', async (req, res) => {
  try {
    const { shotIds, provider, model } = req.body;

    if (!shotIds || !Array.isArray(shotIds) || shotIds.length === 0) {
      return res.status(400).json({ success: false, message: '缺少 shotIds' });
    }
    if (!provider || !model) {
      return res.status(400).json({ success: false, message: '缺少 provider 或 model' });
    }

    const settings = await db.settings.getAll();

    // 1. 查询所有 shot 及其 media
    const shotDataList = [];
    for (const shotId of shotIds) {
      const shot = await db.items.getById(shotId);
      if (!shot) continue;
      const media = await db.shotMedia.getByShotId(shotId);
      const firstMedia = media && media.length > 0 ? media[0] : null;
      if (firstMedia) {
        shotDataList.push({ shotId, mediaUrl: firstMedia.url, mediaType: firstMedia.type, startTime: firstMedia.startTime || 0 });
      }
    }

    if (shotDataList.length === 0) {
      return res.status(400).json({ success: false, message: '未找到有效的分镜媒体' });
    }

    // 2. 提取每个分镜的第一帧并压缩为 base64
    const framesData = [];
    for (let i = 0; i < shotDataList.length; i++) {
      const item = shotDataList[i];
      try {
        let base64 = null;
        if (item.mediaType === 'image') {
          // 图片直接使用
          const resp = await fetch(item.mediaUrl);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            const compressed = await compressImage(buf, 50);
            base64 = compressed.toString('base64');
          }
        } else {
          // 视频：用 ffmpeg 提取 startTime 处的帧
          const tempFrame = path.join(os.tmpdir(), `qizi_scene_frame_${Date.now()}_${i}.jpg`);
          const ffmpegBin = systemFfmpeg || require('ffmpeg-static');
          const { execSync } = require('child_process');
          try {
            execSync(`"${ffmpegBin}" -y -ss ${item.startTime} -i "${item.mediaUrl}" -frames:v 1 -q:v 5 -vf scale=480:-1 "${tempFrame}"`, { timeout: 15000, stdio: 'ignore' });
            if (fs.existsSync(tempFrame)) {
              const buf = fs.readFileSync(tempFrame);
              const compressed = await compressImage(buf, 50);
              base64 = compressed.toString('base64');
              fs.unlinkSync(tempFrame);
            }
          } catch (e) {
            console.warn(`[AI] 提取分镜 ${item.shotId} 帧失败:`, e.message);
          }
        }
        if (base64) {
          framesData.push({ shotId: item.shotId, index: i, base64 });
        }
      } catch (e) {
        console.warn(`[AI] 处理分镜 ${item.shotId} 失败:`, e.message);
      }
    }

    if (framesData.length === 0) {
      return res.status(500).json({ success: false, message: '无法提取任何分镜帧' });
    }

    // 3. 分批发给视觉模型（每批 8 张）
    const batchSize = 8;
    const allResults = [];

    for (let batchStart = 0; batchStart < framesData.length; batchStart += batchSize) {
      const batch = framesData.slice(batchStart, batchStart + batchSize);
      const content = [];

      content.push({
        type: 'text',
        text: `以下是视频中各镜头的截图，请分析每个镜头的场景环境并分类。
对每个镜头返回：
- scene: 场景描述（如“室内-办公室”、“室外-街道”、“室内-卧室”）
- type: "shot"(实拍，有人物/场景/动作) 或 "non_shot"(标题卡/字幕/黑屏/纯文字等非实拍)

返回 JSON 格式：{"results": [{"index": 0, "scene": "室内-办公室", "type": "shot"}, ...]}
只返回 JSON，不要任何额外说明。

截图列表：`
      });

      for (let j = 0; j < batch.length; j++) {
        content.push({ type: 'text', text: `--- 镜头 ${batchStart + j + 1} ---` });
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${batch[j].base64}`, detail: 'low' } });
      }

      const messages = [{ role: 'user', content }];
      const chain = [{ model, provider, cost: 0 }];

      try {
        const result = await aiClient.callChatWithFallback(messages, chain, settings, {
          temperature: 0.2,
          max_tokens: 2000,
          json: true,
          timeoutMs: 60000
        });

        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.results && Array.isArray(parsed.results)) {
            for (const r of parsed.results) {
              const idx = batchStart + (r.index || 0);
              if (idx < framesData.length) {
                allResults.push({
                  shotId: framesData[idx].shotId,
                  scene: (r.scene || '未分类').trim(),
                  type: r.type === 'non_shot' ? 'non_shot' : 'shot'
                });
              }
            }
          }
        }
      } catch (e) {
        console.error(`[AI] 场次分析批次失败:`, e.message);
      }
    }

    res.json({ success: true, results: allResults });
  } catch (error) {
    console.error('[app] AI 场次分析失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 分析分镜画面内容
app.post('/api/ai/analyze-shot', async (req, res) => {
  try {
    const { shotId, mediaUrl, mediaType, provider, model } = req.body;

    if (!shotId || !mediaUrl) {
      return res.status(400).json({ success: false, message: '缺少 shotId 或 mediaUrl' });
    }

    const shot = await db.items.getById(parseInt(shotId));
    if (!shot) {
      return res.status(404).json({ success: false, message: '分镜不存在' });
    }

    const settings = await db.settings.getAll();

    // 默认值：从 settings 读取 AI 分析模型配置
    const finalProvider = provider || settings.analyze_llm_provider || 'geekai';
    const finalModel = model || settings.analyze_llm_model || 'gpt-4o-mini';

    // 创建任务
    const task = await db.aiTasks.create({
      id: crypto.randomUUID(),
      type: 'analyze_shot',
      status: 'pending',
      projectId: shot.projectId || null,
      input: { shotId, mediaUrl, mediaType, provider: finalProvider, model: finalModel }
    });

    res.json({ success: true, taskId: task.id });

    // 异步处理
    processAnalyzeShot(task.id, mediaUrl, mediaType, finalProvider, finalModel);
  } catch (error) {
    console.error('[app] 创建AI分析任务失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 分析分镜画面后台处理
async function processAnalyzeShot(taskId, mediaUrl, mediaType, provider, model) {
  try {
    await db.aiTasks.update(taskId, { status: 'processing', progress: 10 });
    const settings = await db.settings.getAll();

    let finalMediaUrl = mediaUrl;
    let finalMediaType = mediaType;

    if (isOSSConfigured && ossClient && mediaUrl) {
      try {
        const ossKey = extractOssKeyFromUrl(mediaUrl);
        if (ossKey) {
          if (mediaType === 'video') {
            finalMediaUrl = ossClient.signatureUrl(ossKey, {
              expires: 3600,
              process: 'video/snapshot,t_1000,f_jpg,w_800,m_fast'
            });
            finalMediaType = 'image';
          } else {
            finalMediaUrl = ossClient.signatureUrl(ossKey, { expires: 3600 });
          }
        }
      } catch (e) {
        console.warn('[analyze-shot] OSS URL签名失败，使用原始URL:', e.message);
      }
    }

    const result = await aiClient.analyzeShotImage(finalMediaUrl, finalMediaType, provider, model, settings);

    await db.aiTasks.update(taskId, {
      status: 'done',
      progress: 100,
      output: result
    });
  } catch (error) {
    console.error('[app] AI分析失败:', error.message);
    await db.aiTasks.update(taskId, {
      status: 'error',
      error: aiClient.friendlyAiError(error)
    });
  }
}

// ========== AI 后台处理函数 ==========

/**
 * 根据场次名称数组自动创建场次，返回名称到 ID 的映射
 * @param {number} projectId 项目 ID
 * @param {string[]} sceneNames 场次名称数组（按出现顺序）
 * @param {number|null} manualSceneId 用户手动指定的场次 ID，如指定则跳过自动划分
 * @returns {Promise<Map<string, number>>} 场次名称到 ID 的映射（小写 key 用于匹配）
 */
async function autoAssignScenesByNames(projectId, sceneNames, manualSceneId) {
  const sceneMap = new Map();

  if (manualSceneId !== undefined && manualSceneId !== null) {
    return sceneMap;
  }

  if (!sceneNames || sceneNames.length === 0) {
    return sceneMap;
  }

  const seenKeys = new Set();
  const orderedNames = [];

  for (const name of sceneNames) {
    if (!name || !name.trim()) continue;
    const key = name.trim().toLowerCase();
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      orderedNames.push(name.trim());
    }
  }

  if (orderedNames.length === 0) {
    return sceneMap;
  }

  for (const name of orderedNames) {
    try {
      const scene = await db.scenes.create(projectId, name);
      const key = name.toLowerCase();
      sceneMap.set(key, scene.id);
    } catch (err) {
      console.error('[autoAssignScenes] 创建场次失败:', name, err.message);
    }
  }

  return sceneMap;
}

// P5-1：重构 processScriptParse，支持五条路径（A1/A2/B/C/D）
// 参数 stage 取值：auto / intent / intent_confirmed / scene_confirmed / storyboard / shooting
async function processScriptParse(taskId, scriptContent, stage, params) {
  try {
    const settings = await db.settings.getAll();
    const autoAssignScene = params.sceneId === undefined || params.sceneId === null;
    const llmOptions = {
      provider: params.provider || 'geekai',
      model: params.model || 'deepseek-chat'
    };

    if (stage === 'auto') {
      // 阶段0：AI 判断文档类型
      const analyzeResult = await aiClient.analyzeScriptType(scriptContent, settings, taskId, llmOptions);

      if (!analyzeResult.canGenerate) {
        // 路径D：文档无效，无法生成分镜
        await db.aiTasks.update(taskId, {
          status: 'error',
          error: analyzeResult.suggestion || '文档内容无效，无法根据该文档生成分镜，请上传与视频内容相关的文档'
        });
        return;
      }

      if (analyzeResult.hasStoryboard && analyzeResult.hasScene) {
        // 路径A1：已含分镜 + 已含场次 → 直接生成规范分镜数据
        return await processFinalShots(taskId, scriptContent, 'script', settings, params, autoAssignScene, llmOptions);
      } else if (analyzeResult.hasStoryboard && !analyzeResult.hasScene) {
        // 路径A2：已含分镜但不含场次 → AI 生成场次划分，待用户确认
        const result = await aiClient.generateSceneDivision(scriptContent, settings, taskId, llmOptions);
        await db.aiTasks.update(taskId, {
          status: 'done',
          progress: 100,
          output: { type: 'scene_division', content: result.content }
        });
        return;
      } else {
        // 路径B：不含分镜但可生成 → 先进入阶段1（生成分镜脚本）
        const result = await aiClient.generateStoryboardScript(scriptContent, settings, taskId, llmOptions);
        await db.aiTasks.update(taskId, {
          status: 'done',
          progress: 100,
          output: { type: 'storyboard_script', content: result.content }
        });
        return;
      }
    }

    if (stage === 'intent') {
      // 路径C：用户输入制片意图 → AI 生成视频文案，待用户确认
      const result = await aiClient.generateVideoCopy(scriptContent, settings, taskId, llmOptions);
      await db.aiTasks.update(taskId, {
        status: 'done',
        progress: 100,
        output: { type: 'video_copy', content: result.content }
      });
      return;
    }

    if (stage === 'intent_confirmed') {
      // 路径C：用户确认视频文案后，进入阶段1（生成分镜脚本）
      const result = await aiClient.generateStoryboardScript(scriptContent, settings, taskId, llmOptions);
      await db.aiTasks.update(taskId, {
        status: 'done',
        progress: 100,
        output: { type: 'storyboard_script', content: result.content }
      });
      return;
    }

    if (stage === 'scene_confirmed') {
      // 路径A2：用户确认场次划分后，生成规范分镜数据
      // scriptContent 为原文档内容 + 用户确认的场次划分
      return await processFinalShots(taskId, scriptContent, 'script', settings, params, autoAssignScene, llmOptions);
    }

    if (stage === 'storyboard') {
      // 路径B/C 阶段1：用户确认叙事流后，进入阶段2（生成拍摄脚本）
      const result = await aiClient.generateShootingScript(scriptContent, settings, taskId, llmOptions);
      await db.aiTasks.update(taskId, {
        status: 'done',
        progress: 100,
        output: { type: 'shooting_script', content: result.content }
      });
      return;
    }

    if (stage === 'shooting') {
      // 路径B/C 阶段2：用户确认拍摄脚本后，生成规范分镜数据
      return await processFinalShots(taskId, scriptContent, 'script', settings, params, autoAssignScene, llmOptions);
    }

    // 兼容性：未知 stage 按旧 mode 逻辑直接生成最终分镜
    console.warn(`[AI] processScriptParse 收到未知 stage=${stage}，按旧 mode 逻辑处理`);
    return await processFinalShots(taskId, scriptContent, stage, settings, params, autoAssignScene, llmOptions);
  } catch (error) {
    console.error('[AI] 脚本解析失败:', error.message);
    // P4-5：复用公共 friendlyAiError，按错误类型给出友好提示
    await db.aiTasks.update(taskId, {
      status: 'error',
      error: aiClient.friendlyAiError(error)
    });
  }
}

/**
 * P5-1：最终生成分镜数据处理（A1 / A2 scene_confirmed / B/C shooting 共用）
 * 调用 aiClient.generateFinalShots 生成 JSON 分镜数据，解析并保存到任务输出
 */
async function processFinalShots(taskId, scriptContent, mode, settings, params, autoAssignScene, llmOptions) {
  const result = await aiClient.generateFinalShots(scriptContent, mode, settings, taskId, {
    autoAssignScene,
    ...llmOptions
  });

  // 解析返回的 JSON
  let shotsData = [];
  let digitalAssets = { mainActors: [], keyProps: [], mainScenes: [] };
  try {
    const jsonMatch = result.content.match(/```json\s*([\s\S]*?)\s*```/) || result.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      shotsData = Array.isArray(parsed) ? parsed : (parsed.shots || []);
      // 提取数字资产信息
      if (parsed.digitalAssets) {
        digitalAssets = {
          mainActors: parsed.digitalAssets.mainActors || [],
          keyProps: parsed.digitalAssets.keyProps || [],
          mainScenes: parsed.digitalAssets.mainScenes || []
        };
      }
    }
  } catch (e) {
    console.error('[AI] 解析脚本返回数据失败:', e.message);
    // P4-5 扩展：JSON 解析失败时降级为单个分镜，避免整个任务失败
    const fallbackShot = [{
      shotIndex: 1,
      shotType: '未知',
      title: '原始脚本内容',
      sceneContent: result.content.substring(0, 2000),
      hasShotCut: false,
      isStockOrEffect: false,
      actors: '', props: '', costume: '', location: '',
      focalLength: '', narration: '', cameraMovement: '',
      shotAngle: '', lighting: '', notes: '',
      estimatedDuration: '', aiImagePrompt: '',
      sceneName: '',
      sceneId: params.sceneId
    }];
    await db.aiTasks.update(taskId, {
      status: 'done',
      progress: 100,
      output: {
        type: 'shots',
        shots: fallbackShot,
        total: 1,
        scenesCreated: 0,
        sceneMap: {},
        digitalAssets: { mainActors: [], keyProps: [], mainScenes: [] },
        warning: 'AI 返回数据格式异常，已降级为原始内容，请手动编辑分镜字段'
      }
    });
    return;
  }

  // 自动划分场次（如果启用）
  let sceneMap = new Map();
  if (autoAssignScene && shotsData.length > 0) {
    const sceneNames = shotsData.map(s => s.sceneName).filter(Boolean);
    if (sceneNames.length > 0) {
      sceneMap = await autoAssignScenesByNames(params.projectId, sceneNames, null);
    }
  }

  // 提取 hasShotCut 和 isStockOrEffect 信息
  const shotsWithFlags = shotsData.map((shotData, idx) => ({
    shotIndex: idx + 1,
    shotType: shotData.shotType || '未知',
    title: shotData.title || shotData.sceneContent?.substring(0, 20) || `镜头 ${idx + 1}`,
    sceneContent: shotData.sceneContent || '',
    hasShotCut: shotData.hasShotCut || false,
    isStockOrEffect: shotData.isStockOrEffect || false,
    actors: shotData.actors || '',
    props: shotData.props || '',
    costume: shotData.costume || '',
    location: shotData.location || '',
    focalLength: shotData.focalLength || '',
    narration: shotData.narration || '',
    cameraMovement: shotData.cameraMovement || '',
    shotAngle: shotData.shotAngle || '',
    lighting: shotData.lighting || '',
    notes: shotData.notes || '',
    estimatedDuration: shotData.estimatedDuration || '',
    aiImagePrompt: shotData.aiImagePrompt || '',
    sceneName: shotData.sceneName || '',
    sceneId: autoAssignScene && shotData.sceneName && shotData.sceneName.trim()
      ? sceneMap.get(shotData.sceneName.trim().toLowerCase()) || null
      : params.sceneId
  }));

  await db.aiTasks.update(taskId, {
    status: 'done',
    progress: 100,
    output: {
      type: 'shots',
      shots: shotsWithFlags,
      total: shotsWithFlags.length,
      scenesCreated: sceneMap.size,
      sceneMap: Object.fromEntries(sceneMap),
      digitalAssets: digitalAssets
    }
  });

  console.log(`[AI] 最终分镜生成完成: ${shotsWithFlags.length} 个分镜，${sceneMap.size} 个场次，数字资产: ${digitalAssets.mainActors.length} 角色, ${digitalAssets.keyProps.length} 道具, ${digitalAssets.mainScenes.length} 场景`);
}

async function processImageGen(taskId, shot, prompt, userSelectedImageUrls, size, provider, model, quality, options = {}) {
  const { previewOnly = false } = options;
  // 跟踪已上传到项目 OSS 的图片 URL（用于失败时清理，避免残留）
  let uploadedOssUrl = '';
  try {
    const settings = await db.settings.getAll();
    
    // 获取 API Key
    const apiKey = aiClient.getApiKey(provider, settings);
    if (!apiKey) {
      throw new Error(`${provider} API Key 未配置，请在设置中配置或检查环境变量`);
    }
    const baseUrl = aiClient.getBaseUrl(provider);
    
    // P3-24：确定参考图 URL 数组（用户选择 > 自动匹配）
    // userSelectedImageUrls 已是数组（[] 或 [url1, url2, ...]）
    let styleRefImageUrls = Array.isArray(userSelectedImageUrls) ? userSelectedImageUrls.filter(u => u) : [];
    
    // 若用户未选择参考图，按地点/场次自动匹配（保持原有行为，单图回退）
    if (styleRefImageUrls.length === 0) {
      if (shot.location && shot.location.trim()) {
        // 按地点匹配场景数字资产
        const normalizedLocation = shot.location.trim().toLowerCase();
        const sceneAssets = await db.digitalAssets.getByProjectId(shot.projectId, 'scene');
        const matchedAsset = sceneAssets.find(a => a.name && a.name.trim().toLowerCase() === normalizedLocation && a.imageUrl);
        if (matchedAsset) {
          styleRefImageUrls = [matchedAsset.imageUrl];
          console.log(`[AI] 使用场景数字资产作为参考图（地点匹配: ${shot.location}）: ${styleRefImageUrls[0].substring(0, 50)}...`);
        } else {
          // 按地点查找同项目下的参考图
          const locationImages = await db.shotMedia.getByLocation(shot.projectId, shot.location);
          if (locationImages && locationImages.length > 0) {
            styleRefImageUrls = [locationImages[0].url];
            console.log(`[AI] 使用同地点参考图作为风格参考（地点: ${shot.location}）: ${styleRefImageUrls[0].substring(0, 50)}...`);
          }
        }
      }
      
      // 如果地点没找到，回退到按场次查找
      if (styleRefImageUrls.length === 0 && shot.sceneId) {
        const sceneImages = await db.shotMedia.getBySceneId(shot.sceneId);
        if (sceneImages && sceneImages.length > 0) {
          styleRefImageUrls = [sceneImages[0].url];
          console.log(`[AI] 使用同场次参考图作为风格参考: ${styleRefImageUrls[0].substring(0, 50)}...`);
        }
      }
    } else {
      console.log(`[AI] 使用用户选择的 ${styleRefImageUrls.length} 张参考图`);
    }
    
    // P3-24：对所有 OSS 私有 URL 生成签名 URL
    const signOssUrl = (url) => {
      if (!url || !isOSSConfigured || !ossClient || !url.includes('aliyuncs.com')) return url;
      try {
        const keyMatch = url.match(/aliyuncs\.com\/([^?]+)/);
        if (keyMatch) {
          const ossKey = decodeURIComponent(keyMatch[1]);
          return ossClient.signatureUrl(ossKey, { expires: 3600 });
        }
      } catch (e) {
        console.warn('[AI] 参考图签名失败，使用原始 URL:', e.message);
      }
      return url;
    };
    const signedRefUrls = styleRefImageUrls.map(signOssUrl);
    
    // 获取模型配置，检查是否支持图生图
    const imageModels = settings.image_models || [];
    const modelConfig = imageModels.find(m => m.model === model && m.provider === provider);
    const supportsImageRef = modelConfig?.supportsImageRef || false;
    
    // 生成最终 prompt
    let finalPrompt = prompt || shot.aiImagePrompt || shot.sceneContent;
    
    // 调用 AI 生图
    let result;
    if (signedRefUrls.length > 0 && supportsImageRef) {
      // 模型支持图生图：当前 aiClient.callImageGenWithRef 仅支持单图，取第一张
      // 多图扩展待后续支持（受限于各家 API 单次只能传 1 张参考图）
      if (signedRefUrls.length > 1) {
        console.log(`[AI] 模型仅支持单张参考图，使用第一张（共 ${signedRefUrls.length} 张）`);
      }
      console.log(`[AI] 使用图生图模式，模型: ${model}，参考图: ${signedRefUrls[0].substring(0, 50)}...`);
      result = await aiClient.callImageGenWithRefWithRetry(model, finalPrompt, signedRefUrls[0], quality, size || '1024x576', baseUrl, apiKey);
    } else if (signedRefUrls.length > 0 && !supportsImageRef) {
      // 模型不支持图生图：分析所有参考图风格并融入 prompt
      console.log(`[AI] 模型不支持图生图，分析 ${signedRefUrls.length} 张参考图风格融入 prompt`);
      const styleDescs = await Promise.all(
        signedRefUrls.map(u => aiClient.analyzeSceneImage(u, settings, taskId))
      );
      const validDescs = styleDescs.filter(Boolean);
      if (validDescs.length > 0) {
        finalPrompt = `${validDescs.join('，')}, ${finalPrompt}`;
      }
      result = await aiClient.callImageGenWithRetry(model, finalPrompt, quality, size || '1024x576', baseUrl, apiKey);
    } else {
      // 无参考图，直接文生图
      console.log(`[AI] 直接文生图，模型: ${model}`);
      result = await aiClient.callImageGenWithRetry(model, finalPrompt, quality, size || '1024x576', baseUrl, apiKey);
    }
    
    // 上传到 OSS
    let imageUrl = result.url;
    let fileSize = 0;
    if (!previewOnly && isOSSConfigured && ossClient && imageUrl) {
      try {
        const response = await fetch(imageUrl);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          let fileBuffer = Buffer.from(buffer);
          fileSize = fileBuffer.length;
          // AI 生图压缩：超过阈值则压缩
          const aiThresholdStr = await db.settings.get('image_compress_threshold_kb');
          const aiThresholdKB = aiThresholdStr ? parseInt(aiThresholdStr) : 300;
          if (fileSize > aiThresholdKB * 1024) {
            try {
              fileBuffer = await compressImage(fileBuffer, aiThresholdKB, 'image/png');
              fileSize = fileBuffer.length;
              console.log(`[AI] 参考图已压缩: ${buffer.byteLength} -> ${fileSize} bytes`);
            } catch (e) {
              console.warn('[AI] 参考图压缩失败，使用原图:', e.message);
            }
          }
          const ext = 'png';
          const fileName = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 8)}.${ext}`;
          const folder = `projects/${shot.projectId}/shot-references/images`;
          const ossKey = `${folder}/${fileName}`;
          const ossResult = await ossClient.put(ossKey, fileBuffer);
          imageUrl = ossResult.url;
          uploadedOssUrl = imageUrl;
          console.log(`[AI] 参考图已上传到 OSS: ${ossKey}`);
        }
      } catch (e) {
        console.warn('[AI] 参考图 OSS 上传失败，使用原始 URL:', e.message);
      }
    }

    // Q1：previewOnly 模式不上传 OSS、不创建 shot_media、不写历史记录
    // 用户确认选择后由 /api/ai/upload-preview-image 统一处理
    if (!previewOnly) {
      // P3-22：同步写入 ai_generated_images 历史记录（ownerType='shot'）
      try {
        await db.storyboardAsync.run(
          `INSERT INTO ai_generated_images (ownerType, ownerId, url, prompt, model, provider, size, fileSize, sortOrder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ['shot', shot.id, imageUrl, finalPrompt || '', model || '', provider || '', size || '', fileSize, 0]
        );
      } catch (e) {
        console.warn('[AI] 写入 ai_generated_images 历史失败:', e.message);
      }
      // OSS 文件已被 ai_generated_images 引用，后续失败不再清理
      uploadedOssUrl = '';
    }

    // 记录 AI 使用日志
    await aiClient.recordUsage({
      type: 'image',
      model,
      provider,
      quality,
      imageCount: 1,
      taskId
    }, settings);

    await db.aiTasks.update(taskId, {
      status: 'done',
      progress: 100,
      output: { imageUrl, uploaded: !previewOnly, fileSize }
    });

    console.log(`[AI] 参考图生成完成: ${imageUrl} (previewOnly=${previewOnly})`);
  } catch (error) {
    console.error('[AI] 参考图生成失败:', error.message);
    // 失败时清理已上传到项目 OSS 的图片文件，避免残留
    if (uploadedOssUrl) {
      try {
        await deleteStandaloneOssFile(uploadedOssUrl);
        console.log('[AI] 生成失败，已清理 OSS 图片:', uploadedOssUrl);
      } catch (cleanupErr) {
        console.error('[AI] 清理 OSS 图片失败:', cleanupErr.message);
      }
    }
    await db.aiTasks.update(taskId, {
      status: 'error',
      error: aiClient.friendlyAiError(error)
    });
  }
}

async function processVideoSplit(taskId, videoUrl, params) {
  try {
    const mode = params.mode || 'ai_frame';

    // P3-26：获取视频 OSS 文件大小，用于 shot_media 统计
    // 失败不阻塞流程，shot_media.size 退化为 0
    let videoSize = 0;
    try {
      videoSize = await getOssFileSize(videoUrl);
    } catch (e) {
      console.warn('[AI] 获取视频大小失败:', e.message);
    }
    const splitParams = { ...params, videoSize };

    if (mode === 'manual') {
      await processVideoSplitManual(taskId, videoUrl, splitParams);
    } else if (mode === 'aliyun') {
      await processVideoSplitAliyunMode(taskId, videoUrl, splitParams);
    } else {
      await processVideoSplitAIFrameMode(taskId, videoUrl, splitParams);
    }
  } catch (error) {
    console.error('[AI] 视频分割失败:', error.message);
    await db.aiTasks.update(taskId, {
      status: 'error',
      error: aiClient.friendlyAiError(error)
    });
  }
}

/**
 * 通用生图处理函数（不需要 shotId）
 * P3-24：refImageUrls 改为数组，支持多参考图
 */
async function processGenericImageGen(taskId, prompt, refImageUrls, size, provider, model, quality, ownerInfo) {
  const { previewOnly = false } = ownerInfo || {};
  try {
    const settings = await db.settings.getAll();

    // P3-24：归一化参考图为数组
    const normalizedRefUrls = Array.isArray(refImageUrls) ? refImageUrls.filter(u => u) : (refImageUrls ? [refImageUrls] : []);

    // 对所有 OSS 私有 URL 生成签名 URL
    const signOssUrl = (url) => {
      if (!url || !isOSSConfigured || !ossClient || !url.includes('aliyuncs.com')) return url;
      try {
        const keyMatch = url.match(/aliyuncs\.com\/([^?]+)/);
        if (keyMatch) {
          const ossKey = decodeURIComponent(keyMatch[1]);
          return ossClient.signatureUrl(ossKey, { expires: 3600 });
        }
      } catch (e) {
        console.warn('[AI] 参考图签名失败，使用原始 URL:', e.message);
      }
      return url;
    };
    const signedRefUrls = normalizedRefUrls.map(signOssUrl);

    // 获取 API Key 和 Base URL
    const apiKey = aiClient.getApiKey(provider, settings);
    if (!apiKey) {
      throw new Error(`${provider} API Key 未配置，请在设置中配置或检查环境变量`);
    }
    const baseUrl = aiClient.getBaseUrl(provider);

    // 查找模型配置以判断是否支持图生图
    const imageModels = settings.image_models || [];
    const modelConfig = imageModels.find(m => m.model === model && m.provider === provider);
    const supportsImageRef = modelConfig?.supportsImageRef || false;

    console.log(`[AI] 通用生图: ${provider}/${model} (quality=${quality}, 参考图=${signedRefUrls.length}张, 图生图=${signedRefUrls.length > 0 && supportsImageRef ? '是' : '否'})`);

    let finalPrompt = prompt;
    let result;
    if (signedRefUrls.length > 0 && supportsImageRef) {
      // 模型支持图生图：取第一张（API 单图限制）
      if (signedRefUrls.length > 1) {
        console.log(`[AI] 模型仅支持单张参考图，使用第一张（共 ${signedRefUrls.length} 张）`);
      }
      result = await aiClient.callImageGenWithRefWithRetry(model, prompt, signedRefUrls[0], quality, size || '1024x576', baseUrl, apiKey);
    } else if (signedRefUrls.length > 0 && !supportsImageRef) {
      // 模型不支持图生图：分析所有参考图风格融入 prompt
      console.log(`[AI] 模型不支持图生图，分析 ${signedRefUrls.length} 张参考图风格融入 prompt`);
      const styleDescs = await Promise.all(
        signedRefUrls.map(u => aiClient.analyzeSceneImage(u, settings, taskId))
      );
      const validDescs = styleDescs.filter(Boolean);
      if (validDescs.length > 0) {
        finalPrompt = `${validDescs.join('，')}, ${prompt}`;
      }
      result = await aiClient.callImageGenWithRetry(model, finalPrompt, quality, size || '1024x576', baseUrl, apiKey);
    } else {
      result = await aiClient.callImageGenWithRetry(model, prompt, quality, size || '1024x576', baseUrl, apiKey);
    }

    // 上传到 OSS
    let imageUrl = result.url;
    let fileSize = 0;
    if (!previewOnly && isOSSConfigured && ossClient && imageUrl) {
      try {
        const response = await fetch(imageUrl);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          let fileBuffer = Buffer.from(buffer);
          fileSize = fileBuffer.length;
          // AI 生图压缩：超过阈值则压缩
          const aiThresholdStr = await db.settings.get('image_compress_threshold_kb');
          const aiThresholdKB = aiThresholdStr ? parseInt(aiThresholdStr) : 300;
          if (fileSize > aiThresholdKB * 1024) {
            try {
              fileBuffer = await compressImage(fileBuffer, aiThresholdKB, 'image/png');
              fileSize = fileBuffer.length;
              console.log(`[AI] 图片已压缩: ${buffer.byteLength} -> ${fileSize} bytes`);
            } catch (e) {
              console.warn('[AI] 图片压缩失败，使用原图:', e.message);
            }
          }
          const ext = 'png';
          const fileName = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 8)}.${ext}`;
          const projectId = ownerInfo && ownerInfo.projectId;
          if (!projectId) throw new Error('projectId 不能为空');
          const folder = `projects/${projectId}/digital-assets`;
          const ossKey = `${folder}/${fileName}`;
          const ossResult = await ossClient.put(ossKey, fileBuffer);
          imageUrl = ossResult.url;
          console.log(`[AI] 图片已上传到 OSS: ${ossKey}`);
        }
      } catch (e) {
        console.warn('[AI] 图片 OSS 上传失败，使用原始 URL:', e.message);
      }
    }

    // Q1：previewOnly 模式不写历史记录（URL 可能过期，确认后由 upload-preview-image 写入）
    if (!previewOnly && ownerInfo && ownerInfo.ownerType && ownerInfo.ownerId) {
      try {
        await db.storyboardAsync.run(
          `INSERT INTO ai_generated_images (ownerType, ownerId, url, prompt, model, provider, size, fileSize, sortOrder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ownerInfo.ownerType, parseInt(ownerInfo.ownerId), imageUrl, finalPrompt || '', model || '', provider || '', size || '', fileSize, 0]
        );
      } catch (e) {
        console.warn('[AI] 写入 ai_generated_images 历史失败:', e.message);
      }
    }

    // 记录使用日志
    await aiClient.recordUsage({
      type: 'image',
      model,
      provider,
      quality,
      imageCount: 1,
      taskId
    }, settings);

    await db.aiTasks.update(taskId, {
      status: 'done',
      progress: 100,
      output: { imageUrl, model, provider, uploaded: !previewOnly, fileSize }
    });

    console.log(`[AI] 通用生图完成: ${imageUrl} (previewOnly=${previewOnly})`);
  } catch (error) {
    console.error('[AI] 通用生图失败:', error.message);
    await db.aiTasks.update(taskId, {
      status: 'error',
      error: aiClient.friendlyAiError(error)
    });
  }
}

async function processVideoSplitAliyunMode(taskId, videoUrl, params) {
  const settings = await db.settings.getAll();
  await processVideoSplitAliyun(taskId, videoUrl, params, settings);
}

async function processVideoSplitAIFrameMode(taskId, videoUrl, params) {
  const settings = await db.settings.getAll();
  await processVideoSplitAIFrame(taskId, videoUrl, params, settings);
}

async function processVideoSplitManual(taskId, videoUrl, params) {
  // 手动模式直接按分割点创建分镜（不实际切割视频，只是记录分割点）
  const { splitPoints, videoDuration = 0 } = params;
  
  if (!splitPoints || splitPoints.length === 0) {
    await db.aiTasks.update(taskId, {
      status: 'error',
      error: '没有提供分割点'
    });
    return;
  }
  
  const defaultSceneId = params.sceneId || null;
  
  // 过滤首尾帧附近的分割点（0.5秒阈值）
  const EDGE_THRESHOLD = 0.5;
  const sortedPoints = [...splitPoints]
    .filter(p => p > EDGE_THRESHOLD && p < videoDuration - EDGE_THRESHOLD)
    .sort((a, b) => a - b);
  
  // 创建分镜记录（N个分割点生成N+1个分镜）
  const createdShots = [];
  
  const times = [0, ...sortedPoints, videoDuration || 0];
  const segmentCount = times.length - 1;
  
  for (let i = 0; i < segmentCount; i++) {
    const startTime = times[i];
    const endTime = times[i + 1];
    const segmentDuration = endTime - startTime;
    
    const shot = await db.items.createShot({
      projectId: params.projectId,
      sceneId: defaultSceneId,
      sceneContent: `镜头 ${i + 1}`,
      notes: `时间范围: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s`,
      status: 'pending'
    });
    
    // 保存视频 URL 到 shot_media
    const media = await db.shotMedia.create({
      shotId: shot.id,
      url: videoUrl,
      type: 'video',
      filename: '',
      size: params.videoSize || 0,
      duration: segmentDuration,
      startTime: startTime,
      sortOrder: 0,
      source: 'video_split'
    });
    
    createdShots.push({ ...shot, media: [media] });
    
    await db.aiTasks.update(taskId, {
      progress: Math.round(((i + 1) / segmentCount) * 100)
    });
  }
  
  await db.aiTasks.update(taskId, {
    status: 'done',
    progress: 100,
    output: { shots: createdShots, total: createdShots.length }
  });
  
  console.log(`[AI] 手动视频分割完成: 生成了 ${createdShots.length} 个分镜`);
}

async function processVideoSplitAliyun(taskId, videoUrl, params, settings) {

  if (!aliyunVideo.isAliyunConfigured()) {
    throw new Error('阿里云 AccessKey 未配置，请在设置中配置');
  }

  await db.aiTasks.update(taskId, {
    progress: 10,
    output: { stage: 'submitting_to_aliyun', provider: 'aliyun' }
  });

  // 使用 SDK 的 Stream 方式提交（参考阿里云文档 155645 方式一）
  // OSS 在 cn-beijing，视觉智能平台在 cn-shanghai，跨区不支持 URL 方式，
  // 必须通过 videoUrlObject 以流形式上传到 viapi 官方 OSS Bucket
  const ossKey = extractOssKeyFromUrl(videoUrl);
  if (!ossKey || !ossClient) {
    throw new Error('无法获取视频 OSS 流：ossKey 或 ossClient 不可用');
  }

  let stream;
  try {
    ({ stream } = await ossClient.getStream(ossKey));
    console.log(`[Aliyun] 开始读取 OSS 流: ${ossKey}`);
  } catch (e) {
    console.error('[Aliyun] 读取 OSS 视频流失败:', e.message);
    throw new Error(`读取 OSS 视频流失败: ${e.message}`);
  }

  // 提交任务（stream 上传由 SDK 内部完成，超时已在客户端配置为 10 分钟）
  const { jobId } = await aliyunVideo.submitSplitVideoTaskByStream(stream, {
    MinTime: params.minTime || 2,
    MaxTime: params.maxTime || 30
  });

  await db.aiTasks.update(taskId, {
    progress: 20,
    output: { stage: 'processing_aliyun', aliyunJobId: jobId }
  });

  // 轮询结果
  const maxWait = 10 * 60 * 1000;
  const pollInterval = 3000;
  const startTime = Date.now();
  let lastStatus = '';

  while (Date.now() - startTime < maxWait) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const result = await aliyunVideo.getSplitVideoResult(jobId);

    if (result.status !== lastStatus) {
      lastStatus = result.status;
      let progress = 20;
      if (result.status === 'PROCESSING') progress = 50;
      if (result.status === 'PROCESS_SUCCESS') progress = 90;

      await db.aiTasks.update(taskId, {
        progress: progress,
        output: { stage: `aliyun_${result.status.toLowerCase()}` }
      });
    }

    if (result.status === 'PROCESS_SUCCESS') {
      console.log('[Aliyun] 拆条结果原始数据:', JSON.stringify(result.result, null, 2));
      const parsed = aliyunVideo.parseSplitResult(result.result);
      console.log(`[Aliyun] 解析结果: ${parsed.shots.length} 个镜头, shotCount=${parsed.shotCount}, themeCount=${parsed.themeCount}`);
      // 直接返回时间范围，不创建 DB 分镜记录
      const shotRanges = parsed.shots.map((s, i) => ({
        startTime: s.beginTime || s.startTime || 0,
        endTime: s.endTime || 0,
        index: i,
        scene: s.theme || '',
        type: s.type || 'shot'
      }));
      await db.aiTasks.update(taskId, {
        status: 'done',
        progress: 100,
        output: { shots: shotRanges, total: shotRanges.length, provider: 'aliyun' }
      });
      console.log(`[AI] 阿里云视频拆条分析完成: 检测到 ${shotRanges.length} 个镜头`);
      return;
    }

    if (result.status === 'PROCESS_FAILED') {
      throw new Error(`阿里云视频拆条失败: ${result.error}`);
    }
  }

  throw new Error('视频拆条超时');
}

async function processVideoSplitAIFrame(taskId, videoUrl, params, settings) {
  
  try {
    await db.aiTasks.update(taskId, {
      progress: 5,
      output: { stage: 'downloading_video' }
    });
    
    // 对 OSS 私有 URL 生成签名 URL（否则 fetch 私有视频会返回 403）
    let downloadUrl = videoUrl;
    if (isOSSConfigured && ossClient && videoUrl.includes('aliyuncs.com')) {
      try {
        const keyMatch = videoUrl.match(/aliyuncs\.com\/([^?]+)/);
        if (keyMatch) {
          const ossKey = decodeURIComponent(keyMatch[1]);
          downloadUrl = ossClient.signatureUrl(ossKey, { expires: 3600 });
          console.log(`[AI] 视频 OSS URL 已签名，用于本地下载`);
        }
      } catch (e) {
        console.warn('[AI] 视频 URL 签名失败，使用原始 URL:', e.message);
      }
    }
    
    // 1. 下载视频到本地临时文件
    const tempVideoPath = path.join(os.tmpdir(), `qizi_temp_split_${taskId}.mp4`);
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`下载视频失败: HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(tempVideoPath, Buffer.from(arrayBuffer));
    } catch (e) {
      throw new Error(`视频下载失败: ${e.message}`);
    }
    
    await db.aiTasks.update(taskId, {
      progress: 15,
      output: { stage: 'detecting_scenes' }
    });
    
    // 2. 获取视频时长
    const metadata = await getVideoMetadata(tempVideoPath);
    const duration = metadata?.format?.duration || 0;
    
    if (!duration || duration < 1) {
      throw new Error('无法获取视频时长');
    }
    
    // 3. 使用 ffmpeg scene 滤镜检测镜头切换点
    await db.aiTasks.update(taskId, {
      progress: 30,
      output: { stage: 'detecting_scenes', duration: Math.round(duration) }
    });

    // 根据敏感度映射 threshold：高=0.15（更敏感，多检出）/ 中=0.3（平衡）/ 低=0.5（更保守，少检出）
    const SENSITIVITY_MAP = { high: 0.15, medium: 0.3, low: 0.5 };
    const sensitivity = params.sensitivity || 'medium';
    const threshold = SENSITIVITY_MAP[sensitivity] || 0.3;
    console.log(`[AI] 场景检测阈值: threshold=${threshold} (sensitivity=${sensitivity})`);

    const splitPoints = await detectSceneChanges(tempVideoPath, threshold);
    
    await db.aiTasks.update(taskId, {
      progress: 80,
      output: { stage: 'generating_result', splitPointsCount: splitPoints.length }
    });
    
    // 4. 过滤过短片段（合并间距 < 0.5秒的切换点）
    const filteredPoints = [];
    for (const pt of splitPoints) {
      if (filteredPoints.length === 0 || pt - filteredPoints[filteredPoints.length - 1] >= 0.5) {
        filteredPoints.push(pt);
      }
    }
    
    // 5. 构建时间范围结果
    const allPoints = [0, ...filteredPoints];
    const shotRanges = allPoints.map((startTime, i) => ({
      startTime: Math.round(startTime * 100) / 100,
      endTime: Math.round((allPoints[i + 1] || duration) * 100) / 100,
      index: i
    })).filter(s => s.endTime - s.startTime >= 0.5);  // 过滤过短片段
    
    await db.aiTasks.update(taskId, {
      status: 'done',
      progress: 100,
      output: { shots: shotRanges, total: shotRanges.length, provider: 'scene_detect' }
    });
    
    // 清理临时文件
    cleanupTempFiles(tempVideoPath);
    
    console.log(`[AI] 视频场景检测完成: 检测到 ${shotRanges.length} 个镜头 (时长 ${Math.round(duration)}秒)`);
  } catch (error) {
    const tempVideoPath = path.join(os.tmpdir(), `qizi_temp_split_${taskId}.mp4`);
    cleanupTempFiles(tempVideoPath);
    throw error;
  }
}

async function createShotsFromSplitPoints(taskId, videoUrl, shots, params, themeSegments) {
  await db.aiTasks.update(taskId, {
    progress: 85,
    output: { stage: 'creating_shots', shotsCount: shots.length }
  });

  const defaultSceneId = params.sceneId || null;
  const createdShots = [];

  // 按 beginTime 升序排列
  const sortedShots = [...shots].sort((a, b) => (a.beginTime || 0) - (b.beginTime || 0));

  for (let i = 0; i < sortedShots.length; i++) {
    const shotInfo = sortedShots[i];
    const startTime = shotInfo.beginTime || 0;
    const endTime = shotInfo.endTime || 0;
    const duration = endTime - startTime;

    let sceneContent = '';
    let notes = `时间范围: ${formatTime(startTime)} - ${formatTime(endTime)}`;

    if (shotInfo.type === 'theme' && shotInfo.theme) {
      sceneContent = shotInfo.theme;
      notes += `\n类型: 主题片段 - ${shotInfo.theme}`;
    } else {
      sceneContent = `镜头 ${i + 1}`;
      notes += `\n类型: 镜头转场`;
    }

    const shot = await db.items.createShot({
      projectId: params.projectId,
      sceneId: defaultSceneId,
      sceneContent: sceneContent,
      notes: notes,
      estimatedDuration: Math.round(duration).toString(),
      status: 'pending'
    });

    const media = await db.shotMedia.create({
      shotId: shot.id,
      url: videoUrl,
      type: 'video',
      filename: '',
      size: params.videoSize || 0,
      duration: duration,
      startTime: startTime,
      sortOrder: 0,
      source: 'video_split'
    });

    createdShots.push({ ...shot, media: [media] });

    await db.aiTasks.update(taskId, {
      progress: 85 + Math.round(((i + 1) / sortedShots.length) * 15)
    });
  }

  await db.aiTasks.update(taskId, {
    status: 'done',
    progress: 100,
    output: {
      shots: createdShots,
      total: createdShots.length,
      provider: 'aliyun'
    }
  });
}

async function createShotsFromSplitData(taskId, videoUrl, shots, params, videoSize) {
  const defaultSceneId = params.sceneId || null;
  const createdShots = [];

  for (let i = 0; i < shots.length; i++) {
    const shotInfo = shots[i];
    const startTime = shotInfo.startTime || shotInfo.beginTime || 0;
    const endTime = shotInfo.endTime || 0;
    const duration = endTime - startTime;

    const shot = await db.items.createShot({
      projectId: params.projectId,
      sceneId: defaultSceneId,
      sceneContent: `镜头 ${i + 1}（AI 自动分割）`,
      notes: `时间范围: ${formatTime(startTime)} - ${formatTime(endTime)}`,
      estimatedDuration: Math.round(duration).toString(),
      status: 'pending'
    });

    const media = await db.shotMedia.create({
      shotId: shot.id,
      url: videoUrl,
      type: 'video',
      filename: '',
      size: videoSize || 0,
      duration: duration,
      startTime: startTime,
      sortOrder: 0,
      source: 'video_split'
    });

    createdShots.push({ ...shot, media: [media] });

    await db.aiTasks.update(taskId, {
      progress: 80 + Math.round(((i + 1) / shots.length) * 20)
    });
  }

  await db.aiTasks.update(taskId, {
    status: 'done',
    progress: 100,
    output: {
      shots: createdShots,
      total: createdShots.length,
      provider: 'ai_frame'
    }
  });
}

// ========== 视频分割辅助函数 ==========

/**
 * 使用 ffmpeg scene 滤镜检测镜头切换点
 * 原理：逐帧计算画面变化分数，超过阈值即标记为切换点
 * @param {string} videoPath 本地视频文件路径
 * @param {number} threshold 场景变化阈值 (0-1)，默认 0.2（越低越敏感）
 * @returns {Promise<number[]>} 切换时间戳数组（秒）
 */
function detectSceneChanges(videoPath, threshold = 0.2) {
  const { spawn } = require('child_process');
  // 场景检测需要完整的 ffmpeg（含 scene 滤镜和 null muxer），
  // 系统 ffmpeg 可能是精简版（如 TRAE 内置版），强制使用 ffmpeg-static
  const ffmpegBin = require('ffmpeg-static');
  const isWindows = process.platform === 'win32';

  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      '-an',
      '-vf', `select='gt(scene\\,${threshold})',showinfo`,
      '-fps_mode', 'vfr',
      '-f', 'null',
      isWindows ? 'NUL' : '/dev/null'
    ];

    console.log(`[AI] 开始场景检测: threshold=${threshold}, video=${videoPath}, ffmpeg=${ffmpegBin}`);
    console.log(`[AI] ffmpeg args: ${args.join(' ')}`);
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timestamps = [];

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // 实时解析 showinfo 行: [Parsed_showinfo_1 @ ...] n:  0 pts: 123456 pts_time:5.123 ...
      const lines = text.split('\n');
      for (const line of lines) {
        const match = line.match(/pts_time:(\d+\.?\d*)/);
        if (match) {
          const t = parseFloat(match[1]);
          timestamps.push(t);
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0 || timestamps.length > 0) {
        // 排序并去重
        const sorted = [...new Set(timestamps.map(t => Math.round(t * 100) / 100))].sort((a, b) => a - b);
        console.log(`[AI] 场景检测完成: 检测到 ${sorted.length} 个切换点 (threshold=${threshold})`);
        resolve(sorted);
      } else {
        // 查找真正的错误行（不含 showinfo 输出）
        const errorLines = stderr.split('\n').filter(line =>
          line.trim() &&
          !line.includes('Parsed_showinfo') &&
          !line.includes('frame=') &&
          !line.includes('size=') &&
          !line.includes('bitrate=') &&
          !line.includes('speed=') &&
          !line.startsWith('[')
        );
        const errorMsg = errorLines.length > 0 ? errorLines.join('; ') : stderr.slice(-500);
        console.error(`[AI] ffmpeg 场景检测失败 exit=${code}: ${errorMsg}`);
        reject(new Error(`ffmpeg 场景检测失败: ${errorMsg}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg 启动失败: ${err.message}`));
    });
  });
}

function getVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

function extractFrames(videoPath, outputDir, intervalSeconds) {
  return new Promise((resolve, reject) => {
    const outputPattern = path.join(outputDir, 'frame_%04d.jpg');
    const fps = 1 / intervalSeconds;
    
    ffmpeg(videoPath)
      .outputOptions([
        `-vf fps=${fps},scale=480:-1`,
        '-q:v 5'
      ])
      .output(outputPattern)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

async function analyzeVideoShots(framesWithTime, totalDuration, settings, taskId, options = {}) {
  // 构建多模态消息
  // 限制图片数量，避免超出 token 限制
  const maxImagesPerRequest = 30;
  const frames = framesWithTime.slice(0, maxImagesPerRequest);
  const actualInterval = frames.length > 1 ? frames[1].time - frames[0].time : 3;

  // 构建图片内容数组
  const content = [];

  // 添加文本提示
  content.push({
    type: 'text',
    text: `请分析以下视频截图序列，找出镜头切换点，并判断每个分镜的类型和所属场次。

视频总时长：${totalDuration.toFixed(1)} 秒
截图间隔：约 ${actualInterval} 秒
共 ${frames.length} 张截图

请分析以下内容：
1. 找出明显的镜头切换点（时间戳，精确到整数秒）
2. 判断每个分镜的类型：
   - "shot"：实际拍摄内容（有人物、场景、动作等）
   - "non_shot"：非实拍内容（标题卡、字幕板、黑屏过渡、片尾字幕、纯文字画面等）
3. 为每个实拍分镜判断所属场次（基于画面环境，如"室内-客厅"、"室外-街道"、"办公室"等）

返回 JSON 格式：
{
  "splitPoints": [3, 8, 15, 22],
  "segments": [
    { "startTime": 0, "endTime": 3, "type": "non_shot", "scene": "标题" },
    { "startTime": 3, "endTime": 8, "type": "shot", "scene": "室内-客厅" },
    { "startTime": 8, "endTime": 15, "type": "shot", "scene": "室外-街道" }
  ]
}

要求：
- 只返回明显的场景/镜头转换，忽略轻微的镜头移动
- splitPoints 不包含 0 和视频结尾时间
- segments 的 startTime/endTime 与 splitPoints 对应（首段从 0 开始，末段到视频结束）
- 非实拍分镜的 scene 填写内容描述（如"标题"、"字幕"等）

截图列表（时间戳 + 图片）：`
  });

  // 添加每张图片及其时间戳
  for (const frame of frames) {
    content.push({
      type: 'text',
      text: `--- 第 ${frame.index + 1} 张（时间: ${formatTime(frame.time)}） ---`
    });
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${frame.base64}`,
        detail: 'low'
      }
    });
  }

  content.push({
    type: 'text',
    text: `请返回 JSON 格式结果，不要任何额外说明。`
  });

  const messages = [
    {
      role: 'user',
      content
    }
  ];

  // 使用支持视觉的多模态模型降级链（从用户配置读取）
  let multimodalChain;
  if (options.provider && options.model) {
    // 使用用户指定的模型
    multimodalChain = [{ model: options.model, provider: options.provider, cost: 0 }];
  } else {
    multimodalChain = (settings.llm_fallback_chain || [])
      .filter(m => m.supportsVision)
      .map(m => ({ model: m.model, provider: m.provider, cost: m.cost }));
  }

  try {
    const result = await aiClient.callChatWithFallback(messages, multimodalChain, settings, {
      temperature: 0.2,
      max_tokens: 3000,
      json: true,
      taskId
    });

    // 解析返回的 JSON
    let parsed = null;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn('[AI] 解析分割结果 JSON 失败:', e.message);
    }

    // 提取分割点
    let splitPoints = [];
    if (parsed && Array.isArray(parsed.splitPoints)) {
      splitPoints = parsed.splitPoints;
    } else if (Array.isArray(parsed)) {
      // 兼容旧格式（纯数组）
      splitPoints = parsed;
    }

    // 过滤和验证
    const validPoints = splitPoints
      .map(t => Math.round(Number(t)))
      .filter(t => !isNaN(t) && t > 0 && t < totalDuration);

    const uniquePoints = [...new Set(validPoints)].sort((a, b) => a - b);

    // 提取分镜段落信息
    let segments = null;
    if (parsed && Array.isArray(parsed.segments) && parsed.segments.length > 0) {
      segments = parsed.segments.map(seg => ({
        startTime: Math.round(Number(seg.startTime) || 0),
        endTime: Math.round(Number(seg.endTime) || totalDuration),
        type: seg.type === 'non_shot' ? 'non_shot' : 'shot',
        scene: (seg.scene || '').trim().substring(0, 50)
      }));
    }

    return { splitPoints: uniquePoints, segments };
  } catch (error) {
    console.error('[AI] 视频分析失败:', error.message);
    // 如果所有模型都失败了，返回一个粗略的分割（每 15 秒一个）
    const fallbackPoints = [];
    for (let t = 15; t < totalDuration; t += 15) {
      fallbackPoints.push(Math.round(t));
    }
    return { splitPoints: fallbackPoints, segments: null };
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function cleanupTempFiles(videoPath, framesDir) {
  try {
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }
    if (fs.existsSync(framesDir)) {
      fs.rmSync(framesDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[AI] 清理临时文件失败:', e.message);
  }
}

app.get('/api/aliyun/status', (req, res) => {
  res.json({
    success: true,
    configured: aliyunVideo.isAliyunConfigured(),
    service: 'videorecog'
  });
});

// MPS 配置状态检查
app.get('/api/aliyun/mps/status', (req, res) => {
  try {
    const creds = aliyunVideo.getAliyunCredentials ? aliyunVideo.getAliyunCredentials() : null;
    const ossConfig = aliyunVideo.getOSSConfig ? aliyunVideo.getOSSConfig() : null;
    res.json({
      success: true,
      configured: !!(creds && creds.mpsPipelineId),
      pipelineId: creds && creds.mpsPipelineId ? `${creds.mpsPipelineId.substring(0, 8)}***` : '(未设置)',
      ossBucket: ossConfig ? ossConfig.bucket : '(未设置)',
      ossLocation: ossConfig ? ossConfig.location : '(未设置)',
      mpsEndpoint: 'https://mts.cn-beijing.aliyuncs.com/',
      mpsRegion: 'cn-beijing'
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ========== MPS 视频转码 API ==========

// 提交转码任务
app.post('/api/aliyun/transcode', async (req, res) => {
  try {
    const { videoUrl, originalBitrate, targetBitrate, width, height, pipelineId, projectId, usage } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: '缺少 videoUrl 参数' });
    }

    if (!aliyunVideo.isAliyunConfigured()) {
      return res.status(400).json({ success: false, message: '阿里云 AccessKey 未配置' });
    }

    // 如果提供了原始码率，使用统一的码率阈值判断
    let finalTargetBitrate = targetBitrate;
    if (originalBitrate && (width || height)) {
      finalTargetBitrate = await getTargetBitrate(width || 0, height || 0);
      // 分辨率判断使用短边（与前端 getResolutionTier 一致）
      const shortSide = Math.min(width || 0, height || 0) || Math.max(width || 0, height || 0);
      const resolution = aliyunVideo.getResolutionFromMaxRes(shortSide);

      // 如果原始码率不超过目标码率，不需要压缩
      if (!aliyunVideo.shouldCompress(originalBitrate, finalTargetBitrate)) {
        console.log(`[MPS] 原始码率 ${originalBitrate}kbps 未超过目标码率 ${finalTargetBitrate}kbps (${resolution})，跳过压缩`);
        return res.json({
          success: true,
          skipped: true,
          message: '视频码率符合要求，无需压缩',
          originalUrl: videoUrl
        });
      }
    } else if (!finalTargetBitrate) {
      // 如果没有提供任何码率信息，使用默认配置
      finalTargetBitrate = await getTargetBitrate(width || 1920, height || 1080);
    }

    // 生成任务 ID
    const taskId = `transcode-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;

    // 初始化任务状态（持久化到数据库）
    const options = { targetBitrate: finalTargetBitrate, width, height, pipelineId, projectId, usage };
    await db.transcodeTasks.create({
      id: taskId,
      status: 'pending',
      progress: 0,
      videoUrl,
      projectId: projectId || null,
      options
    });

    // 提交转码任务到阿里云
    const result = await aliyunVideo.submitTranscodeTask(videoUrl, {
      targetBitrate: finalTargetBitrate,
      width,
      height,
      pipelineId
    });

    // 更新任务状态
    await db.transcodeTasks.update(taskId, {
      jobId: result.jobId,
      requestId: result.requestId,
      outputObject: result.outputObject,
      lastQueriedAt: new Date().toISOString()  // 心跳：提交时初始化
    });

    console.log(`[MPS] 转码任务已提交: ${taskId}, jobId: ${result.jobId}`);

    res.json({
      success: true,
      taskId,
      jobId: result.jobId
    });
  } catch (error) {
    console.error('[MPS] 提交转码任务失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 转码失败后清理原始视频：删除 DB 记录（shot_media / shots / videos / transcode_tasks）+ OSS 文件
// 由前端 uploadVideoWithAliyunCompression 在转码失败（提交失败/转码失败/超时）时调用
app.post('/api/aliyun/transcode-cleanup', async (req, res) => {
  try {
    const { videoUrl } = req.body || {};
    if (!videoUrl) {
      return res.status(400).json({ success: false, message: '缺少 videoUrl 参数' });
    }

    console.log(`[MPS] 转码失败清理开始: ${videoUrl}`);

    // 0. 检查并清除项目封面（如果封面是该视频）
    try {
      const videoBaseUrl = videoUrl.split('?')[0];
      const projectRows = await db.storyboardAsync.all(
        'SELECT id, coverUrl FROM projects WHERE coverUrl IS NOT NULL AND coverUrl != ?',
        [DEFAULT_PROJECT_COVER_PREFIX]
      );
      for (const proj of projectRows) {
        const coverBaseUrl = proj.coverUrl.split('?')[0];
        if (coverBaseUrl === videoBaseUrl) {
          await db.projects.update(proj.id, { coverUrl: '' });
          console.log(`[MPS] 转码失败清理：清除项目 ${proj.id} 封面`);
        }
      }
    } catch (e) {
      console.warn('[MPS] 转码失败清理：检查/清除封面失败:', e.message);
    }

    // 1. 收集 shot_media 中的 shotId（用于后续清理孤立 shots）
    const mediaRows = await db.storyboardAsync.all(
      'SELECT shotId FROM shot_media WHERE url = ?',
      [videoUrl]
    );
    const shotIds = mediaRows.map(r => r.shotId).filter(Boolean);

    // 2. 删除 shot_media 行
    try {
      await db.storyboardAsync.run('DELETE FROM shot_media WHERE url = ?', [videoUrl]);
    } catch (e) { console.error('[MPS] 清理 shot_media 失败:', e.message); }

    // 3. 删除因上一步而变得无媒体的 shots（刚创建的 shot 只有一个媒体，必然命中）
    if (shotIds.length > 0) {
      try {
        const placeholders = shotIds.map(() => '?').join(',');
        await db.storyboardAsync.run(
          `DELETE FROM shots WHERE id IN (${placeholders}) AND id NOT IN (SELECT DISTINCT shotId FROM shot_media)`,
          shotIds
        );
      } catch (e) { console.error('[MPS] 清理孤立 shots 失败:', e.message); }
    }

    // 4. 删除 videos 行（参考视频上传时创建）
    try {
      await db.storyboardAsync.run('DELETE FROM videos WHERE url = ?', [videoUrl]);
    } catch (e) { console.error('[MPS] 清理 videos 失败:', e.message); }

    // 5. 删除转码任务记录
    try {
      await db.storyboardAsync.run('DELETE FROM transcode_tasks WHERE videoUrl = ?', [videoUrl]);
    } catch (e) { console.error('[MPS] 清理 transcode_tasks 失败:', e.message); }

    // 6. 删除 OSS 原始文件（前面已删除所有 DB 引用，此处引用计数为 0，可安全删除）
    try {
      await deleteOssFileIfNotReferenced(videoUrl);
      console.log(`[MPS] 已删除原始 OSS 文件: ${videoUrl}`);
    } catch (e) { console.error('[MPS] 删除 OSS 文件失败:', e.message); }

    console.log(`[MPS] 转码失败清理完成: ${videoUrl}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[MPS] 转码失败清理异常:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 查询转码任务状态
app.get('/api/aliyun/transcode/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    let task = await db.transcodeTasks.get(taskId);

    if (!task) {
      return res.status(404).json({ success: false, message: '任务不存在' });
    }

    // 心跳：前端查询时刷新 lastQueriedAt（非终态任务才更新，避免无谓写入）
    if (task.status === 'pending' || task.status === 'processing') {
      try {
        await db.transcodeTasks.update(taskId, { lastQueriedAt: new Date().toISOString() });
      } catch (e) { /* 心跳更新失败不影响主流程 */ }
    }

    // 如果任务还在处理中,查询阿里云状态
    if (task.status === 'pending' || task.status === 'processing') {
      try {
        const result = await aliyunVideo.getTranscodeResult(task.jobId);

        const updates = {
          status: result.status,
          progress: result.progress
        };
        // 标记转码输出是否已上传到项目 OSS（用于 DB 更新失败时清理新文件）
        let isOurOssOutput = false;
        // 压缩后视频大小（字节）；在内层 try 下载成功后赋值，用于更新 DB 的 size 字段
        let compressedSize = 0;
        // MPS 输出文件 URL（转码完成后保存在此变量，用于后续清理）
        let mpsOutputUrl = '';

        if (result.status === 'done' && result.outputUrl) {
          // 转码完成,下载输出视频并上传到项目 OSS
          console.log(`[MPS] 转码完成: ${taskId}, 输出 URL: ${result.outputUrl}`);
          mpsOutputUrl = result.outputUrl;

          try {
            // P2-4：MPS 输出 URL 在私有 bucket 下不可直接访问，需先签名再下载
            let downloadUrl = result.outputUrl;
            if (isOSSConfigured && ossClient) {
              const mpsOssKey = extractOssKeyFromUrl(result.outputUrl);
              if (mpsOssKey) {
                try {
                  downloadUrl = ossClient.signatureUrl(mpsOssKey, { expires: 600 });
                } catch (signErr) {
                  console.warn('[MPS] 签名 MPS 输出 URL 失败，使用原始 URL:', signErr.message);
                }
              }
            }
            // 下载转码后的视频
            const response = await fetch(downloadUrl);
            if (!response.ok) {
              throw new Error(`下载转码视频失败: HTTP ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            compressedSize = buffer.length;

            // 上传到项目 OSS（按 usage 分类路径）
            const ossConfig = aliyunVideo.getOSSConfig();
            const ext = 'mp4';
            const fileName = `transcode-${Date.now()}-${Math.random().toString(36).substr(2, 8)}.${ext}`;
            const taskUsage = task.options && task.options.usage;
            let folder;
            const taskProjectId = task.options && task.options.projectId;
            if (!taskProjectId) throw new Error('转码任务缺少 projectId');
            if (taskUsage === 'project-reference') {
              folder = `projects/${taskProjectId}/project-references`;
            } else if (taskUsage === 'shot-reference') {
              folder = `projects/${taskProjectId}/shot-references/videos`;
            } else {
              folder = `projects/${taskProjectId}/videos`;
            }
            const ossKey = `${folder}/${fileName}`;

            if (isOSSConfigured && ossClient) {
              const ossResult = await ossClient.put(ossKey, buffer);
              updates.outputUrl = ossResult.url;
              isOurOssOutput = true;
              console.log(`[MPS] 转码视频已上传到 OSS: ${ossKey}`);
            } else {
              // 如果 OSS 未配置,使用 MPS 输出的 URL
              updates.outputUrl = result.outputUrl;
              console.log(`[MPS] OSS 未配置,使用 MPS 输出 URL: ${result.outputUrl}`);
            }
          } catch (uploadError) {
            console.warn('[MPS] 上传转码视频失败,使用 MPS 输出 URL:', uploadError.message);
            updates.outputUrl = result.outputUrl;
          }
        }

        if (result.status === 'error') {
          updates.error = result.error;
          console.error(`[MPS] 转码失败: ${taskId}, error: ${result.error}`);
        }

        // 转码成功：更新 videos/shot_media 行的 url 和 size，并删除 OSS 原始文件 + MPS 输出文件
        if (updates.outputUrl && task.videoUrl && updates.outputUrl !== task.videoUrl) {
          // 心跳检查：若用户已离开（超过 5 分钟未查询状态），清理所有 OSS 文件，不写 DB
          const lastQueriedAt = task.lastQueriedAt ? new Date(task.lastQueriedAt).getTime() : Date.now();
          const lastQueryAge = Date.now() - lastQueriedAt;
          if (lastQueryAge > HEARTBEAT_TIMEOUT_MS) {
            console.log(`[MPS] 用户已离开（${Math.round(lastQueryAge / 1000 / 60)}分钟未查询），清理孤儿任务 OSS 文件: ${taskId}`);
            // 清理新上传到项目 OSS 的转码文件
            if (isOurOssOutput && updates.outputUrl) {
              try {
                await deleteStandaloneOssFile(updates.outputUrl);
                console.log('[MPS] 孤儿任务：已清理新转码 OSS 文件:', updates.outputUrl);
              } catch (e) { console.warn('[MPS] 孤儿任务：清理新转码 OSS 文件失败:', e.message); }
            }
            // 清理 MPS 输出文件
            if (mpsOutputUrl && mpsOutputUrl !== task.videoUrl && mpsOutputUrl !== updates.outputUrl) {
              try {
                await deleteOssFile(mpsOutputUrl);
                console.log('[MPS] 孤儿任务：已清理 MPS 输出文件:', mpsOutputUrl);
              } catch (e) { console.warn('[MPS] 孤儿任务：清理 MPS 输出文件失败:', e.message); }
            }
            // 清理原始 OSS 源文件
            try {
              await deleteOssFileIfNotReferenced(task.videoUrl);
              console.log('[MPS] 孤儿任务：已清理原始 OSS 文件:', task.videoUrl);
            } catch (e) { console.warn('[MPS] 孤儿任务：清理原始 OSS 文件失败:', e.message); }
            // 标记任务为已取消，跳过 DB 写入
            updates.status = 'cancelled';
            updates.error = '用户已离开，任务已取消';
            await db.transcodeTasks.update(taskId, updates);
            task = await db.transcodeTasks.get(taskId);
            res.json({
              success: false,
              status: 'cancelled',
              message: '用户已离开，任务已取消',
              outputUrl: null,
              url: null,
              error: '用户已离开，任务已取消'
            });
            return;
          }

          try {
            // 更新前先查出 oldUrl 对应的 videos 行 id，用于删除时排除自身（避免 coverUrl 误判阻止删除）
            const videoRows = await db.storyboardAsync.all(
              'SELECT id FROM videos WHERE url = ?', [task.videoUrl]
            );
            await db.items.updateMediaUrlAndSize(task.videoUrl, updates.outputUrl, compressedSize);
            console.log(`[MPS] 已更新媒体记录: ${task.videoUrl} → ${updates.outputUrl}, size=${compressedSize}`);

            // 删除原始 OSS 源文件：排除刚更新的 videos 行，避免 coverUrl 字段误判
            let sourceDeleted = false;
            if (videoRows.length > 0) {
              for (const row of videoRows) {
                const stillRef = await isUrlReferenced(task.videoUrl, { excludeVideoId: row.id });
                if (!stillRef) {
                  await deleteOssFile(task.videoUrl);
                  console.log(`[MPS] 已删除原始 OSS 文件: ${task.videoUrl}`);
                  sourceDeleted = true;
                  break;
                }
              }
            } else {
              await deleteOssFileIfNotReferenced(task.videoUrl);
              sourceDeleted = true;
            }
            if (!sourceDeleted) {
              console.log(`[MPS] 原始 OSS 文件仍被引用，跳过删除: ${task.videoUrl}`);
            }

            // 清理 MPS 输出文件（已下载并重新上传到项目 OSS，MPS 输出文件不再需要）
            if (mpsOutputUrl && mpsOutputUrl !== task.videoUrl && mpsOutputUrl !== updates.outputUrl) {
              try {
                await deleteOssFile(mpsOutputUrl);
                console.log(`[MPS] 已清理 MPS 输出文件: ${mpsOutputUrl}`);
              } catch (e) {
                console.warn('[MPS] 清理 MPS 输出文件失败:', e.message);
              }
            }

            // 转码成功后尝试设置项目封面（如果之前因等待转码而跳过了设置）
            const taskProjectId = task.options && task.options.projectId;
            const taskUsage = task.options && task.options.usage;
            const taskReference = taskUsage === 'project-reference' ? 1 : 0;
            if (taskProjectId && !taskReference && taskUsage !== 'project-cover') {
              trySetProjectCoverIfDefault(
                parseInt(taskProjectId),
                updates.outputUrl,
                'video'
              ).catch(() => {});
            }
          } catch (e) {
            console.error('[MPS] 更新媒体记录或删除原文件失败:', e.message);
            // DB 更新失败：清理新上传到项目 OSS 的转码文件，避免残留
            // DB 仍指向旧 URL（task.videoUrl），旧文件保留；新文件（updates.outputUrl）无 DB 引用，需清理
            if (isOurOssOutput && updates.outputUrl) {
              try {
                await deleteStandaloneOssFile(updates.outputUrl);
                console.log('[MPS] DB 更新失败，已清理新转码 OSS 文件:', updates.outputUrl);
              } catch (cleanupErr) {
                console.error('[MPS] 清理新转码 OSS 文件失败:', cleanupErr.message);
              }
            }
            // DB 更新失败时也尝试清理 MPS 输出文件
            if (mpsOutputUrl && mpsOutputUrl !== task.videoUrl && mpsOutputUrl !== updates.outputUrl) {
              try {
                await deleteOssFile(mpsOutputUrl);
                console.log('[MPS] DB 更新失败，已清理 MPS 输出文件:', mpsOutputUrl);
              } catch (e2) {
                console.warn('[MPS] 清理 MPS 输出文件失败:', e2.message);
              }
            }
          }
        }

        await db.transcodeTasks.update(taskId, updates);
        task = await db.transcodeTasks.get(taskId);
      } catch (queryError) {
        console.warn('[MPS] 查询转码状态失败:', queryError.message);
        // 查询失败不影响返回当前状态
      }
    }

    res.json({
      success: true,
      status: task.status,
      progress: task.progress,
      outputUrl: task.outputUrl,
      // P2-4：同时返回 url 字段，前端轮询逻辑读取 status.url
      url: task.outputUrl,
      error: task.error
    });
  } catch (error) {
    console.error('[MPS] 查询转码任务失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const { projectId, sceneId } = req.query;
    const filter = { reference: 0 };
    if (projectId !== undefined) {
      filter.projectId = parseInt(projectId);
    }
    if (sceneId !== undefined) {
      filter.sceneId = sceneId === 'null' ? null : parseInt(sceneId);
    }
    const stats = await db.items.getStats(filter);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[app] 获取统计失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/scene-stats', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success: false, message: '缺少 projectId' });
    const stats = await db.items.getSceneStats(parseInt(projectId));
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[app] 获取场次统计失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== 项目备份/恢复端点 ==========

app.get('/api/projects/:id/backup', async (req, res) => {
  try {
    const { id } = req.params;
    const projectId = parseInt(id);

    const data = await db.items.exportProject(projectId);
    if (!data) {
      return res.status(404).json({ success: false, message: '项目不存在' });
    }

    const fileName = `${data.project.name || 'project'}_backup_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.json(data);
  } catch (err) {
    console.error('[backup] 导出备份失败:', err);
    res.status(500).json({ success: false, message: '导出备份失败', error: err.message });
  }
});

app.post('/api/projects/import', async (req, res) => {
  try {
    const { projectData, targetProjectId, mode = 'new' } = req.body;

    if (!projectData) {
      return res.status(400).json({ success: false, message: '缺少项目数据' });
    }

    let parsedData = projectData;
    if (typeof projectData === 'string') {
      parsedData = JSON.parse(projectData);
    }

    if (!parsedData.project || !parsedData.shots) {
      return res.status(400).json({ success: false, message: '备份文件格式不正确' });
    }

    const targetId = mode === 'merge' && targetProjectId ? parseInt(targetProjectId) : null;
    const result = await db.items.importProject(parsedData, targetId, mode);

    res.json({
      success: true,
      projectId: result.projectId,
      sceneCount: Object.keys(result.sceneIdMap).length,
      shotCount: Object.keys(result.shotIdMap).length
    });
  } catch (err) {
    console.error('[import] 导入备份失败:', err);
    res.status(500).json({ success: false, message: '导入备份失败', error: err.message });
  }
});

// ========== 数据导出端点 ==========

app.get('/api/projects/:id/export', async (req, res) => {
  try {
    const { id } = req.params;
    const { format = 'docx', includeImages = 'true' } = req.query;
    
    const project = await db.projects.getById(parseInt(id));
    if (!project) {
      return res.status(404).json({ success: false, message: '项目不存在' });
    }
    
    // 获取项目下的所有分镜
    const shots = await db.items.getByFilter({
      projectId: parseInt(id),
      deleted: 0,
      reference: 0
    });
    
    // 获取项目下的所有场次（用于名称映射）
    const scenes = await db.scenes.getByProjectId(parseInt(id));
    const sceneNameMap = {};
    scenes.forEach(scene => {
      sceneNameMap[scene.id] = scene.name;
    });
    
    // 为每个分镜关联 media
    const shotsWithMedia = await Promise.all(shots.map(async (shot) => {
      const media = await db.shotMedia.getByShotId(shot.id);
      return { ...shot, media };
    }));
    
    // 按场次分组
    const shotsByScene = {};
    shotsWithMedia.forEach(shot => {
      const sceneKey = shot.sceneId || 'default';
      if (!shotsByScene[sceneKey]) shotsByScene[sceneKey] = [];
      shotsByScene[sceneKey].push(shot);
    });
    
    const sceneIds = Object.keys(shotsByScene).sort((a, b) => a === 'default' ? -1 : (parseInt(a) - parseInt(b)));

    const fmt = String(format).toLowerCase();

    if (fmt === 'xlsx' || fmt === 'excel') {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      workbook.creator = '柒子文化AI拍摄辅助系统';
      workbook.created = new Date();

      const worksheet = workbook.addWorksheet('分镜脚本');
      worksheet.columns = [
        { header: '场次', key: 'scene', width: 15 },
        { header: '序号', key: 'index', width: 8 },
        { header: '镜头编号', key: 'shotNo', width: 12 },
        { header: '画面内容', key: 'sceneContent', width: 40 },
        { header: '景别', key: 'shotType', width: 12 },
        { header: '角度', key: 'shotAngle', width: 12 },
        { header: '镜头运动', key: 'cameraMovement', width: 15 },
        { header: '演员', key: 'actors', width: 20 },
        { header: '道具', key: 'props', width: 20 },
        { header: '地点', key: 'location', width: 20 },
        { header: '灯光', key: 'lighting', width: 15 },
        { header: '旁白/台词', key: 'narration', width: 30 },
        { header: '预估时长', key: 'estimatedDuration', width: 10 },
        { header: '备注', key: 'notes', width: 30 }
      ];

      worksheet.getRow(1).font = { bold: true, size: 12 };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF8B5CF6' }
      };
      worksheet.getRow(1).font.color = { argb: 'FFFFFFFF' };

      for (const sceneKey of sceneIds) {
        const sceneShots = shotsByScene[sceneKey];
        const sceneName = sceneKey === 'default' ? '未分类' : (sceneNameMap[sceneKey] || `第 ${sceneKey} 场`);
        
        for (let i = 0; i < sceneShots.length; i++) {
          const shot = sceneShots[i];
          worksheet.addRow({
            scene: i === 0 ? sceneName : '',
            index: i + 1,
            shotNo: shot.shotNo || '',
            sceneContent: shot.sceneContent || shot.title || '',
            shotType: shot.shotType || '',
            shotAngle: shot.shotAngle || '',
            cameraMovement: shot.cameraMovement || '',
            actors: shot.actors || '',
            props: shot.props || '',
            location: shot.location || '',
            lighting: shot.lighting || '',
            narration: shot.narration || '',
            estimatedDuration: shot.estimatedDuration || '',
            notes: shot.notes || ''
          });
        }
      }

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.alignment = { vertical: 'top', wrapText: true };
        if (rowNumber > 1) {
          row.border = {
            bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } }
          };
        }
      });

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(project.name)}_分镜脚本.xlsx"`);
      res.send(Buffer.from(buffer));
      console.log(`[app] 导出 Excel 成功，共 ${shots.length} 个分镜`);
      return;
    }

    if (fmt === 'pdf') {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(project.name)}_分镜脚本.pdf"`);
        res.send(buffer);
      });

      doc.fontSize(20).text(project.name, { align: 'center' });
      doc.moveDown();
      doc.fontSize(10).fillColor('#666').text(`导出日期：${new Date().toLocaleDateString('zh-CN')}`, { align: 'center' });
      doc.text(`共 ${shots.length} 个分镜`, { align: 'center' });
      doc.moveDown(2);

      for (const sceneKey of sceneIds) {
        const sceneShots = shotsByScene[sceneKey];
        const sceneName = sceneKey === 'default' ? '未分类' : (sceneNameMap[sceneKey] || `第 ${sceneKey} 场`);
        
        if (sceneKey !== 'default') {
          doc.fontSize(16).fillColor('#8B5CF6').text(sceneName);
          doc.moveDown(0.5);
          doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#E5E7EB');
          doc.moveDown();
        }

        for (let i = 0; i < sceneShots.length; i++) {
          const shot = sceneShots[i];
          doc.fontSize(13).fillColor('#111').text(`分镜 #${i + 1} ${shot.sceneContent || shot.title || ''}`);
          doc.moveDown(0.3);

          const details = [
            { label: '镜头编号', value: shot.shotNo || '' },
            { label: '画面内容', value: shot.sceneContent || '' },
            { label: '景别', value: shot.shotType || '' },
            { label: '角度', value: shot.shotAngle || '' },
            { label: '镜头运动', value: shot.cameraMovement || '' },
            { label: '演员', value: shot.actors || '' },
            { label: '道具', value: shot.props || '' },
            { label: '地点', value: shot.location || '' },
            { label: '灯光', value: shot.lighting || '' },
            { label: '旁白/台词', value: shot.narration || '' },
            { label: '预估时长', value: shot.estimatedDuration ? `${shot.estimatedDuration}秒` : '' },
            { label: '备注', value: shot.notes || '' }
          ];

          doc.fontSize(10).fillColor('#333');
          for (const detail of details) {
            if (detail.value) {
              doc.font('Helvetica-Bold').text(`${detail.label}：`, { continued: true });
              doc.font('Helvetica').text(detail.value);
            }
          }

          if (shot.media && shot.media.length > 0 && includeImages === 'true') {
            doc.moveDown(0.3);
            doc.fillColor('#666').text(`参考画面：${shot.media.length}张`);
          }

          doc.moveDown();
          doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#E5E7EB');
          doc.moveDown();
        }

        doc.addPage();
      }

      doc.end();
      console.log(`[app] 导出 PDF 成功，共 ${shots.length} 个分镜`);
      return;
    }

    // 生成 Word 文档（默认）
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, AlignmentType, WidthType } = require('docx');
    
    const children = [];
    
    // 标题
    children.push(new Paragraph({
      text: project.name,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    }));
    
    children.push(new Paragraph({
      text: `导出日期：${new Date().toLocaleDateString('zh-CN')}`,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    }));
    
    children.push(new Paragraph({
      text: `共 ${shots.length} 个分镜`,
      alignment: AlignmentType.CENTER,
      spacing: { after: 800 }
    }));
    
    // 遍历每个场次
    for (const sceneKey of sceneIds) {
      const sceneShots = shotsByScene[sceneKey];
      
      // 场次标题
      if (sceneKey !== 'default') {
        const sceneName = sceneNameMap[sceneKey] || `第 ${sceneKey} 场`;
        children.push(new Paragraph({
          text: sceneName,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 }
        }));
      }
      
      // 分镜表格
      for (let i = 0; i < sceneShots.length; i++) {
        const shot = sceneShots[i];
        children.push(new Paragraph({
          text: `分镜 #${i + 1} ${shot.sceneContent || shot.title || ''}`,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 100 }
        }));
        
        // 分镜详情
        const details = [
          { label: '镜头编号', value: shot.shotNo || '' },
          { label: '画面内容', value: shot.sceneContent || '' },
          { label: '景别', value: shot.shotType || '' },
          { label: '角度', value: shot.shotAngle || '' },
          { label: '焦段', value: shot.focalLength || '' },
          { label: '镜头运动', value: shot.cameraMovement || '' },
          { label: '演员', value: shot.actors || '' },
          { label: '道具', value: shot.props || '' },
          { label: '地点', value: shot.location || '' },
          { label: '灯光', value: shot.lighting || '' },
          { label: '旁白/台词', value: shot.narration || '' },
          { label: '预估时长', value: shot.estimatedDuration ? `${shot.estimatedDuration}秒` : '' },
          { label: '备注', value: shot.notes || '' }
        ];
        
        for (const detail of details) {
          if (detail.value) {
            children.push(new Paragraph({
              children: [
                new TextRun({ text: `${detail.label}：`, bold: true }),
                new TextRun({ text: detail.value })
              ],
              spacing: { after: 50 }
            }));
          }
        }
        
        // 参考画面
        if (shot.media && shot.media.length > 0 && includeImages === 'true') {
          children.push(new Paragraph({
            text: `参考画面：${shot.media.length}张`,
            spacing: { after: 100 }
          }));
          
          const mediaUrls = shot.media.map(m => m.url).filter(url => url).join('\n');
          if (mediaUrls) {
            children.push(new Paragraph({
              text: `[图片链接] ${shot.media[0].url}`,
              style: 'IntenseQuote',
              spacing: { after: 100 }
            }));
          }
        }
        
        children.push(new Paragraph({
          text: '─'.repeat(40),
          spacing: { before: 100, after: 300 }
        }));
      }
    }
    
    const doc = new Document({
      sections: [{
        children
      }]
    });
    
    const buffer = await Packer.toBuffer(doc);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(project.name)}_分镜脚本.docx"`);
    res.send(buffer);
    
    console.log(`[app] 导出项目 ${id} 成功，共 ${shots.length} 个分镜`);
  } catch (error) {
    console.error('[app] 导出失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

async function updateShotStatus(req, res) {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (status !== 'pending' && status !== 'done') {
      return res.status(400).json({ success: false, message: 'status 只能是 pending 或 done' });
    }
    const ok = await db.items.updateStatus(id, status);
    if (!ok) return res.status(404).json({ success: false, message: '分镜不存在' });
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 更新状态失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.put('/api/shots/:id/status', updateShotStatus);

async function softDeleteShot(req, res) {
  try {
    const id = parseInt(req.params.id);
    const ok = await db.items.softDelete(id);
    if (!ok) return res.status(404).json({ success: false, message: '分镜不存在' });
    console.log(`[app] 分镜 ID ${id} 已移入垃圾桶`);
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 软删除失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.delete('/api/shots/:id', softDeleteShot);

async function hardDeleteShot(req, res) {
  try {
    const id = parseInt(req.params.id);
    const item = await db.items.getById(id);
    if (!item) return res.status(404).json({ success: false, message: '分镜不存在' });
    // 先收集所有要清理的 OSS URL：videos.url + 该分镜所有 shot_media.url
    const mediaList = await db.shotMedia.getByShotId(id);
    const mediaUrls = (mediaList || []).map(m => m.url).filter(Boolean);
    const urlsToClean = [item.url, ...mediaUrls].filter(Boolean);

    // 检查项目封面是否来源于该分镜的媒体，如果是则清除封面
    try {
      const project = await db.projects.getById(item.projectId);
      if (project && project.coverUrl && !project.coverUrl.startsWith(DEFAULT_PROJECT_COVER_PREFIX)) {
        const coverBaseUrl = project.coverUrl.split('?')[0];
        const isCoverFromShot = urlsToClean.some(url => url.split('?')[0] === coverBaseUrl);
        if (isCoverFromShot) {
          await db.projects.update(item.projectId, { coverUrl: '' });
          console.log(`[app] 删除分镜 ${id}，清除项目 ${item.projectId} 封面（来源被删除）`);
        }
      }
    } catch (coverErr) {
      console.warn('[app] 检查/清除项目封面失败:', coverErr.message);
    }

    // 执行硬删：删分镜自身 videos(reference=0)
    await db.items.hardDelete(id);
    // 手动删 shot_media 记录（SQLite 外键 CASCADE 未启用）
    try {
      await db.storyboardAsync.run('DELETE FROM shot_media WHERE shotId = ?', [id]);
    } catch (e) {
      console.warn('[app] hardDeleteShot 删除 shot_media 失败:', e.message);
    }
    // 删 videos(reference=1) 记录（统计占用空间由此而来）
    // 必须在 deleteOssFileIfNotReferenced 之前删除，否则 isUrlReferenced 会因
    // videos(reference=1) 记录仍存在而返回 true，阻止 OSS 删除
    for (const mediaUrl of mediaUrls) {
      try {
        const otherMediaRows = await db.storyboardAsync.all(
          'SELECT COUNT(*) as cnt FROM shot_media WHERE url = ?',
          [mediaUrl]
        );
        if ((otherMediaRows[0]?.cnt || 0) === 0) {
          await db.storyboardAsync.run(
            'DELETE FROM videos WHERE url = ? AND reference = 1',
            [mediaUrl]
          );
        }
      } catch (e) {
        console.warn('[app] hardDeleteShot 删除 videos(reference=1) 失败:', mediaUrl, e.message);
      }
    }
    // 删 OSS 文件前检查引用计数（P2-12：保护被其他分镜/资产共享的 URL）
    for (const url of urlsToClean) {
      try {
        await deleteOssFileIfNotReferenced(url);
      } catch (e) {
        console.error('[app] hardDeleteShot OSS 清理失败:', url, e.message);
      }
    }
    // P3-22：联动清理该分镜的 ai_generated_images 历史记录
    try {
      await deleteAiGeneratedByOwner('shot', id);
    } catch (e) {
      console.error('[app] hardDeleteShot AI 历史清理失败:', e.message);
    }
    console.log(`[app] 分镜 ID ${id} 已彻底删除`);
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 彻底删除失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.delete('/api/shots/:id/hard', hardDeleteShot);

async function restoreShot(req, res) {
  try {
    const id = parseInt(req.params.id);
    const ok = await db.items.restore(id);
    if (!ok) return res.status(404).json({ success: false, message: '分镜不存在' });
    console.log(`[app] 分镜 ID ${id} 已从垃圾桶恢复`);
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 恢复失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.post('/api/shots/:id/restore', restoreShot);

async function batchUpdateShots(req, res) {
  try {
    const { videoIds, operation, sceneId, action, ids, orders } = req.body;
    const finalAction = action || operation;
    const finalIds = ids && Array.isArray(ids) ? ids : (videoIds && Array.isArray(videoIds) ? videoIds : null);
    let changes = 0;
    if (finalAction === 'reorder') {
      const normalized = (orders || [])
        .filter(function(item) { return item && typeof item.id === 'number' && typeof item.sortOrder === 'number'; })
        .map(function(item) { return { id: item.id, sortOrder: item.sortOrder }; });
      if (normalized.length === 0) {
        return res.status(400).json({ success: false, message: '参数 orders 无效' });
      }
      await db.items.updateSort(normalized);
      return res.json({ success: true, changes: normalized.length });
    }
    if (!finalIds || finalIds.length === 0) {
      return res.status(400).json({ success: false, message: 'ids 应为非空数组' });
    }
    const numIds = finalIds.map(Number);
    if (finalAction === 'softDelete') {
      changes = await db.items.batchSoftDelete(numIds);
    } else if (finalAction === 'restore') {
      changes = await db.items.batchRestore(numIds);
    } else if (finalAction === 'hardDelete') {
      // 先收集每个分镜的 shot_media url（数据库删除后查不到）
      const allUrls = [];
      const shotMediaUrls = [];
      for (const sid of numIds) {
        try {
          const ml = await db.shotMedia.getByShotId(sid);
          const urls = (ml || []).map(m => m.url).filter(Boolean);
          if (urls.length > 0) {
            shotMediaUrls.push(...urls);
            allUrls.push(...urls);
          }
        } catch (e) {
          console.warn('[app] batchHardDelete 收集 shot_media 失败:', sid, e.message);
        }
      }
      // batchHardDelete 返回 videos.url 列表
      const urls = await db.items.batchHardDelete(numIds);
      allUrls.push(...(urls || []).filter(Boolean));

      // 检查并清除项目封面（如果封面来源于被删除的分镜）
      try {
        if (numIds.length > 0) {
          const firstShot = await db.items.getById(numIds[0]);
          const projectId = firstShot ? firstShot.projectId : null;
          if (projectId) {
            const project = await db.projects.getById(projectId);
            if (project && project.coverUrl && !project.coverUrl.startsWith(DEFAULT_PROJECT_COVER_PREFIX)) {
              const coverBaseUrl = project.coverUrl.split('?')[0];
              const isCoverFromShots = allUrls.some(u => u.split('?')[0] === coverBaseUrl);
              if (isCoverFromShots) {
                await db.projects.update(projectId, { coverUrl: '' });
                console.log(`[app] 批量硬删除分镜，清除项目 ${projectId} 封面`);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[app] batchHardDelete 检查/清除封面失败:', e.message);
      }

      // 手动删 shot_media 记录（SQLite 外键 CASCADE 未启用）
      try {
        const placeholders = numIds.map(() => '?').join(',');
        await db.storyboardAsync.run(
          `DELETE FROM shot_media WHERE shotId IN (${placeholders})`,
          numIds
        );
      } catch (e) {
        console.warn('[app] batchHardDelete 删除 shot_media 失败:', e.message);
      }
      // 删 videos(reference=1) 记录（统计占用空间由此而来）
      // 必须在 deleteOssFileIfNotReferenced 之前删除，否则 isUrlReferenced 会因
      // videos(reference=1) 记录仍存在而返回 true，阻止 OSS 删除
      const uniqueShotMediaUrls = [...new Set(shotMediaUrls)];
      for (const mediaUrl of uniqueShotMediaUrls) {
        try {
          const otherMediaRows = await db.storyboardAsync.all(
            'SELECT COUNT(*) as cnt FROM shot_media WHERE url = ?',
            [mediaUrl]
          );
          if ((otherMediaRows[0]?.cnt || 0) === 0) {
            await db.storyboardAsync.run(
              'DELETE FROM videos WHERE url = ? AND reference = 1',
              [mediaUrl]
            );
          }
        } catch (e) {
          console.warn('[app] batchHardDelete 删除 videos(reference=1) 失败:', mediaUrl, e.message);
        }
      }
      // 删 OSS 前检查引用计数（P2-12：保护共享 URL）
      for (const u of allUrls) {
        try { await deleteOssFileIfNotReferenced(u); } catch (e) {
          console.error('[app] batchHardDelete OSS 清理失败:', u, e.message);
        }
      }
      // P3-22：联动清理每个分镜的 ai_generated_images 历史记录
      for (const sid of numIds) {
        try { await deleteAiGeneratedByOwner('shot', sid); }
        catch (e) { console.error('[app] batchHardDelete AI 历史清理失败:', sid, e.message); }
      }
      changes = numIds.length;
    } else if (finalAction === 'changeScene') {
      changes = await db.items.batchChangeScene(numIds, sceneId !== undefined && sceneId !== null ? parseInt(sceneId) : null);
    } else if (finalAction === 'updateStatus') {
      const { status } = req.body;
      if (status !== 'pending' && status !== 'done') {
        return res.status(400).json({ success: false, message: 'status 应为 pending 或 done' });
      }
      changes = await db.items.batchUpdateStatus(numIds, status);
    } else {
      return res.status(400).json({ success: false, message: '不支持的操作: ' + finalAction });
    }
    res.json({ success: true, changes });
  } catch (error) {
    console.error('[app] 批量操作失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}

// ==================== Projects API ====================

app.get('/api/projects', async (req, res) => {
  try {
    const projects = await db.projects.getAll();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, data: projects.map(p => ({
      ...p,
      shareUrl: `${origin}/share/project/${p.id}`
    })) });
  } catch (error) {
    console.error('[app] 获取项目列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, description, coverUrl } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '项目名称不能为空' });
    }
    const project = await db.projects.create({ name: name.trim(), description: description || '', coverUrl });
    console.log(`[app] 新建项目: ${name}`);
    res.json({ success: true, data: project });
  } catch (error) {
    console.error('[app] 新建项目失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const project = await db.projects.getById(id);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const origin = `${req.protocol}://${req.get('host')}`;
    const safeName = project.name || project.title || '未命名项目';
    res.json({
      success: true,
      data: {
        ...project,
        name: safeName,
        title: safeName,
        shareUrl: `${origin}/share/project/${project.id}`
      }
    });
  } catch (error) {
    console.error('[app] 获取项目详情失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/projects/sort', async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders)) return res.status(400).json({ success: false, message: 'orders 应为数组' });
    await db.projects.updateSort(orders.filter(o => o && typeof o.id === 'number' && typeof o.sortOrder === 'number'));
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 更新项目排序失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, coverUrl } = req.body;
    const existing = await db.projects.getById(id);
    if (!existing) return res.status(404).json({ success: false, message: '项目不存在' });
    await db.projects.update(id, {
      name: name !== undefined ? name.trim() : undefined,
      description: description !== undefined ? description : undefined,
      coverUrl: coverUrl !== undefined ? coverUrl : undefined
    });
    if (coverUrl !== undefined) {
      const oldCoverUrl = existing.coverUrl || '';
      if (oldCoverUrl && oldCoverUrl !== coverUrl) {
        try { await deleteStandaloneOssFile(oldCoverUrl); }
        catch (e) { console.error('[app] 清理旧封面 OSS 失败:', e.message); }
      }
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 更新项目失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await db.projects.getById(id);
    if (!existing) return res.status(404).json({ success: false, message: '项目不存在' });

    const taskId = 'del-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);
    const task = {
      status: 'processing',
      progress: 0,
      totalShots: 0,
      deletedShots: 0,
      message: '准备删除...',
      error: null,
      // P4-3：记录子任务失败信息，前端据此提示"删除完成但 N 项清理失败"
      warnings: [],
      projectId: id,
      createdAt: new Date().toISOString()
    };
    deleteProjectTasks.set(taskId, task);

    res.json({ success: true, taskId });

    (async () => {
      try {
        const task = deleteProjectTasks.get(taskId);
        if (!task) return;

        const videos = await db.items.getByFilter({ projectId: id });
        task.totalShots = videos.length;
        task.message = '正在删除分镜...';
        deleteProjectTasks.set(taskId, task);

        const allUrls = [];
        for (let i = 0; i < videos.length; i++) {
          const shot = videos[i];
          try {
            const mediaList = await db.storyboardAsync.all(
              'SELECT url FROM shot_media WHERE shotId = ?',
              [shot.id]
            );
            mediaList.forEach(m => { if (m.url) allUrls.push(m.url); });
            if (shot.url) allUrls.push(shot.url);
            if (shot.coverUrl) allUrls.push(shot.coverUrl);

            await db.storyboardAsync.run('DELETE FROM shot_media WHERE shotId = ?', [shot.id]);
            await db.storyboardAsync.run('DELETE FROM videos WHERE id = ?', [shot.id]);

            task.deletedShots = i + 1;
            task.progress = Math.round((i + 1) / videos.length * 80);
            deleteProjectTasks.set(taskId, task);
          } catch (err) {
            console.error(`[app] 删除分镜 ${shot.id} 失败:`, err.message);
          }
        }

        task.message = '正在删除项目参考素材...';
        task.progress = 85;
        deleteProjectTasks.set(taskId, task);

        const references = await db.items.getByFilter({ projectId: id, reference: 1 });
        for (const ref of references) {
          if (ref.url) allUrls.push(ref.url);
          if (ref.coverUrl) allUrls.push(ref.coverUrl);
        }
        await db.storyboardAsync.run('DELETE FROM videos WHERE projectId = ? AND reference = 1', [id]);

        // P2-13：收集数字资产（演员/道具/场景）的所有图片 URL，并删除资产记录
        try {
          const assets = await db.digitalAssets.getByProjectId(id);
          for (const asset of assets) {
            if (asset.imageUrl) allUrls.push(asset.imageUrl);
            for (const img of (asset.images || [])) {
              if (img.imageUrl) allUrls.push(img.imageUrl);
            }
          }
          await db.storyboardAsync.run('DELETE FROM digital_asset_images WHERE assetId IN (SELECT id FROM digital_assets WHERE projectId = ?)', [id]);
          await db.storyboardAsync.run('DELETE FROM digital_assets WHERE projectId = ?', [id]);
        } catch (e) {
          console.error('[app] 清理数字资产失败:', e.message);
          // P4-3：记录警告，前端据此提示
          task.warnings.push({ stage: 'digital_assets', message: e.message });
        }

        // P2-13：收集 ai_tasks 的输出 URL（MPS 转码视频、AI 生图等），并删除任务记录
        try {
          const aiTaskRows = await db.storyboardAsync.all(
            'SELECT output FROM ai_tasks WHERE projectId = ?',
            [id]
          );
          for (const row of aiTaskRows) {
            if (row.output) {
              try {
                const out = JSON.parse(row.output);
                if (out.outputUrl) allUrls.push(out.outputUrl);
                if (out.imageUrl) allUrls.push(out.imageUrl);
                if (out.media?.url) allUrls.push(out.media.url);
                if (out.videoUrl) allUrls.push(out.videoUrl);
                if (out.url) allUrls.push(out.url);
              } catch (e) {}
            }
          }
          await db.storyboardAsync.run('DELETE FROM ai_tasks WHERE projectId = ?', [id]);
        } catch (e) {
          console.error('[app] 清理 AI 任务记录失败:', e.message);
          // P4-3：记录警告
          task.warnings.push({ stage: 'ai_tasks', message: e.message });
        }

        // P3-22：收集并清理 ai_generated_images 历史记录（按项目和资产维度）
        try {
          // 项目下所有分镜的 AI 生图历史
          const shotHistRows = await db.storyboardAsync.all(
            `SELECT url FROM ai_generated_images WHERE ownerType='shot' AND ownerId IN
             (SELECT id FROM videos WHERE projectId = ?)`,
            [id]
          );
          shotHistRows.forEach(r => { if (r.url) allUrls.push(r.url); });
          // 项目下所有资产的 AI 生图历史
          const assetHistRows = await db.storyboardAsync.all(
            `SELECT url FROM ai_generated_images WHERE ownerType='asset' AND ownerId IN
             (SELECT id FROM digital_assets WHERE projectId = ?)`,
            [id]
          );
          assetHistRows.forEach(r => { if (r.url) allUrls.push(r.url); });
          await db.storyboardAsync.run(
            `DELETE FROM ai_generated_images WHERE ownerType='shot' AND ownerId IN
             (SELECT id FROM videos WHERE projectId = ?)`,
            [id]
          );
          await db.storyboardAsync.run(
            `DELETE FROM ai_generated_images WHERE ownerType='asset' AND ownerId IN
             (SELECT id FROM digital_assets WHERE projectId = ?)`,
            [id]
          );
        } catch (e) {
          console.error('[app] 清理 AI 生图历史失败:', e.message);
          // P4-3：记录警告
          task.warnings.push({ stage: 'ai_generated_images', message: e.message });
        }

        const project = await db.projects.getById(id);
        if (project && project.coverUrl && !project.coverUrl.startsWith('data:')) {
          allUrls.push(project.coverUrl);
        }

        // 收集转码任务中的 videoUrl 和 outputUrl（含 MPS 输出文件，避免孤立残留）
        try {
          const transcodeRows = await db.storyboardAsync.all(
            'SELECT videoUrl, outputUrl FROM transcode_tasks WHERE projectId = ? OR options LIKE ?',
            [id, `%"projectId":${id}%`]
          );
          for (const row of transcodeRows) {
            if (row.videoUrl) allUrls.push(row.videoUrl);
            if (row.outputUrl) allUrls.push(row.outputUrl);
          }
        } catch (e) {
          console.error('[app] 收集转码任务 URL 失败:', e.message);
        }

        task.message = '正在删除场景和项目...';
        task.progress = 92;
        deleteProjectTasks.set(taskId, task);

        await db.storyboardAsync.run('DELETE FROM scenes WHERE projectId = ?', [id]);
        await db.storyboardAsync.run('DELETE FROM transcode_tasks WHERE projectId = ? OR options LIKE ?', [id, `%"projectId":${id}%`]);
        await db.storyboardAsync.run('DELETE FROM projects WHERE id = ?', [id]);

        task.message = '正在清理云端文件...';
        task.progress = 95;
        deleteProjectTasks.set(taskId, task);

        try {
          await deleteOssFiles(allUrls);
        } catch (ossErr) {
          console.error('[app] OSS 文件清理失败:', ossErr.message);
          // P4-3：记录警告，附上失败 URL 列表便于排查
          task.warnings.push({ stage: 'oss_cleanup', message: ossErr.message, urls: allUrls });
        }

        task.status = 'done';
        task.progress = 100;
        // P4-3：有警告时改写 message，前端据此展示"部分清理失败"
        task.message = task.warnings.length > 0
          ? `删除完成（${task.warnings.length} 项清理失败）`
          : '删除完成';
        deleteProjectTasks.set(taskId, task);
        // P4-7：任务终态后延迟 10 分钟清理 Map 条目
        scheduleTaskCleanup(deleteProjectTasks, taskId);

        console.log(`[app] 项目 ID ${id} 已删除，含 ${videos.length} 个分镜，${references.length} 个参考素材`);
      } catch (err) {
        const task = deleteProjectTasks.get(taskId);
        if (task) {
          task.status = 'error';
          task.error = err.message;
          task.message = '删除失败';
          deleteProjectTasks.set(taskId, task);
          // P4-7：任务终态后延迟 10 分钟清理 Map 条目
          scheduleTaskCleanup(deleteProjectTasks, taskId);
        }
        console.error('[app] 删除项目失败:', err.message);
      }
    })();
  } catch (error) {
    console.error('[app] 删除项目失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/projects/delete/:taskId', async (req, res) => {
  const task = deleteProjectTasks.get(req.params.taskId);
  // P4-4：任务不存在（服务端重启）时返回明确状态，前端据此清理 localStorage
  if (!task) return res.status(404).json({ status: 'not_found', message: '任务不存在（服务端可能已重启）' });
  res.json({
    status: task.status,
    progress: task.progress,
    totalShots: task.totalShots,
    deletedShots: task.deletedShots,
    message: task.message,
    error: task.error,
    // P4-3：返回 warnings 数组，前端展示"部分清理失败"
    warnings: task.warnings || []
  });
});

// ==================== Digital Assets API ====================

// GET 获取项目的数字资产列表（支持按 type 过滤）
app.get('/api/projects/:projectId/assets', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const { type } = req.query;
    const project = await db.projects.getById(projectId);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const assets = await db.digitalAssets.getByProjectId(projectId, type || null);
    res.json({ success: true, data: assets });
  } catch (error) {
    console.error('[app] 获取数字资产列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST 新增数字资产
app.post('/api/projects/:projectId/assets', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const { type, name, imagePrompt, imageUrl } = req.body;
    if (!type || !['actor', 'prop', 'scene'].includes(type)) {
      return res.status(400).json({ success: false, message: '类型必须为 actor、prop 或 scene' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '名称不能为空' });
    }
    const project = await db.projects.getById(projectId);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const asset = await db.digitalAssets.create({
      projectId,
      type,
      name: name.trim(),
      imagePrompt: imagePrompt || '',
      imageUrl: imageUrl || ''
    });
    console.log(`[app] 新建数字资产: ${name} (${type})`);
    res.json({ success: true, data: asset });
  } catch (error) {
    console.error('[app] 新建数字资产失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT 更新数字资产
app.put('/api/projects/:projectId/assets/:id', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const id = parseInt(req.params.id);
    const { name, imagePrompt, imageUrl } = req.body;
    const asset = await db.digitalAssets.getById(id);
    if (!asset) return res.status(404).json({ success: false, message: '数字资产不存在' });
    if (asset.projectId !== projectId) {
      return res.status(400).json({ success: false, message: '数字资产不属于该项目' });
    }
    const oldImageUrl = asset.imageUrl || '';
    await db.digitalAssets.update(id, {
      name: name !== undefined ? name.trim() : undefined,
      imagePrompt: imagePrompt !== undefined ? imagePrompt : undefined,
      imageUrl: imageUrl !== undefined ? imageUrl : undefined
    });
    if (imageUrl !== undefined && oldImageUrl && oldImageUrl !== imageUrl) {
      try { await deleteStandaloneOssFile(oldImageUrl); }
      catch (e) { console.error('[app] 清理旧资产主图 OSS 失败:', e.message); }
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 更新数字资产失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE 删除数字资产
app.delete('/api/projects/:projectId/assets/:id', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const id = parseInt(req.params.id);
    const asset = await db.digitalAssets.getById(id);
    if (!asset) return res.status(404).json({ success: false, message: '数字资产不存在' });
    if (asset.projectId !== projectId) {
      return res.status(400).json({ success: false, message: '数字资产不属于该项目' });
    }
    // 收集所有 OSS URL：主图 + 关联图片
    const urlsToClean = new Set();
    if (asset.imageUrl) urlsToClean.add(asset.imageUrl);
    for (const img of (asset.images || [])) {
      if (img.imageUrl) urlsToClean.add(img.imageUrl);
    }
    // 先删 digital_asset_images 子表（delete 不会级联）
    await db.storyboardAsync.run('DELETE FROM digital_asset_images WHERE assetId = ?', [id]);
    // 再删 digital_assets 主表
    await db.digitalAssets.delete(id);
    // 删 OSS 前检查引用计数（P2-12：避免误删被其他资产/分镜引用的 URL）
    for (const url of urlsToClean) {
      try {
        await deleteOssFileIfNotReferenced(url);
      } catch (e) {
        console.error('[app] 数字资产 OSS 清理失败:', url, e.message);
      }
    }
    // P3-22：联动清理该资产的 ai_generated_images 历史记录
    try {
      await deleteAiGeneratedByOwner('asset', id);
    } catch (e) {
      console.error('[app] 数字资产 AI 历史清理失败:', e.message);
    }
    console.log(`[app] 删除数字资产: ID ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 删除数字资产失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST 新增数字资产图片
app.post('/api/projects/:projectId/assets/:assetId/images', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const assetId = parseInt(req.params.assetId);
    const { imageUrl, size } = req.body || {};

    if (!imageUrl || !imageUrl.trim()) {
      return res.status(400).json({ success: false, message: '图片地址不能为空' });
    }

    const asset = await db.digitalAssets.getById(assetId);
    if (!asset) return res.status(404).json({ success: false, message: '数字资产不存在' });
    if (asset.projectId !== projectId) {
      return res.status(400).json({ success: false, message: '数字资产不属于该项目' });
    }

    // 兜底：如果 size 为 0 或未传入，且 URL 是 OSS URL，自动从 OSS 获取文件大小
    let finalSize = size || 0;
    if (!finalSize && imageUrl && imageUrl.startsWith('http') && isOSSConfigured && ossClient) {
      try {
        finalSize = await getOssFileSize(imageUrl);
        if (finalSize > 0) {
          console.log(`[digital-asset] 自动获取 OSS 文件大小: ${imageUrl} → ${finalSize} bytes`);
        }
      } catch (e) {
        console.warn('[digital-asset] 获取 OSS 文件大小失败:', imageUrl, e.message);
      }
    }

    const image = await db.digitalAssets.addImage(assetId, imageUrl.trim(), finalSize);
    console.log(`[app] 新增数字资产图片: assetId=${assetId}, size=${finalSize}`);
    res.json({ success: true, data: image });
  } catch (error) {
    console.error('[app] 新增数字资产图片失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE 删除数字资产图片
app.delete('/api/projects/:projectId/assets/:assetId/images/:imageId', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const assetId = parseInt(req.params.assetId);
    const imageId = parseInt(req.params.imageId);

    const asset = await db.digitalAssets.getById(assetId);
    if (!asset) return res.status(404).json({ success: false, message: '数字资产不存在' });
    if (asset.projectId !== projectId) {
      return res.status(400).json({ success: false, message: '数字资产不属于该项目' });
    }

    // 先查图片 url（用于 OSS 清理）
    const img = (asset.images || []).find(i => i.id === imageId);
    const urlToDelete = img?.imageUrl || '';

    const success = await db.digitalAssets.deleteImage(assetId, imageId);
    if (!success) return res.status(404).json({ success: false, message: '图片不存在' });

    // 删 OSS 前检查引用计数（P2-12：避免误删被其他资产/分镜引用的 URL）
    if (urlToDelete) {
      try {
        await deleteOssFileIfNotReferenced(urlToDelete);
      } catch (e) {
        console.error('[app] 数字资产图片 OSS 清理失败:', urlToDelete, e.message);
      }
    }

    console.log(`[app] 删除数字资产图片: imageId=${imageId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 删除数字资产图片失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Scenes API ====================

app.get('/api/projects/:projectId/scenes', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const project = await db.projects.getById(projectId);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const scenes = await db.scenes.getByProjectId(projectId);
    res.json({ success: true, data: scenes });
  } catch (error) {
    console.error('[app] 获取场次列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/projects/:projectId/scenes', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '场次名称不能为空' });
    }
    const project = await db.projects.getById(projectId);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const scene = await db.scenes.create({ projectId, name: name.trim() });
    console.log(`[app] 新建场次: ${name}`);
    res.json({ success: true, data: scene });
  } catch (error) {
    console.error('[app] 新建场次失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/scenes/sort', async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders)) return res.status(400).json({ success: false, message: 'orders 应为数组' });
    await db.scenes.updateSort(orders.filter(o => o && typeof o.id === 'number' && typeof o.sortOrder === 'number'));
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 更新场次排序失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/scenes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, scrollPosition } = req.body;
    await db.scenes.update(id, {
      name: name !== undefined ? name.trim() : undefined,
      scrollPosition: scrollPosition !== undefined ? parseInt(scrollPosition) : undefined
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 更新场次失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/scenes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.scenes.delete(id);
    console.log(`[app] 场次 ID ${id} 已删除，视频归到未分类`);
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 删除场次失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Field Suggestions API ====================

// GET 获取字段补全建议（从分镜数据和数字资产聚合）
app.get('/api/projects/:projectId/field-suggestions', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const project = await db.projects.getById(projectId);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    // 获取项目下所有分镜
    const shots = await db.items.getByFilter({ projectId, deleted: 0 });

    // 获取项目下所有数字资产
    const assets = await db.digitalAssets.getByProjectId(projectId);

    // 聚合字段值（不包括旁白和备注）
    const suggestions = {
      location: new Set(),
      actors: new Set(),
      costume: new Set(),
      props: new Set(),
      shotType: new Set(),
      focalLength: new Set(),
      shotAngle: new Set(),
      lighting: new Set(),
      cameraMovement: new Set()
    };

    // 从分镜数据中聚合
    shots.forEach(shot => {
      if (shot.location && shot.location.trim()) suggestions.location.add(shot.location.trim());
      if (shot.actors && shot.actors.trim()) suggestions.actors.add(shot.actors.trim());
      if (shot.costume && shot.costume.trim()) suggestions.costume.add(shot.costume.trim());
      if (shot.props && shot.props.trim()) suggestions.props.add(shot.props.trim());
      if (shot.shotType && shot.shotType.trim()) suggestions.shotType.add(shot.shotType.trim());
      if (shot.focalLength && shot.focalLength.trim()) suggestions.focalLength.add(shot.focalLength.trim());
      if (shot.shotAngle && shot.shotAngle.trim()) suggestions.shotAngle.add(shot.shotAngle.trim());
      if (shot.lighting && shot.lighting.trim()) suggestions.lighting.add(shot.lighting.trim());
      if (shot.cameraMovement && shot.cameraMovement.trim()) suggestions.cameraMovement.add(shot.cameraMovement.trim());
    });

    // 从数字资产中添加名称（演员、道具、场景）
    assets.forEach(asset => {
      if (asset.name && asset.name.trim()) {
        if (asset.type === 'actor') {
          suggestions.actors.add(asset.name.trim());
        } else if (asset.type === 'prop') {
          suggestions.props.add(asset.name.trim());
        } else if (asset.type === 'scene') {
          suggestions.location.add(asset.name.trim());
        }
      }
    });

    // 将 Set 转为数组并排序
    const result = {};
    Object.keys(suggestions).forEach(key => {
      result[key] = Array.from(suggestions[key]).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    });

    // 添加场景资产映射（地点名 -> 场景资产图 URL），供前端自动匹配
    const sceneAssetsMap = {};
    assets.forEach(asset => {
      if (asset.type === 'scene' && asset.name && asset.name.trim() && asset.imageUrl) {
        sceneAssetsMap[asset.name.trim().toLowerCase()] = {
          name: asset.name.trim(),
          imageUrl: asset.imageUrl,
          imagePrompt: asset.imagePrompt || ''
        };
      }
    });
    result.sceneAssets = sceneAssetsMap;

    // 添加演员资产映射
    const actorAssetsMap = {};
    assets.forEach(asset => {
      if (asset.type === 'actor' && asset.name && asset.name.trim()) {
        actorAssetsMap[asset.name.trim().toLowerCase()] = {
          name: asset.name.trim(),
          imageUrl: asset.imageUrl || '',
          imagePrompt: asset.imagePrompt || ''
        };
      }
    });
    result.actorAssets = actorAssetsMap;

    // 添加道具资产映射
    const propAssetsMap = {};
    assets.forEach(asset => {
      if (asset.type === 'prop' && asset.name && asset.name.trim()) {
        propAssetsMap[asset.name.trim().toLowerCase()] = {
          name: asset.name.trim(),
          imageUrl: asset.imageUrl || '',
          imagePrompt: asset.imagePrompt || ''
        };
      }
    });
    result.propAssets = propAssetsMap;

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[app] 获取字段补全建议失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== 上传与封面 API ====================

// 直传 OSS 后注册 DB 记录（不经过服务器的上传场景）
// 复用 /api/upload/image 的 DB 记录创建逻辑，但不处理文件上传和压缩
app.post('/api/media/register', async (req, res) => {
  try {
    const { url, filename, size, type, usage, projectId, sceneId, createShot, title, isAwaitingTranscode } = req.body || {};
    if (!url) return res.status(400).json({ success: false, message: '缺少 url 参数' });
    if (!projectId) return res.status(400).json({ success: false, message: '缺少 projectId 参数' });

    const reference = usage === 'project-reference' ? 1 : 0;
    const itemTitle = title || filename || '未命名';
    let item = null;

    try {
      if (usage === 'project-cover' || usage === 'shot-reference' || usage === 'digital-asset') {
        // 这些用途不创建 videos 记录，避免 ghost 记录阻止 OSS 清理
        // 实际媒体记录由后续 API 调用创建
      } else if (createShot) {
        const shot = await db.items.createShot({
          projectId: parseInt(projectId),
          sceneId: sceneId ? parseInt(sceneId) : null,
          sceneContent: itemTitle,
          status: 'pending',
          type: type || 'image',
          filename: filename || '',
          url,
          size: size || 0,
        });
        await db.shotMedia.create({
          shotId: shot.id,
          url,
          type: type || 'image',
          filename: filename || '',
          size: size || 0,
          source: reference ? 'reference' : 'upload'
        });
        item = { id: shot.id, shotId: shot.id, url, filename, isShot: true };
      } else {
        item = await db.items.create({
          title: itemTitle,
          filename: filename || '',
          url,
          size: size || 0,
          status: 'pending',
          projectId: parseInt(projectId),
          sceneId: sceneId ? parseInt(sceneId) : null,
          type: type || 'image',
          reference: reference ? 1 : 0
        });
      }
    } catch (dbError) {
      // DB 写入失败：清理已直传到 OSS 的文件
      if (url && url.startsWith('http')) {
        try {
          await deleteStandaloneOssFile(url);
          console.log('[media/register] DB 写入失败，已清理 OSS 文件:', url);
        } catch (e) {
          console.warn('[media/register] 清理 OSS 文件失败:', e.message);
        }
      }
      throw dbError;
    }

    // 非参考素材且非封面且不等待转码：尝试设置项目默认封面
    // 等待转码的媒体在转码成功后再设置封面，避免转码失败后封面指向已删除的文件
    if (projectId && !reference && usage !== 'project-cover' && !isAwaitingTranscode) {
      trySetProjectCoverIfDefault(parseInt(projectId), url, type || 'image').catch(() => {});
    }

    res.json({ success: true, id: item?.id, shotId: item?.shotId, url, filename });
  } catch (error) {
    console.error('[media/register] 注册媒体记录失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除 OSS 文件（直传后 DB 注册失败等场景的清理）
app.post('/api/oss/delete', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, message: '缺少 url 参数' });
    await deleteStandaloneOssFile(url);
    console.log('[oss/delete] 已删除 OSS 文件:', url);
    res.json({ success: true });
  } catch (error) {
    console.error('[oss/delete] 删除 OSS 文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/upload/image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    if (!validateFileSize(req.file.size, 'image')) {
      return res.status(400).json({ error: `图片不能超过 ${FILE_SIZE_LIMITS.image / (1024*1024)}MB` });
    }

    // 从数据库读取图片压缩阈值（判断阈值和压缩目标为同一个值）
    const thresholdKBStr = await db.settings.get('image_compress_threshold_kb');
    const thresholdKB = thresholdKBStr ? parseInt(thresholdKBStr) : 300; // 默认 300KB

    const { projectId, sceneId, usage, createShot } = req.body || {};
    // 数据库 reference 字段：仅 project-reference 时为 1（项目参考素材）
    const reference = usage === 'project-reference' ? 1 : 0;
    const title = req.body && req.body.title ? req.body.title : req.file.originalname;
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}-${req.file.originalname}`;
    const filePath = req.file.path;
    const originalSizeKB = (req.file.size / 1024).toFixed(2);
    let compressed = false;
    let compressionError = null;
    let fileBuffer = fs.readFileSync(filePath);
    if (req.file.size > thresholdKB * 1024) {
      try {
        const beforeSize = fileBuffer.length;
        fileBuffer = await compressImage(fileBuffer, thresholdKB, req.file.mimetype);
        compressed = true;
        const afterSize = fileBuffer.length;
        console.log(`[app] 图片压缩: ${req.file.originalname} | 格式: ${req.file.mimetype} | ${originalSizeKB}KB → ${(afterSize / 1024).toFixed(2)}KB | 压缩率: ${((1 - afterSize / beforeSize) * 100).toFixed(1)}%`);
      } catch (e) {
        console.warn('[app] 图片压缩失败，使用原图:', e.stack || e.message);
        compressionError = e.message;
      }
    }
    let fileUrl = '';
    let ossKey = '';
    const forceLocalStorage = req.query.forceLocal === 'true';
    if (isOSSConfigured && !forceLocalStorage && ossClient) {
      try {
        // OSS 路径按 usage 分类
        if (!projectId) {
          return res.status(400).json({ error: 'projectId 不能为空' });
        }
        let folder;
        if (usage === 'project-cover') {
          folder = `projects/${projectId}/project-covers`;
        } else if (usage === 'project-reference') {
          folder = `projects/${projectId}/project-references`;
        } else if (usage === 'shot-reference') {
          folder = `projects/${projectId}/shot-references/images`;
        } else if (usage === 'digital-asset') {
          folder = `projects/${projectId}/digital-assets`;
        } else {
          folder = `projects/${projectId}/images`;
        }
        ossKey = `${folder}/${fileName}`;
        const result = await ossClient.put(ossKey, fileBuffer);
        fileUrl = result.url;
        try { fs.unlinkSync(filePath); } catch (e) {}
        console.log(`[app] 图片 OSS 上传成功 (${folder}): ${fileName}, url: ${fileUrl}`);
      } catch (ossError) {
        console.warn('[app] OSS 上传失败:', ossError.message);
        try { fs.unlinkSync(filePath); } catch (e) {}
        return res.status(500).json({ error: 'OSS 上传失败', ossError: true });
      }
    } else {
      if (compressed) fs.writeFileSync(filePath, fileBuffer);
      fileUrl = `/uploads/${fileName}`;
      console.log(`[app] 图片本地上传: ${fileName}`);
    }
    let item = null;
    try {
      if (usage === 'project-cover' || usage === 'shot-reference' || usage === 'digital-asset') {
        // 这些用途只上传到 OSS，不创建 videos 记录，避免产生 ghost 记录
        // ghost 记录会导致 isUrlReferenced 误判，阻止 OSS 文件清理
        // 实际的媒体记录由后续 API 调用创建：
        // - project-cover: PUT /api/projects/:id/cover
        // - shot-reference: POST /api/shots/:id/media (shot_media)
        // - digital-asset: POST /api/projects/:projectId/assets/:assetId/images (digital_asset_images)
      } else if (createShot && projectId) {
        const shot = await db.items.createShot({
          projectId: parseInt(projectId),
          sceneId: sceneId ? parseInt(sceneId) : null,
          sceneContent: title,
          status: 'pending',
          type: 'image',
          filename: fileName,
          url: fileUrl,
          size: fileBuffer.length,
        });
        await db.shotMedia.create({
          shotId: shot.id,
          url: fileUrl,
          type: 'image',
          filename: fileName,
          size: fileBuffer.length,
          source: reference ? 'reference' : 'upload'
        });
        item = { id: shot.id, shotId: shot.id, url: fileUrl, filename: fileName, isShot: true };
      } else {
        item = await db.items.create({
          title, filename: fileName, url: fileUrl,
          size: fileBuffer.length,
          status: 'pending',
          projectId: projectId ? parseInt(projectId) : null,
          sceneId: sceneId ? parseInt(sceneId) : null,
          type: 'image',
          reference: reference ? 1 : 0
        });
      }
    } catch (dbError) {
      // DB 写入失败：清理已上传的 OSS 文件，避免残留
      if (fileUrl && fileUrl.startsWith('http')) {
        try {
          await deleteStandaloneOssFile(fileUrl);
          console.log('[app] 图片 DB 写入失败，已清理 OSS 文件:', fileUrl);
        } catch (e) {
          console.warn('[app] 清理 OSS 文件失败:', e.message);
        }
      }
      throw dbError;
    }
    if (projectId && !reference && usage !== 'project-cover') {
      trySetProjectCoverIfDefault(parseInt(projectId), fileUrl, 'image').catch(() => {});
    }
    res.json({ success: true, url: fileUrl, ossKey, filename: fileName, compressed, originalSizeKB: parseFloat(originalSizeKB), compressedSizeKB: parseFloat((fileBuffer.length / 1024).toFixed(2)), id: item?.id, compressionError });
  } catch (error) {
    console.error('[app] 图片上传失败:', error.message);
    // P3-6：清理 multer 临时文件
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// OSS 签名 URL 代理 - 用于私有 Bucket 的图片/视频访问
// [已弃用] /api/oss-proxy 端点已删除（违反"OSS 前端直连不通过代理"硬约束）
// 前端请改用 /api/oss-sign-url 获取签名 URL 后直连 OSS

// 签名 URL 接口：前端直连 OSS，服务器只负责生成签名
app.get('/api/oss-sign-url', async (req, res) => {
  try {
    // 安全约束：忽略客户端传入的 bucket 参数，强制使用配置的 OSS_BUCKET
    const { url, key } = req.query;
    if (!isOSSConfigured || !ossClient) {
      return res.status(400).json({ error: 'OSS 未配置' });
    }

    let ossKey = key;
    let queryParams = null;

    // 从 URL 中提取 key 和 query 参数
    if (!ossKey && url) {
      const urlStr = String(url);
      const match = urlStr.match(/^https?:\/\/([^.]+)\.oss-[^.]+\.aliyuncs\.com\/([^?]+)(\?.*)?$/);
      if (match) {
        ossKey = decodeURIComponent(match[2]);
        if (match[3]) {
          try {
            const u = new URL(urlStr);
            queryParams = {};
            u.searchParams.forEach((value, k) => {
              queryParams[k] = value;
            });
          } catch (e) {}
        }
      } else {
        try {
          const urlObj = new URL(urlStr);
          ossKey = decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
          queryParams = {};
          urlObj.searchParams.forEach((value, k) => {
            queryParams[k] = value;
          });
        } catch (e) {
          if (urlStr.startsWith('/')) ossKey = decodeURIComponent(urlStr.slice(1));
        }
      }
    }

    if (!ossKey) {
      return res.status(400).json({ error: '无法获取 OSS key' });
    }

    // 强制使用配置的 Bucket，禁止跨 Bucket 签名
    const signOptions = { expires: 3600 };
    if (queryParams && Object.keys(queryParams).length > 0) {
      if (queryParams['x-oss-process']) {
        signOptions.process = queryParams['x-oss-process'];
        const otherParams = { ...queryParams };
        delete otherParams['x-oss-process'];
        if (Object.keys(otherParams).length > 0) {
          signOptions.query = otherParams;
        }
      } else {
        signOptions.query = queryParams;
      }
    }
    const signedUrl = ossClient.signatureUrl(ossKey, signOptions);
    res.json({ signedUrl, key: ossKey, bucket: OSS_BUCKET });
  } catch (error) {
    console.error('[oss-sign-url] 生成签名失败:', error.message);
    res.status(500).json({ error: '生成签名失败: ' + error.message });
  }
});

// 批量签名 URL 接口：一次性为多个 URL 生成签名（减少前端请求）
app.get('/api/oss-sign-urls', async (req, res) => {
  try {
    const { urls } = req.query;
    if (!isOSSConfigured || !ossClient) {
      return res.status(400).json({ error: 'OSS 未配置' });
    }
    const urlList = Array.isArray(urls) ? urls : (urls ? [urls] : []);
    if (urlList.length === 0) {
      return res.json({ signedUrls: {} });
    }

    const results = {};

    for (const urlStr of urlList) {
      const str = String(urlStr);
      let ossKey = '';
      let queryParams = null;

      const match = str.match(/^https?:\/\/([^.]+)\.oss-[^.]+\.aliyuncs\.com\/([^?]+)(\?.*)?$/);
      if (match) {
        ossKey = decodeURIComponent(match[2]);
        if (match[3]) {
          try {
            const u = new URL(str);
            queryParams = {};
            u.searchParams.forEach((value, k) => {
              queryParams[k] = value;
            });
          } catch (e) {}
        }
      } else {
        try {
          const urlObj = new URL(str);
          ossKey = decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
          queryParams = {};
          urlObj.searchParams.forEach((value, k) => {
            queryParams[k] = value;
          });
        } catch (e) {
          if (str.startsWith('/')) ossKey = decodeURIComponent(str.slice(1));
        }
      }

      if (ossKey) {
        // 强制使用配置的 Bucket，禁止跨 Bucket 签名
        try {
          const signOptions = { expires: 3600 };
          if (queryParams && Object.keys(queryParams).length > 0) {
            if (queryParams['x-oss-process']) {
              signOptions.process = queryParams['x-oss-process'];
              const otherParams = { ...queryParams };
              delete otherParams['x-oss-process'];
              if (Object.keys(otherParams).length > 0) {
                signOptions.query = otherParams;
              }
            } else {
              signOptions.query = queryParams;
            }
          }
          results[str] = ossClient.signatureUrl(ossKey, signOptions);
        } catch (e) {
          results[str] = str;
        }
      } else {
        results[str] = str;
      }
    }

    res.json({ signedUrls: results });
  } catch (error) {
    console.error('[oss-sign-urls] 批量签名失败:', error.message);
    res.status(500).json({ error: '批量签名失败: ' + error.message });
  }
});

// OSS 视频截图代理接口：避免浏览器 ORB 拦截
app.get('/api/oss-snapshot', async (req, res) => {
  try {
    const { url, t, w } = req.query;
    if (!url) {
      return res.status(400).json({ error: '缺少 url 参数' });
    }
    if (!isOSSConfigured || !ossClient) {
      return res.status(400).json({ error: 'OSS 未配置' });
    }
    const rawUrl = String(url);
    if (!rawUrl.includes('aliyuncs.com') && !rawUrl.includes('qiziwenhua.top')) {
      return res.status(400).json({ error: '仅支持 OSS URL' });
    }

    // 从 URL 中提取 OSS key
    let ossKey = '';
    const match = rawUrl.match(/^https?:\/\/([^.]+)\.oss-[^.]+\.aliyuncs\.com\/([^?]+)(\?.*)?$/);
    if (match) {
      ossKey = decodeURIComponent(match[2]);
    } else {
      try {
        const urlObj = new URL(rawUrl);
        ossKey = decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
      } catch (e) {
        return res.status(400).json({ error: '无法解析 OSS key' });
      }
    }
    if (!ossKey) {
      return res.status(400).json({ error: '无法获取 OSS key' });
    }

    const time = t ? String(t) : '1000';
    const width = w ? String(w) : '160';

    // 截图持久化缓存：首次截图后保存到 OSS，后续直接读取，避免重复收取视频截帧处理费
    // 截图保存路径：与源视频同项目下 thumbnails/ 目录
    // 缓存 key 包含模式标识（accurate=精确模式），避免旧 m_fast 模式缓存与精确模式混淆
    let projectIdFromKey = '';
    const projMatch = ossKey.match(/^projects\/(\d+)\//);
    if (projMatch) projectIdFromKey = projMatch[1];
    const thumbnailDir = projectIdFromKey
      ? `projects/${projectIdFromKey}/thumbnails`
      : 'thumbnails';
    const cacheMode = 'accurate';
    const thumbnailKey = `${thumbnailDir}/${crypto.createHash('md5').update(ossKey + '_' + time + '_' + width + '_' + cacheMode).digest('hex')}.jpg`;

    // 先检查截图缓存是否已存在
    let cacheExists = false;
    try {
      await ossClient.head(thumbnailKey);
      cacheExists = true;
    } catch (headErr) {
      if (headErr.code !== 'NoSuchKey' && headErr.status !== 404) {
        console.warn('[oss-snapshot] 检查缓存失败，将重新生成截图:', headErr.message);
      }
    }

    if (cacheExists) {
      // 缓存命中：直接读取已保存的截图，仅产生 GET 请求费和流量费，不产生视频截帧处理费
      const cachedSignedUrl = ossClient.signatureUrl(thumbnailKey, { expires: 3600 });
      const response = await fetch(cachedSignedUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      }
      // 读取失败则回退到重新生成
      console.warn('[oss-snapshot] 缓存读取失败，重新生成截图');
    }

    // 缓存未命中或读取失败：调用 OSS 视频截帧
    // 注意：不使用 m_fast 模式，m_fast 基于关键帧截帧可能导致截到上一个镜头的画面
    const process = `video/snapshot,t_${time},f_jpg,w_${width}`;
    const signedUrl = ossClient.signatureUrl(ossKey, {
      expires: 3600,
      process
    });

    const response = await fetch(signedUrl);
    if (!response.ok) {
      console.error('[oss-snapshot] OSS 返回错误:', response.status, response.statusText);
      return res.status(response.status).send('截图失败');
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // 异步保存截图到 OSS（不阻塞响应）
    ossClient.put(thumbnailKey, buffer).catch(putErr => {
      console.warn('[oss-snapshot] 保存截图缓存失败:', putErr.message);
    });

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (error) {
    console.error('[oss-snapshot] 失败:', error.message);
    res.status(500).send('截图失败');
  }
});

// OSS 上传凭证接口：前端直传 OSS，服务器只负责生成凭证
app.get('/api/oss-upload-credential', async (req, res) => {
  try {
    const { projectId, filename, type, usage } = req.query;
    if (!isOSSConfigured || !ossClient) {
      return res.status(400).json({ error: 'OSS 未配置' });
    }
    if (!projectId || !filename || !type) {
      return res.status(400).json({ error: '缺少必要参数: projectId, filename, type' });
    }

    // 净化 filename：仅取 basename，并过滤掉路径分隔符与危险字符（防路径穿越）
    const safeFilename = path.basename(String(filename)).replace(/[^\w.\-\u4e00-\u9fa5]/g, '');
    if (!safeFilename) {
      return res.status(400).json({ error: 'filename 无效' });
    }

    let subDir;
    if (usage === 'project-cover') {
      subDir = 'project-covers';
    } else if (usage === 'project-reference') {
      subDir = 'project-references';
    } else if (usage === 'shot-reference') {
      subDir = type === 'video' ? 'shot-references/videos' : 'shot-references/images';
    } else if (usage === 'digital-asset') {
      subDir = 'digital-assets';
    } else {
      subDir = type === 'video' ? 'videos' : 'images';
    }
    const ossKey = `projects/${projectId}/${subDir}/${Date.now()}-${Math.random().toString(36).substr(2, 8)}-${safeFilename}`;

    // 生成表单上传签名（content-length-range 上限与 FILE_SIZE_LIMITS.video 1GB 对齐）
    const policy = Buffer.from(JSON.stringify({
      expiration: new Date(Date.now() + 3600 * 1000).toISOString(),
      conditions: [['content-length-range', 0, 1024 * 1024 * 1024]]
    })).toString('base64');

    const signature = crypto.createHmac('sha1', ALIYUN_ACCESS_KEY_SECRET).update(policy).digest('base64');

    res.json({
      host: `https://${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com`,
      accessKeyId: ALIYUN_ACCESS_KEY_ID,
      policy,
      signature,
      key: ossKey,
      bucket: OSS_BUCKET,
      region: OSS_REGION
    });
  } catch (error) {
    console.error('[oss-upload-credential] 生成凭证失败:', error.message);
    res.status(500).json({ error: '生成上传凭证失败: ' + error.message });
  }
});

app.post('/api/upload/video', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    if (!validateFileSize(req.file.size, 'video')) {
      return res.status(400).json({ error: `视频不能超过 ${FILE_SIZE_LIMITS.video / (1024*1024)}MB` });
    }
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}-${req.file.originalname}`;
    const filePath = req.file.path;
    const shouldCompress = req.query.compress === 'true';
    const forceLocalStorage = req.query.forceLocal === 'true';
    const taskId = 'v2-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);

    videoTasks.set(taskId, {
      status: 'processing', progress: 0, compressProgress: 0, uploadProgress: 0,
      message: '上传中...', result: null, error: null, errorCode: null,
      filePath, fileName, shouldCompress, forceLocalStorage,
      projectId: req.body && req.body.projectId ? parseInt(req.body.projectId) : null,
      sceneId: req.body && req.body.sceneId ? parseInt(req.body.sceneId) : null,
      usage: req.body && req.body.usage ? req.body.usage : null,
      createShot: req.body && req.body.createShot ? true : false,
      title: req.body && req.body.title ? req.body.title : null,
      fileSize: req.file.size,
      createdAt: Date.now(),
      lastQueriedAt: Date.now()  // 心跳：前端查询状态时刷新，用于检测孤儿任务
    });
    res.json({ taskId, status: 'queued' });

    (async () => {
      try {
        const task = videoTasks.get(taskId);
        if (!task) return;
        // 数据库 reference 字段：仅 project-reference 时为 1（项目参考素材）
        const reference = task.usage === 'project-reference' ? 1 : 0;
        let fileUrl = '';
        let compressed = false;
        let uploadPath = filePath;
        let isTempFile = false;

        if (task.shouldCompress) {
          try {
            const originalSize = task.fileSize;
            const videoInfo = await getVideoInfo(filePath);
            const targetBitrate = await getTargetBitrate(videoInfo.width, videoInfo.height);
            console.log(`[app] 视频压缩检查: 文件=${task.fileName}, 原始大小=${(originalSize/1024/1024).toFixed(2)}MB, 码率=${videoInfo.bitrateKbps ? videoInfo.bitrateKbps + 'kbps' : '未知'}, 分辨率=${Math.max(videoInfo.width, videoInfo.height)}p (${videoInfo.width}x${videoInfo.height}), 目标码率=${targetBitrate}kbps`);
            
            // 使用统一的码率阈值判断：原始码率 > 目标码率时需要压缩
            if (aliyunVideo.shouldCompress(videoInfo.bitrateKbps, targetBitrate)) {
              task.message = '等待压缩（当前并发数：' + currentCompressions + '/' + MAX_CONCURRENT_COMPRESSIONS + '）...';
              videoTasks.set(taskId, task);
              
              const compressResult = await runWithCompressionLimit(() => 
                compressVideoFile(filePath, targetBitrate, (p) => {
                  task.compressProgress = p.progress;
                  task.message = '正在压缩视频...';
                  videoTasks.set(taskId, task);
                })
              );
              
              if (compressResult.success && compressResult.outputPath) {
                uploadPath = compressResult.outputPath;
                isTempFile = true;
                compressed = true;
                task.compressProgress = 100;
                if (compressResult.size) {
                  task.fileSize = compressResult.size;
                  const reduction = ((1 - compressResult.size / originalSize) * 100).toFixed(1);
                  console.log(`[app] 视频压缩成功: ${(originalSize/1024/1024).toFixed(2)}MB -> ${(compressResult.size/1024/1024).toFixed(2)}MB (减小${reduction}%)`);
                }
              } else {
                console.log(`[app] 视频压缩未执行或未减小体积: ${compressResult.reason || compressResult.error || '未知原因'}，使用原始文件`);
              }
            } else {
              console.log(`[app] 视频码率 ${videoInfo.bitrateKbps ? videoInfo.bitrateKbps + 'kbps' : '未知'} 未超过目标码率 ${targetBitrate}kbps (${videoInfo.resolution})，跳过压缩`);
            }
          } catch (e) {
            // P3-7：记录结构化错误码，前端可按 code 判断是否提示用户尝试其他压缩方式
            task.errorCode = 'COMPRESSION_FAILED';
            console.warn('[app] 视频压缩失败，使用原始文件:', e.message);
          }
        }

        task.uploadProgress = 50;
        task.message = '正在上传...';
        videoTasks.set(taskId, task);

        if (isOSSConfigured && !task.forceLocalStorage && ossClient) {
          try {
            // OSS 路径按 usage 分类
            if (!task.projectId) {
              throw new Error('上传任务缺少 projectId');
            }
            let folder;
            if (task.usage === 'project-reference') {
              folder = `projects/${task.projectId}/project-references`;
            } else if (task.usage === 'shot-reference') {
              folder = `projects/${task.projectId}/shot-references/videos`;
            } else {
              folder = `projects/${task.projectId}/videos`;
            }
            const ossKey = `${folder}/${task.fileName}`;
            task.ossKey = ossKey;
            const result = await ossClient.put(ossKey, uploadPath);
            fileUrl = result.url;
            // 清理临时文件
            if (isTempFile) {
              try { fs.unlinkSync(uploadPath); } catch (e) {}
            }
            try { if (filePath !== uploadPath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
            console.log(`[app] 视频 OSS 上传成功 (${folder}): ${task.fileName}`);
          } catch (e) {
            console.warn('[app] OSS 上传失败:', e.message);
            throw new Error('OSS 上传失败');
          }
        } else {
          fileUrl = `/uploads/${task.fileName}`;
          task.ossKey = '';
        }

        // 用户取消上传：清理已上传的 OSS 文件，跳过 DB 写入
        if (task.cancelled) {
          if (fileUrl && fileUrl.startsWith('http')) {
            try {
              await deleteStandaloneOssFile(fileUrl);
              console.log('[app] 任务已取消，清理 OSS 文件:', fileUrl);
            } catch (e) {
              console.warn('[app] 取消后清理 OSS 失败:', e.message);
            }
          }
          task.status = 'cancelled';
          task.message = '已取消';
          videoTasks.set(taskId, task);
          scheduleTaskCleanup(videoTasks, taskId);
          return;
        }

        task.uploadProgress = 100;
        task.status = 'done';
        task.message = '上传成功';
        task.result = { url: fileUrl, compressed, fileName: task.fileName, ossKey: task.ossKey, fileSize: task.fileSize };

        // 心跳检查：若用户已离开（超过 5 分钟未查询状态），清理 OSS 文件，不写 DB
        const lastQueryAge = Date.now() - (task.lastQueriedAt || task.createdAt || Date.now());
        if (lastQueryAge > HEARTBEAT_TIMEOUT_MS) {
          console.log(`[app] 用户已离开（${Math.round(lastQueryAge / 1000 / 60)}分钟未查询），清理 OSS 文件: ${fileUrl}`);
          if (fileUrl && fileUrl.startsWith('http')) {
            try {
              await deleteStandaloneOssFile(fileUrl);
              console.log('[app] 孤儿任务 OSS 文件已清理:', fileUrl);
            } catch (e) {
              console.warn('[app] 清理孤儿任务 OSS 文件失败:', e.message);
            }
          }
          task.message = '用户已离开，任务已取消';
          videoTasks.set(taskId, task);
          scheduleTaskCleanup(videoTasks, taskId);
          return;
        }

        let item;
        try {
          if (task.createShot && task.projectId) {
            const shot = await db.items.createShot({
              projectId: task.projectId,
              sceneId: task.sceneId,
              sceneContent: task.title || task.fileName,
              status: 'pending',
              type: 'video',
              filename: task.fileName,
              url: fileUrl,
              size: task.fileSize,
            });
            await db.shotMedia.create({
              shotId: shot.id,
              url: fileUrl,
              type: 'video',
              filename: task.fileName,
              size: task.fileSize,
              source: reference ? 'reference' : 'upload'
            });
            item = { id: shot.id, shotId: shot.id, url: fileUrl, filename: task.fileName, isShot: true };
          } else if (task.usage === 'shot-reference') {
            // shot-reference 视频：只上传到 OSS，不创建 videos 记录，避免 ghost 记录
            // 实际的 shot_media 记录由后续 POST /api/shots/:id/media 创建
          } else {
            item = await db.items.create({
              title: task.title || task.fileName,
              filename: task.fileName,
              url: fileUrl,
              size: task.fileSize,
              status: 'pending',
              projectId: task.projectId,
              sceneId: task.sceneId,
              type: 'video',
              reference: reference
            });
          }
        } catch (dbError) {
          // DB 写入失败：清理已上传的 OSS 文件，避免残留
          if (fileUrl && fileUrl.startsWith('http')) {
            try {
              await deleteStandaloneOssFile(fileUrl);
              console.log('[app] 视频 DB 写入失败，已清理 OSS 文件:', fileUrl);
            } catch (e) {
              console.warn('[app] 清理 OSS 文件失败:', e.message);
            }
          }
          throw dbError;
        }
        if (task.projectId && !reference) {
          trySetProjectCoverIfDefault(task.projectId, fileUrl, 'video').catch(() => {});
        }
        if (item) task.result.id = item.id;
        videoTasks.set(taskId, task);
        scheduleTaskCleanup(videoTasks, taskId);  // P4-7：终态后 10 分钟清理
        console.log(`[app] 视频上传完成: ${task.fileName} (compressed=${compressed})`);
      } catch (err) {
        const task = videoTasks.get(taskId);
        if (task) {
          task.status = 'error';
          task.error = err.message;
          task.message = '上传失败';
          // P3-7：若压缩失败导致后续上传失败，保留 COMPRESSION_FAILED 错误码
          if (!task.errorCode) task.errorCode = 'UPLOAD_FAILED';
          videoTasks.set(taskId, task);
          scheduleTaskCleanup(videoTasks, taskId);  // P4-7：终态后 10 分钟清理
        }
        console.error('[app] 视频上传处理失败:', err.message);
      }
    })();
  } catch (error) {
    console.error('[app] 视频上传接口失败:', error.message);
    // P3-6：清理 multer 临时文件
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/upload/status/:taskId', async (req, res) => {
  const task = videoTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ status: 'not_found' });
  // 心跳：前端查询时刷新，用于完成时检测用户是否仍在线
  task.lastQueriedAt = Date.now();
  res.json({
    status: task.status,
    progress: task.progress,
    message: task.message,
    result: task.result,
    error: task.error,
    errorCode: task.errorCode || null
  });
});

// 取消上传任务：标记任务为已取消；若任务已完成（OSS + DB），清理残留记录和文件
// 由前端在用户取消上传时调用，避免后端异步任务完成后遗留孤儿文件
app.post('/api/upload/cancel/:taskId', async (req, res) => {
  try {
    const task = videoTasks.get(req.params.taskId);
    if (!task) {
      return res.json({ success: true, message: '任务不存在或已清理' });
    }
    task.cancelled = true;

    // 如果任务已完成（OSS 上传 + DB 写入），清理 DB 记录 + OSS 文件
    if (task.status === 'done' && task.result && task.result.url) {
      const fileUrl = task.result.url;
      console.log(`[app] 取消已完成任务，清理: ${fileUrl}`);
      try {
        // 删除 shot_media 行
        const mediaRows = await db.storyboardAsync.all(
          'SELECT shotId FROM shot_media WHERE url = ?',
          [fileUrl]
        );
        const shotIds = mediaRows.map(r => r.shotId).filter(Boolean);
        await db.storyboardAsync.run('DELETE FROM shot_media WHERE url = ?', [fileUrl]);
        // 删除因上一步而变得无媒体的 shots
        if (shotIds.length > 0) {
          const placeholders = shotIds.map(() => '?').join(',');
          await db.storyboardAsync.run(
            `DELETE FROM shots WHERE id IN (${placeholders}) AND id NOT IN (SELECT DISTINCT shotId FROM shot_media)`,
            shotIds
          );
        }
        // 删除 videos 行
        await db.storyboardAsync.run('DELETE FROM videos WHERE url = ?', [fileUrl]);
        // 删除 OSS 文件
        await deleteOssFileIfNotReferenced(fileUrl);
        console.log(`[app] 已清理取消任务的残留: ${fileUrl}`);
      } catch (e) {
        console.error('[app] 清理已取消任务失败:', e.message);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[app] 取消上传任务失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// P2-11：清理视频分割对话框未使用的孤儿视频（用户上传后未分割就关闭）
// 前端在 VideoSplitDialog 关闭时调用，后端检查引用计数后删除 OSS（已被 shot_media 引用的不删）
app.delete('/api/upload/orphan', async (req, res) => {
  try {
    const { url, ossKey } = req.body || {};
    const target = url || ossKey;
    if (!target) return res.status(400).json({ success: false, message: '缺少 url 或 ossKey' });
    // 引用计数检查：已被 shot_media / videos 引用的不删
    await deleteOssFileIfNotReferenced(target);
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 清理孤儿文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/projects/:id/cover', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { coverUrl } = req.body;
    if (!coverUrl) return res.status(400).json({ success: false, message: 'coverUrl 不能为空' });
    const project = await db.projects.getById(id);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const oldCoverUrl = project.coverUrl || '';
    await db.projects.update(id, { coverUrl });
    if (oldCoverUrl && oldCoverUrl !== coverUrl) {
      try {
        await db.storyboardAsync.run(
          'DELETE FROM videos WHERE reference = 1 AND type = ? AND url = ? AND projectId = ?',
          ['image', oldCoverUrl, id]
        );
      } catch (e) { console.error('[app] 清理旧封面 videos 行失败:', e.message); }
      try { await deleteStandaloneOssFile(oldCoverUrl); }
      catch (e) { console.error('[app] 清理旧封面 OSS 失败:', e.message); }
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 更新项目封面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/projects/:id/cover', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const project = await db.projects.getById(id);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const oldCoverUrl = project.coverUrl || '';
    await db.projects.update(id, { coverUrl: '' });
    if (oldCoverUrl) {
      // 先删上传封面图对应的 videos 行（reference=1, type='image'），
      // 使 isUrlReferenced 不再计数该行，从而允许 OSS 文件被删除
      try {
        await db.storyboardAsync.run(
          'DELETE FROM videos WHERE reference = 1 AND type = ? AND url = ? AND projectId = ?',
          ['image', oldCoverUrl, id]
        );
      } catch (e) { console.error('[app] 删除封面 videos 行失败:', e.message); }
      try { await deleteStandaloneOssFile(oldCoverUrl); }
      catch (e) { console.error('[app] 删除封面 OSS 失败:', e.message); }
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 删除项目封面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/projects/:id/reference', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const { title, type, url, filename, sceneId } = req.body;
    if (!url) return res.status(400).json({ success: false, message: '缺少 url' });
    const actualType = type === 'image' ? 'image' : 'video';
    const item = await db.items.create({
      title: title || (filename || '参考文件'),
      filename: filename || title || 'ref',
      url,
      status: 'pending',
      projectId,
      sceneId: sceneId ? parseInt(sceneId) : null,
      type: actualType,
      reference: 1
    });
    res.json({ success: true, data: item });
  } catch (error) {
    console.error('[app] 添加参考文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/projects/:id/references', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const items = await db.items.getByFilter({ projectId, deleted: 0, reference: 1 });
    res.json({ success: true, data: items });
  } catch (error) {
    console.error('[app] 获取参考文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 批量获取多个项目的参考文件（一次请求获取所有项目的参考）
app.get('/api/projects/references/batch', async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) {
      return res.json({ success: true, data: {} });
    }
    let idList;
    if (Array.isArray(ids)) {
      idList = ids;
    } else if (typeof ids === 'string') {
      idList = ids.split(',');
    } else {
      idList = [ids];
    }
    const projectIds = idList.map(Number).filter(Boolean);
    if (projectIds.length === 0) {
      return res.json({ success: true, data: {} });
    }
    
    // 使用 IN 子句一次性查询所有项目的参考文件
    const placeholders = projectIds.map(() => '?').join(',');
    const rows = await db.storyboardAsync.all(
      `SELECT * FROM videos WHERE projectId IN (${placeholders}) AND deleted = 0 AND reference = 1 ORDER BY projectId, sortOrder ASC, id ASC`,
      projectIds
    );
    
    // 按项目ID分组
    const result = {};
    for (const id of projectIds) {
      result[id] = [];
    }
    for (const row of rows) {
      if (result[row.projectId]) {
        result[row.projectId].push(row);
      }
    }
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[app] 批量获取参考文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除项目参考文件
app.delete('/api/projects/:projectId/references/:itemId', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const itemId = parseInt(req.params.itemId);
    const item = await db.items.getById(itemId);
    if (!item || item.projectId !== projectId) {
      return res.status(404).json({ success: false, message: '参考文件不存在' });
    }
    // 收集要清理的 OSS URL：item.url + item.coverUrl
    const urlsToClean = [item.url, item.coverUrl].filter(Boolean);
    // 硬删数据库记录（参考文件不走回收站，直接彻底删除）
    await db.items.hardDelete(itemId);
    // 删 OSS 前检查引用计数（P2-12：避免误删被分镜 shot_media 或其他参考文件共享的 URL）
    for (const url of urlsToClean) {
      try {
        await deleteOssFileIfNotReferenced(url, { excludeVideoId: itemId });
      } catch (e) {
        console.error('[app] 删除参考文件 OSS 失败:', url, e.message);
      }
    }
    // 如果被删的文件同时是项目封面，清除封面
    const project = await db.projects.getById(projectId);
    if (project && project.coverUrl === item.url) {
      await db.projects.update(projectId, { coverUrl: '' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[app] 删除参考文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/scenes/:sceneId/references', async (req, res) => {
  try {
    const sceneId = parseInt(req.params.sceneId);
    if (!sceneId || isNaN(sceneId)) {
      return res.status(400).json({ success: false, message: '无效的场次 ID' });
    }
    const images = await db.shotMedia.getBySceneId(sceneId);
    res.json({ success: true, data: images });
  } catch (error) {
    console.error('[app] 获取场次场景图失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== 微信分享落地页 ====================

function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.toString().replace(/[&<>'"]/g, m => map[m]);
}

function getFullImageUrl(imgPath, req) {
  if (!imgPath) return '';
  if (imgPath.startsWith('http://') || imgPath.startsWith('https://')) {
    return imgPath;
  }
  return `${req.protocol}://${req.get('host')}${imgPath.startsWith('/') ? '' : '/'}${imgPath}`;
}

app.get('/share/project/:id', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const project = await db.projects.getById(projectId);
    if (!project) {
      return res.redirect('/');
    }

    const distIndexPath = path.join(distDir, 'index.html');
    let html = fs.readFileSync(distIndexPath, 'utf-8');

    // 校验 Host 头是否在白名单内，防止 Host Header 注入
    const reqHost = req.get('host') || '';
    const allowedHosts = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
    const safeBase = (allowedHosts.length > 0 && allowedHosts.includes(reqHost))
      ? `${req.protocol}://${reqHost}`
      : (process.env.PUBLIC_BASE_URL || `${req.protocol}://${reqHost}`);
    const origin = safeBase;
    const title = project.name;
    const description = project.description || '柒子文化AI拍摄辅助系统 · 项目分享';
    const image = project.coverUrl || '/images/hero-home.png';
    const shareUrl = `${origin}/share/project/${projectId}`;
    const redirectUrl = `${origin}/project/${projectId}`;

    html = html
      .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeHtml(title)}" />`)
      .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeHtml(description)}" />`)
      .replace(/<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${getFullImageUrl(image, req)}" />`)
      .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${escapeHtml(shareUrl)}" />`)
      .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeHtml(description)}" />`)
      .replace(/<meta name="wechat:title" content="[^"]*" \/>/, `<meta name="wechat:title" content="${escapeHtml(title)}" />`)
      .replace(/<meta name="wechat:description" content="[^"]*" \/>/, `<meta name="wechat:description" content="${escapeHtml(description)}" />`)
      .replace(/<meta name="wechat:image" content="[^"]*" \/>/, `<meta name="wechat:image" content="${getFullImageUrl(image, req)}" />`)
      .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${escapeHtml(title)}" />`)
      .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${escapeHtml(description)}" />`)
      .replace(/<meta name="twitter:image" content="[^"]*" \/>/, `<meta name="twitter:image" content="${getFullImageUrl(image, req)}" />`)
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
      .replace('</body>', `<script>setTimeout(function(){window.location.href='${escapeHtml(redirectUrl)}';},500);</script></body>`);

    console.log(`[app] 为项目 ID ${projectId} 渲染了分享落地页`);
    res.send(html);
  } catch (error) {
    console.error('[app] 渲染分享落地页失败:', error);
    res.redirect('/');
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/') || req.path.startsWith('/images/') || req.path.startsWith('/ffmpeg/') || req.path.startsWith('/share/')) {
    return next();
  }
  res.sendFile(path.join(distDir, 'index.html'));
});

// 全局错误处理中间件
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message, err.code || '');
  if (res.headersSent) {
    return next(err);
  }
  
  let statusCode = err.statusCode || err.status || 500;
  let errorMessage = err.message || 'Internal Server Error';
  
  // 处理 multer 错误
  if (err.code === 'LIMIT_FILE_SIZE') {
    statusCode = 413;
    errorMessage = '文件大小超过限制';
  } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    statusCode = 400;
    errorMessage = '上传字段名不正确';
  } else if (err.message && err.message.includes('只支持图片和视频文件')) {
    statusCode = 400;
  } else if (err.message && err.message.includes('不支持的')) {
    statusCode = 400;
  }
  
  res.status(statusCode).json({
    success: false,
    error: errorMessage
  });
});

// ========== 孤儿任务兜底扫描 ==========
// 每 10 分钟扫描一次：清理用户已离开（超过 30 分钟未查询）的 pending/processing 任务
// 覆盖场景：用户关闭浏览器后，后端异步任务完成但无人查询 → OSS 文件残留
async function cleanupOrphanTasks() {
  const now = Date.now();

  // 1. 扫描内存中的视频上传任务（服务器压缩路径）
  for (const [taskId, task] of videoTasks.entries()) {
    if (task.status !== 'processing') continue;
    const lastQueryAge = now - (task.lastQueriedAt || task.createdAt || now);
    if (lastQueryAge > ORPHAN_TASK_TIMEOUT_MS) {
      console.log(`[orphan-scan] 发现孤儿上传任务: ${taskId}, ${Math.round(lastQueryAge / 1000 / 60)}分钟未查询`);
      // 若任务已有 OSS URL，尝试清理
      if (task.result && task.result.url && task.result.url.startsWith('http')) {
        try {
          await deleteStandaloneOssFile(task.result.url);
          console.log(`[orphan-scan] 已清理孤儿任务 OSS 文件: ${task.result.url}`);
        } catch (e) {
          console.warn(`[orphan-scan] 清理孤儿任务 OSS 文件失败: ${e.message}`);
        }
      }
      task.status = 'cancelled';
      task.message = '孤儿任务已清理（用户长时间未查询）';
      task.error = '用户已离开，任务已取消';
      scheduleTaskCleanup(videoTasks, taskId);
    }
  }

  // 2. 扫描 transcode_tasks 表（阿里云 MPS 转码路径）
  try {
    const pendingTasks = await db.transcodeTasks.getPendingAndProcessing();
    for (const task of pendingTasks) {
      const lastQueriedAt = task.lastQueriedAt ? new Date(task.lastQueriedAt).getTime() : task.createdAt ? new Date(task.createdAt).getTime() : now;
      const lastQueryAge = now - lastQueriedAt;
      if (lastQueryAge > ORPHAN_TASK_TIMEOUT_MS) {
        console.log(`[orphan-scan] 发现孤儿转码任务: ${task.id}, ${Math.round(lastQueryAge / 1000 / 60)}分钟未查询`);
        // 清理 OSS 原始文件
        if (task.videoUrl) {
          try {
            await deleteOssFileIfNotReferenced(task.videoUrl);
            console.log(`[orphan-scan] 已清理原始 OSS 文件: ${task.videoUrl}`);
          } catch (e) {
            console.warn(`[orphan-scan] 清理原始 OSS 文件失败: ${e.message}`);
          }
        }
        // 清理转码输出文件
        if (task.outputUrl && task.outputUrl !== task.videoUrl) {
          try {
            await deleteStandaloneOssFile(task.outputUrl);
            console.log(`[orphan-scan] 已清理输出 OSS 文件: ${task.outputUrl}`);
          } catch (e) {
            console.warn(`[orphan-scan] 清理输出 OSS 文件失败: ${e.message}`);
          }
        }
        // 清理 videos 表记录
        if (task.videoUrl) {
          try {
            await db.storyboardAsync.run('DELETE FROM videos WHERE url = ?', [task.videoUrl]);
          } catch (e) { console.warn(`[orphan-scan] 清理 videos 记录失败: ${e.message}`); }
        }
        // 标记任务为已取消
        try {
          await db.transcodeTasks.update(task.id, {
            status: 'cancelled',
            error: '孤儿任务已清理（用户长时间未查询）'
          });
        } catch (e) {
          console.warn(`[orphan-scan] 更新转码任务状态失败: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error('[orphan-scan] 扫描 transcode_tasks 失败:', e.message);
  }
}

// 启动定时扫描（每 10 分钟一次）
setInterval(cleanupOrphanTasks, 10 * 60 * 1000);
// 启动后 1 分钟执行一次首次扫描，清理上次服务重启前遗留的孤儿任务
setTimeout(cleanupOrphanTasks, 60 * 1000);
console.log('[orphan-scan] 孤儿任务扫描已启动（每 10 分钟一次）');

// 启动时打印阿里云配置状态（脱敏）
(function printAliyunConfigStatus() {
  const creds = aliyunVideo.getAliyunCredentials ? aliyunVideo.getAliyunCredentials() : null;
  if (creds) {
    const mask = (s) => s ? `${s.substring(0, 4)}***${s.substring(s.length - 4)}` : '(未设置)';
    console.log('========== 阿里云配置状态 ==========');
    console.log('  AccessKey ID:', mask(creds.accessKeyId));
    console.log('  AccessKey Secret:', creds.accessKeySecret ? '已设置' : '未设置');
    console.log('  OSS Bucket:', creds.ossBucket || '(未设置)');
    console.log('  OSS Region:', creds.ossRegion || '(未设置)');
    console.log('  MPS Pipeline ID:', creds.mpsPipelineId || '(未设置)');
    console.log('====================================');
  } else {
    console.warn('[aliyun] 无法获取阿里云配置状态');
  }
})();

const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

server.timeout = 2400000;
server.keepAliveTimeout = 65000;
