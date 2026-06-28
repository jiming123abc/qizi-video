const express = require('express');
const cors = require('cors');
const compression = require('compression');
const OSS = require('ali-oss');
const multer = require('multer');
const path = require('path');
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

const _originalAiTaskUpdate = db.video2AiTasks.update.bind(db.video2AiTasks);
db.video2AiTasks.update = async function(taskId, updates) {
  const success = await _originalAiTaskUpdate(taskId, updates);
  if (success) {
    const task = await db.video2AiTasks.get(taskId);
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

// OSS 配置（优先使用无前缀的环境变量，支持向后兼容旧的 REACT_APP_ 前缀）
const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID_DEV || process.env.REACT_APP_OSS_ACCESS_KEY_ID;
const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET_DEV || process.env.REACT_APP_OSS_ACCESS_KEY_SECRET;
const OSS_BUCKET = process.env.OSS_BUCKET || process.env.REACT_APP_OSS_BUCKET;
const OSS_REGION = process.env.OSS_REGION || process.env.REACT_APP_OSS_REGION || 'oss-cn-beijing';

const isOSSConfigured = 
  OSS_ACCESS_KEY_ID && 
  OSS_ACCESS_KEY_ID !== '你的OSS AccessKey ID' &&
  OSS_ACCESS_KEY_SECRET && 
  OSS_ACCESS_KEY_SECRET !== '你的OSS AccessKey Secret' &&
  OSS_BUCKET && 
  OSS_BUCKET !== '你的Bucket名称';

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
  console.log(`[video2-server] 使用系统 ffmpeg: ${systemFfmpeg}`);
} else {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
    console.log(`[video2-server] 使用 ffmpeg-static: ${ffmpegPath}`);
  }
}

if (systemFfprobe) {
  ffmpeg.setFfprobePath(systemFfprobe);
  console.log(`[video2-server] 使用系统 ffprobe: ${systemFfprobe}`);
} else {
  const ffprobePath = require('ffprobe-static');
  if (ffprobePath && ffprobePath.path) {
    ffmpeg.setFfprobePath(ffprobePath.path);
    console.log(`[video2-server] 使用 ffprobe-static: ${ffprobePath.path}`);
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
      'http://localhost:3000',
      'http://localhost:3002',
      'http://localhost:5173',
      'http://localhost:8080',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3002',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:8080',
      'https://video.qiziwenhua.top',
      'https://qiziwenhua.top',
      'https://www.qiziwenhua.top'
    ];

app.use(cors({
  origin: function (origin, callback) {
    // 允许没有 origin 的请求（如移动端、Postman、同域请求）
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
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

app.get('/api/video2/auth/check', (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.json({ enabled: false, authenticated: true });
  }
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  res.json({ enabled: true, authenticated: token === ADMIN_TOKEN });
});

app.post('/api/video2/auth/login', (req, res) => {
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

app.use((req, res, next) => {
  if (ADMIN_TOKEN && req.path.startsWith('/api/video2/') && req.method !== 'GET') {
    if (req.path === '/api/video2/auth/login' || req.path === '/api/video2/auth/check') {
      return next();
    }
    return requireAuth(req, res, next);
  }
  next();
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

const distDir = process.env.VIDEO2_DIST_DIR || path.join(__dirname, '../dist');
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

let ossClient = null;
if (isOSSConfigured) {
  ossClient = new OSS({
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET,
    region: OSS_REGION,
    secure: true
  });
}

async function deleteOssFile(url) {
  if (!url || !ossClient) return;
  try {
    let key = '';
    const match = url.match(/aliyuncs\.com\/(.+)$/);
    if (match) {
      key = match[1];
    } else {
      const lastSlash = url.lastIndexOf('/');
      if (lastSlash !== -1) key = url.substring(lastSlash + 1);
    }
    if (key) {
      await ossClient.delete(key);
      console.log('[OSS] 已删除文件:', key);
    }
  } catch (e) {
    console.warn('[OSS] 删除文件失败（可能不存在）:', url, e.message);
  }
}

async function deleteOssFiles(urls) {
  for (const url of (urls || [])) {
    await deleteOssFile(url);
  }
}

async function uploadBufferToOSS(buffer, folder, ext, prefix = 'upload') {
  if (!isOSSConfigured || !ossClient) {
    throw new Error('OSS 未配置');
  }
  const fileName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const ossFileName = `${folder}/${fileName}`;
  const result = await ossClient.put(ossFileName, buffer);
  return result.url;
}

async function compressImage(buffer, maxSizeKB = 300) {
  const maxSizeBytes = maxSizeKB * 1024;
  
  if (buffer.length <= maxSizeBytes) {
    return buffer;
  }

  let quality = 0.9;
  let compressedBuffer = buffer;
  
  while (compressedBuffer.length > maxSizeBytes && quality > 0.1) {
    compressedBuffer = await sharp(buffer)
      .jpeg({ quality: Math.round(quality * 100) })
      .toBuffer();
    quality -= 0.05;
  }

  return compressedBuffer;
}

const DEFAULT_PROJECT_COVER_PREFIX = 'data:image/svg+xml';

async function trySetProjectCoverIfDefault(projectId, mediaUrl, mediaType) {
  if (!projectId || !mediaUrl) return false;
  try {
    const project = await db.video2Projects.getById(projectId);
    if (!project) return false;
    if (project.coverUrl && !project.coverUrl.startsWith(DEFAULT_PROJECT_COVER_PREFIX)) {
      return false;
    }
    let coverUrl = mediaUrl;
    if (mediaType === 'video' && (mediaUrl.includes('aliyuncs.com') || mediaUrl.includes('qiziwenhua.top'))) {
      coverUrl = mediaUrl + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
    }
    await db.video2Projects.update(projectId, { coverUrl });
    console.log(`[video2] 自动设置项目 ${projectId} 封面: ${coverUrl}`);
    return true;
  } catch (e) {
    console.warn('[video2] 自动设置项目封面失败:', e.message);
    return false;
  }
}

async function getVideoBitrate(inputPath) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.warn('获取视频比特率超时');
      resolve(null);
    }, 30000);

    try {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        clearTimeout(timeoutId);
        if (err) {
          console.warn('无法获取视频比特率:', err.message);
          resolve(null);
          return;
        }

        if (metadata && metadata.streams) {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          if (videoStream && videoStream.bit_rate) {
            const bitrateKbps = Math.round(parseInt(videoStream.bit_rate) / 1000);
            resolve(bitrateKbps);
            return;
          }
        }

        resolve(null);
      });
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('获取视频比特率出错:', err.message);
      resolve(null);
    }
  });
}

async function compressVideo(inputBuffer, maxBitrateKbps = 3000, onProgress) {
  return new Promise((resolve, reject) => {
    const tempInputPath = path.join(__dirname, `temp_${Date.now()}_input.mp4`);
    const tempOutputPath = path.join(__dirname, `temp_${Date.now()}_output.mp4`);
    
    const sizeMB = inputBuffer.length / (1024 * 1024);
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
        if (fs.existsSync(tempInputPath)) {
          fs.unlinkSync(tempInputPath);
        }
        if (fs.existsSync(tempOutputPath)) {
          fs.unlinkSync(tempOutputPath);
        }
      } catch (e) { }
      resolve(inputBuffer);
    }, timeoutMs);
    
    try {
      fs.writeFileSync(tempInputPath, inputBuffer);
      const originalSize = fs.statSync(tempInputPath).size;
      
      ffmpegCommand = ffmpeg(tempInputPath)
        .outputOptions([
          `-maxrate ${maxBitrateKbps + 500}k`,
          `-bufsize ${maxBitrateKbps * 2}k`,
          '-preset ultrafast',
          '-c:v libx264',
          '-c:a aac',
          '-crf 28',
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
            const outputBuffer = fs.readFileSync(tempOutputPath);
            const compressedSize = outputBuffer.length;
            console.log(`视频压缩完成: ${(originalSize / 1024 / 1024).toFixed(2)}MB -> ${(compressedSize / 1024 / 1024).toFixed(2)}MB`);
            
            fs.unlinkSync(tempInputPath);
            fs.unlinkSync(tempOutputPath);
            resolve(outputBuffer);
          } catch (err) {
            console.error('读取压缩后视频失败，使用原始文件:', err.message);
            try {
              fs.unlinkSync(tempInputPath);
              if (fs.existsSync(tempOutputPath)) {
                fs.unlinkSync(tempOutputPath);
              }
            } catch (e) { }
            resolve(inputBuffer);
          }
        })
        .on('error', (err) => {
          clearTimeout(timeoutId);
          console.warn('视频压缩失败，使用原始文件:', err.message);
          try {
            fs.unlinkSync(tempInputPath);
            if (fs.existsSync(tempOutputPath)) {
              fs.unlinkSync(tempOutputPath);
            }
          } catch (e) { }
          resolve(inputBuffer);
        })
        .save(tempOutputPath);
    } catch (err) {
      clearTimeout(timeoutId);
      console.error('视频压缩出错，使用原始文件:', err.message);
      try {
        if (fs.existsSync(tempInputPath)) {
          fs.unlinkSync(tempInputPath);
        }
        if (fs.existsSync(tempOutputPath)) {
          fs.unlinkSync(tempOutputPath);
        }
      } catch (e) { }
      resolve(inputBuffer);
    }
  });
}

async function compressVideoFile(inputPath, maxBitrateKbps = 3000, onProgress) {
  return new Promise((resolve, reject) => {
    const tempOutputPath = path.join(__dirname, `temp_${Date.now()}_output.mp4`);
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
          `-maxrate ${maxBitrateKbps + 500}k`,
          `-bufsize ${maxBitrateKbps * 2}k`,
          '-preset ultrafast',
          '-c:v libx264',
          '-c:a aac',
          '-crf 28',
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

const video2VideoTasks = new Map();

// ==================== video2 分镜管理 API（升级版） ====================

app.get('/api/video2/list', async (req, res) => {
  try {
    const { projectId, sceneId, status, deleted } = req.query;
    const items = await db.video2Items.getByFilter({
      projectId: projectId !== undefined ? parseInt(projectId) : undefined,
      sceneId: sceneId !== undefined ? (sceneId === 'null' ? null : parseInt(sceneId)) : undefined,
      status,
      deleted: deleted !== undefined ? parseInt(deleted) : 0
    });
    
    // 为每个分镜关联 media 数组
    const itemsWithMedia = await Promise.all(items.map(async (item) => {
      const media = await db.video2ShotMedia.getByShotId(item.id);
      return { ...item, media };
    }));
    
    res.json({ success: true, data: itemsWithMedia });
  } catch (error) {
    console.error('[video2] 获取列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== 分镜管理端点 ==========

// 创建分镜（无参考画面）
app.post('/api/video2/shots', async (req, res) => {
  try {
    const { projectId, sceneId, sceneContent, actors, props, location, focalLength, narration,
            cameraMovement, shotType, shotAngle, lighting, notes, estimatedDuration,
            aiImagePrompt, aiStylePrompt } = req.body;
    
    const shot = await db.video2Items.createShot({
      projectId: projectId ? parseInt(projectId) : null,
      sceneId: sceneId !== undefined ? (sceneId === null ? null : parseInt(sceneId)) : null,
      sceneContent: sceneContent || '新分镜',
      actors: actors || '',
      props: props || '',
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
    console.error('[video2] 创建分镜失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新分镜字段
app.put('/api/video2/shots/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    
    // 过滤允许更新的字段
    const allowedFields = [
      'sceneContent', 'actors', 'props', 'location', 'focalLength',
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
    
    await db.video2Items.updateShotFields(parseInt(id), updateData);
    
    // 返回更新后的分镜
    const shot = await db.video2Items.getById(parseInt(id));
    const media = await db.video2ShotMedia.getByShotId(parseInt(id));
    
    res.json({ success: true, data: { ...shot, media } });
  } catch (error) {
    console.error('[video2] 更新分镜失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 合并分镜
app.post('/api/video2/shots/merge', async (req, res) => {
  try {
    const { shotIds } = req.body;
    
    if (!shotIds || !Array.isArray(shotIds) || shotIds.length < 2) {
      return res.status(400).json({ success: false, message: '至少需要2个分镜才能合并' });
    }
    
    const merged = await db.video2Items.mergeShots(shotIds.map(id => parseInt(id)));
    
    res.json({ success: true, data: merged });
  } catch (error) {
    console.error('[video2] 合并分镜失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 克隆分镜
app.post('/api/video2/shots/:id/clone', async (req, res) => {
  try {
    const { id } = req.params;
    const shotId = parseInt(id);
    
    const originalShot = await db.video2Items.getById(shotId);
    if (!originalShot) {
      return res.status(404).json({ success: false, message: '分镜不存在' });
    }
    
    const newShot = await db.video2Items.createShot({
      projectId: originalShot.projectId,
      sceneId: originalShot.sceneId,
      sceneContent: originalShot.sceneContent || '',
      actors: originalShot.actors || '',
      props: originalShot.props || '',
      location: originalShot.location || '',
      focalLength: originalShot.focalLength || '',
      narration: originalShot.narration || '',
      cameraMovement: originalShot.cameraMovement || '',
      shotType: originalShot.shotType || '',
      shotAngle: originalShot.shotAngle || '',
      lighting: originalShot.lighting || '',
      notes: originalShot.notes || '',
      estimatedDuration: originalShot.estimatedDuration || '',
      aiImagePrompt: originalShot.aiImagePrompt || '',
      aiStylePrompt: originalShot.aiStylePrompt || '',
      status: originalShot.status || 'pending'
    });
    
    const originalMedia = await db.video2ShotMedia.getByShotId(shotId);
    const clonedMedia = [];
    
    for (const media of originalMedia) {
      const newMedia = await db.video2ShotMedia.create({
        shotId: newShot.id,
        url: media.url,
        type: media.type,
        filename: media.filename,
        size: media.size,
        duration: media.duration,
        sortOrder: media.sortOrder,
        source: media.source
      });
      clonedMedia.push(newMedia);
    }
    
    res.json({ success: true, data: { ...newShot, media: clonedMedia } });
  } catch (error) {
    console.error('[video2] 克隆分镜失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== 参考画面管理端点 ==========

// 获取分镜的参考画面
app.get('/api/video2/shots/:id/media', async (req, res) => {
  try {
    const { id } = req.params;
    const media = await db.video2ShotMedia.getByShotId(parseInt(id));
    res.json({ success: true, data: media });
  } catch (error) {
    console.error('[video2] 获取参考画面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 新增参考画面到分镜
app.post('/api/video2/shots/:id/media', async (req, res) => {
  try {
    const { id } = req.params;
    const { url, type, filename, size, source } = req.body;
    
    const shot = await db.video2Items.getById(parseInt(id));
    if (!shot) {
      return res.status(404).json({ success: false, message: '分镜不存在' });
    }
    
    const media = await db.video2ShotMedia.create({
      shotId: parseInt(id),
      url,
      type: type || 'image',
      filename: filename || '',
      size: size || 0,
      source: source || 'upload'
    });
    
    res.json({ success: true, data: media });
  } catch (error) {
    console.error('[video2] 新增参考画面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 上传参考画面到分镜（复用现有上传逻辑，但存储到 shot_media 表）
// 注意：此端点由 upload/video 和 upload/image 调用后自动处理

// 删除参考画面
app.delete('/api/video2/shots/:id/media/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    await db.video2ShotMedia.delete(parseInt(mediaId));
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 删除参考画面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 排序参考画面
app.put('/api/video2/shots/:id/media/sort', async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body; // [{ id: number, sortOrder: number }]
    await db.video2ShotMedia.updateSort(parseInt(id), items);
    const media = await db.video2ShotMedia.getByShotId(parseInt(id));
    res.json({ success: true, data: media });
  } catch (error) {
    console.error('[video2] 排序参考画面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== 设置端点 ==========

app.get('/api/video2/settings', async (req, res) => {
  try {
    const settings = await db.video2Settings.getAll();
    // 脱敏 API Key
    if (settings.geekai_api_key) {
      settings.geekai_api_key = settings.geekai_api_key.replace(/^(.{8}).*(.{4})$/, '$1••••••••$2');
    }
    if (settings.siliconflow_api_key) {
      settings.siliconflow_api_key = settings.siliconflow_api_key.replace(/^(.{8}).*(.{4})$/, '$1••••••••$2');
    }
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('[video2] 获取设置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    
    if (!key) {
      return res.status(400).json({ success: false, message: '缺少 key 参数' });
    }
    
    await db.video2Settings.set(key, value);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 保存设置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== AI 费用统计端点 ==========

app.get('/api/video2/ai/usage', async (req, res) => {
  try {
    const { period } = req.query;
    const stats = await db.video2AiUsage.getStats(period || 'month');
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[video2] 获取费用统计失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== AI 任务端点 ==========

// 查询 AI 任务状态
app.get('/api/video2/ai/task/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await db.video2AiTasks.get(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: '任务不存在' });
    }
    res.json({ success: true, data: task });
  } catch (error) {
    console.error('[video2] 查询 AI 任务失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// SSE 监听任务状态
app.get('/api/video2/ai/task/:taskId/stream', (req, res) => {
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
      if (updatedTask.status === 'completed' || updatedTask.status === 'failed' || updatedTask.status === 'error') {
        taskEvents.removeListener('taskUpdate', handleUpdate);
        res.end();
      }
    }
  };

  taskEvents.on('taskUpdate', handleUpdate);

  db.video2AiTasks.get(taskId).then(task => {
    if (task) {
      sendEvent('update', task);
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'error') {
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
app.post('/api/video2/ai/parse-script', upload.array('file', 1), async (req, res) => {
  try {
    const { projectId, sceneId, mode, generateImages } = req.body;
    const file = req.files && req.files[0];
    
    let scriptContent = '';
    
    if (file) {
      // 读取上传的文件
      scriptContent = fs.readFileSync(file.path, 'utf-8');
      try { fs.unlinkSync(file.path); } catch (e) {}
    } else if (req.body.text) {
      scriptContent = req.body.text;
    } else {
      return res.status(400).json({ success: false, message: '请上传脚本文件或粘贴文本内容' });
    }
    
    // 创建 AI 任务
    const task = await db.video2AiTasks.create({
      id: crypto.randomUUID(),
      type: 'script_parse',
      status: 'processing',
      projectId: projectId ? parseInt(projectId) : null,
      input: { mode, generateImages: generateImages === 'true', textLength: scriptContent.length }
    });
    
    // 异步处理（后台执行）
    processScriptParse(task.id, scriptContent, mode, generateImages === 'true', {
      projectId: projectId ? parseInt(projectId) : null,
      sceneId: sceneId !== undefined && sceneId !== null ? parseInt(sceneId) : null
    });
    
    res.json({ success: true, taskId: task.id });
  } catch (error) {
    console.error('[video2] AI 脚本解析失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 生成参考图
app.post('/api/video2/ai/generate-image', async (req, res) => {
  try {
    const { shotId, prompt, sceneImageUrl, size } = req.body;
    
    if (!shotId) {
      return res.status(400).json({ success: false, message: '缺少 shotId' });
    }
    
    const shot = await db.video2Items.getById(parseInt(shotId));
    if (!shot) {
      return res.status(404).json({ success: false, message: '分镜不存在' });
    }
    
    // 检查 shot_media 数量
    const existingMedia = await db.video2ShotMedia.getByShotId(parseInt(shotId));
    if (existingMedia.length >= 10) {
      return res.status(400).json({ success: false, message: '参考画面已达上限（10个）' });
    }
    
    // 创建 AI 任务
    const task = await db.video2AiTasks.create({
      id: crypto.randomUUID(),
      type: 'image_gen',
      status: 'processing',
      projectId: shot.projectId,
      input: { shotId: parseInt(shotId), prompt: prompt || shot.aiImagePrompt || shot.sceneContent, sceneImageUrl, size }
    });
    
    // 异步处理
    processImageGen(task.id, shot, prompt, sceneImageUrl, size);
    
    res.json({ success: true, taskId: task.id });
  } catch (error) {
    console.error('[video2] AI 生图失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// AI 视频分割
app.post('/api/video2/ai/split-video', async (req, res) => {
  try {
    const { videoUrl, projectId, sceneId, mode, splitPoints } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({ success: false, message: '缺少 videoUrl' });
    }
    
    // 创建 AI 任务
    const task = await db.video2AiTasks.create({
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
      splitPoints: splitPoints || []
    });
    
    res.json({ success: true, taskId: task.id });
  } catch (error) {
    console.error('[video2] AI 视频分割失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

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
      const scene = await db.video2Scenes.create(projectId, name);
      const key = name.toLowerCase();
      sceneMap.set(key, scene.id);
    } catch (err) {
      console.error('[autoAssignScenes] 创建场次失败:', name, err.message);
    }
  }

  return sceneMap;
}

async function processScriptParse(taskId, scriptContent, mode, generateImages, params) {
  try {
    const settings = await db.video2Settings.getAll();
    
    const autoAssignScene = params.sceneId === undefined || params.sceneId === null;
    
    // 调用 AI 解析脚本
    const result = await aiClient.parseScript(scriptContent, mode, settings, taskId, {
      autoAssignScene
    });
    
    // 解析返回的 JSON
    let shotsData = [];
    try {
      const jsonMatch = result.content.match(/```json\s*([\s\S]*?)\s*```/) || result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);
        shotsData = Array.isArray(parsed) ? parsed : (parsed.shots || []);
      }
    } catch (e) {
      console.error('[AI] 解析脚本返回数据失败:', e.message);
      await db.video2AiTasks.update(taskId, {
        status: 'error',
        error: '解析 AI 返回数据失败，请检查脚本格式'
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
    
    // 创建分镜记录
    const createdShots = [];
    for (let i = 0; i < shotsData.length; i++) {
      const shotData = shotsData[i];
      
      let shotSceneId = params.sceneId;
      if (autoAssignScene && shotData.sceneName && shotData.sceneName.trim()) {
        const key = shotData.sceneName.trim().toLowerCase();
        if (sceneMap.has(key)) {
          shotSceneId = sceneMap.get(key);
        }
      }
      
      const shot = await db.video2Items.createShot({
        projectId: params.projectId,
        sceneId: shotSceneId,
        sceneContent: shotData.sceneContent || '',
        actors: shotData.actors || '',
        props: shotData.props || '',
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
      
      // 更新进度
      await db.video2AiTasks.update(taskId, {
        progress: Math.round(((i + 1) / shotsData.length) * 100)
      });
    }
    
    await db.video2AiTasks.update(taskId, {
      status: 'done',
      progress: 100,
      output: { shots: createdShots, total: createdShots.length, scenesCreated: sceneMap.size }
    });
    
    console.log(`[AI] 脚本解析完成: 生成了 ${createdShots.length} 个分镜，自动创建了 ${sceneMap.size} 个场次`);
  } catch (error) {
    console.error('[AI] 脚本解析失败:', error.message);
    await db.video2AiTasks.update(taskId, {
      status: 'error',
      error: error.message
    });
  }
}

async function processImageGen(taskId, shot, prompt, sceneImageUrl, size) {
  try {
    const settings = await db.video2Settings.getAll();
    
    // 如果场景参考图是自己 OSS 的私有 URL，先生成签名 URL
    let signedSceneImageUrl = sceneImageUrl;
    if (sceneImageUrl && isOSSConfigured && ossClient && sceneImageUrl.includes('aliyuncs.com')) {
      try {
        const keyMatch = sceneImageUrl.match(/aliyuncs\.com\/([^?]+)/);
        if (keyMatch) {
          const ossKey = decodeURIComponent(keyMatch[1]);
          signedSceneImageUrl = ossClient.signatureUrl(ossKey, { expires: 3600 });
          console.log(`[AI] 场景参考图已生成签名 URL: ${ossKey}`);
        }
      } catch (e) {
        console.warn('[AI] 场景参考图签名失败，使用原始 URL:', e.message);
      }
    }
    
    // 调用 AI 生图
    const finalPrompt = prompt || shot.aiImagePrompt || shot.sceneContent;
    const result = await aiClient.callImageWithFallback(finalPrompt, settings.image_fallback_chain || [], settings, {
      sceneImageUrl: signedSceneImageUrl,
      size: size || settings.default_image_size || '1024x576',
      taskId
    });
    
    // 上传到 OSS
    let imageUrl = result.url;
    if (isOSSConfigured && ossClient && imageUrl) {
      try {
        const response = await fetch(imageUrl);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const ext = 'png';
          const fileName = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 8)}.${ext}`;
          const folder = shot.projectId ? `${shot.projectId}/images` : 'default/images';
          const ossKey = `${folder}/${fileName}`;
          const ossResult = await ossClient.put(ossKey, Buffer.from(buffer));
          imageUrl = ossResult.url;
          console.log(`[AI] 参考图已上传到 OSS: ${ossKey}`);
        }
      } catch (e) {
        console.warn('[AI] 参考图 OSS 上传失败，使用原始 URL:', e.message);
      }
    }
    
    // 保存到 shot_media
    const media = await db.video2ShotMedia.create({
      shotId: shot.id,
      url: imageUrl,
      type: 'image',
      filename: '',
      size: 0,
      sortOrder: 0,
      source: 'ai_generated'
    });
    
    await db.video2AiTasks.update(taskId, {
      status: 'done',
      progress: 100,
      output: { media }
    });
    
    console.log(`[AI] 参考图生成完成: ${imageUrl}`);
  } catch (error) {
    console.error('[AI] 参考图生成失败:', error.message);
    await db.video2AiTasks.update(taskId, {
      status: 'error',
      error: error.message
    });
  }
}

async function processVideoSplit(taskId, videoUrl, params) {
  try {
    const mode = params.mode || 'ai_frame';
    
    if (mode === 'manual') {
      await processVideoSplitManual(taskId, videoUrl, params);
    } else if (mode === 'aliyun') {
      await processVideoSplitAliyunMode(taskId, videoUrl, params);
    } else {
      await processVideoSplitAIFrameMode(taskId, videoUrl, params);
    }
  } catch (error) {
    console.error('[AI] 视频分割失败:', error.message);
    await db.video2AiTasks.update(taskId, {
      status: 'error',
      error: error.message
    });
  }
}

async function processVideoSplitAliyunMode(taskId, videoUrl, params) {
  const settings = await db.video2Settings.getAll();
  await processVideoSplitAliyun(taskId, videoUrl, params, settings);
}

async function processVideoSplitAIFrameMode(taskId, videoUrl, params) {
  const settings = await db.video2Settings.getAll();
  await processVideoSplitAIFrame(taskId, videoUrl, params, settings);
}

async function processVideoSplitManual(taskId, videoUrl, params) {
  // 手动模式直接按分割点创建分镜（不实际切割视频，只是记录分割点）
  const { splitPoints } = params;
  
  if (!splitPoints || splitPoints.length === 0) {
    await db.video2AiTasks.update(taskId, {
      status: 'error',
      error: '没有提供分割点'
    });
    return;
  }
  
  const autoAssignScene = params.sceneId === undefined || params.sceneId === null;
  let sceneMap = new Map();
  
  if (autoAssignScene && splitPoints.length > 0) {
    sceneMap = await autoAssignScenesByNames(params.projectId, ['视频分割'], null);
  }
  
  const defaultSceneId = sceneMap.size > 0 ? sceneMap.values().next().value : params.sceneId;
  
  // 创建分镜记录（每个分割点作为一个分镜）
  const createdShots = [];
  const sortedPoints = [...splitPoints].sort((a, b) => a - b);
  
  for (let i = 0; i < sortedPoints.length; i++) {
    const startTime = sortedPoints[i];
    const endTime = sortedPoints[i + 1] || null;
    
    const shot = await db.video2Items.createShot({
      projectId: params.projectId,
      sceneId: defaultSceneId,
      sceneContent: `镜头 ${i + 1}`,
      notes: endTime ? `时间范围: ${startTime}s - ${endTime}s` : `起始时间: ${startTime}s`,
      status: 'pending'
    });
    
    // 保存视频 URL 到 shot_media
    const media = await db.video2ShotMedia.create({
      shotId: shot.id,
      url: videoUrl,
      type: 'video',
      filename: '',
      size: 0,
      duration: endTime ? endTime - startTime : null,
      sortOrder: 0,
      source: 'video_split'
    });
    
    createdShots.push({ ...shot, media: [media] });
    
    await db.video2AiTasks.update(taskId, {
      progress: Math.round(((i + 1) / sortedPoints.length) * 100)
    });
  }
  
  await db.video2AiTasks.update(taskId, {
    status: 'done',
    progress: 100,
    output: { shots: createdShots, total: createdShots.length, scenesCreated: sceneMap.size }
  });
  
  console.log(`[AI] 手动视频分割完成: 生成了 ${createdShots.length} 个分镜，自动创建了 ${sceneMap.size} 个场次`);
}

async function processVideoSplitAliyun(taskId, videoUrl, params, settings) {
  
  if (!aliyunVideo.isAliyunConfigured()) {
    throw new Error('阿里云 AccessKey 未配置，请在设置中配置');
  }
  
  await db.video2AiTasks.update(taskId, {
    progress: 10,
    output: { stage: 'submitting_to_aliyun', provider: 'aliyun' }
  });
  
  // 提交任务
  const { jobId } = await aliyunVideo.submitSplitVideoTask(videoUrl, {
    MinTime: params.minTime || 2,
    MaxTime: params.maxTime || 30
  });
  
  await db.video2AiTasks.update(taskId, {
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
      
      await db.video2AiTasks.update(taskId, {
        progress: progress,
        output: { stage: `aliyun_${result.status.toLowerCase()}` }
      });
    }
    
    if (result.status === 'PROCESS_SUCCESS') {
      const parsed = aliyunVideo.parseSplitResult(result.result);
      await createShotsFromSplitPoints(taskId, videoUrl, parsed.shots, params, parsed.themeSegments);
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
    await db.video2AiTasks.update(taskId, {
      progress: 5,
      output: { stage: 'downloading_video' }
    });
    
    // 1. 下载视频到本地临时文件
    const tempVideoPath = path.join(__dirname, `temp_split_${taskId}.mp4`);
    let videoBuffer;
    try {
      const response = await fetch(videoUrl);
      if (!response.ok) throw new Error(`下载视频失败: HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      videoBuffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(tempVideoPath, videoBuffer);
    } catch (e) {
      throw new Error(`视频下载失败: ${e.message}`);
    }
    
    await db.video2AiTasks.update(taskId, {
      progress: 15,
      output: { stage: 'extracting_frames' }
    });
    
    // 2. 获取视频时长和分辨率
    const metadata = await getVideoMetadata(tempVideoPath);
    const duration = metadata?.format?.duration || 0;
    const videoStream = metadata?.streams?.find(s => s.codec_type === 'video');
    const width = videoStream?.width || 1280;
    const height = videoStream?.height || 720;
    
    if (!duration || duration < 1) {
      throw new Error('无法获取视频时长');
    }
    
    // 3. 计算抽帧间隔（每 3 秒一帧，最多 60 帧）
    let frameInterval = 3;
    const maxFrames = 60;
    if (duration / frameInterval > maxFrames) {
      frameInterval = Math.ceil(duration / maxFrames);
    }
    
    // 4. 使用 ffmpeg 抽取关键帧
    const framesDir = path.join(__dirname, `temp_frames_${taskId}`);
    if (!fs.existsSync(framesDir)) {
      fs.mkdirSync(framesDir, { recursive: true });
    }
    
    try {
      await extractFrames(tempVideoPath, framesDir, frameInterval);
    } catch (e) {
      throw new Error(`抽帧失败: ${e.message}`);
    }
    
    // 5. 读取抽帧文件列表
    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg') || f.endsWith('.png'))
      .sort()
      .slice(0, maxFrames);
    
    if (frameFiles.length === 0) {
      throw new Error('未提取到任何帧');
    }
    
    await db.video2AiTasks.update(taskId, {
      progress: 40,
      output: { stage: 'analyzing_with_ai', framesCount: frameFiles.length }
    });
    
    // 6. 将帧转成 base64，分批发给多模态模型分析
    const framesWithTime = [];
    for (let i = 0; i < frameFiles.length; i++) {
      const framePath = path.join(framesDir, frameFiles[i]);
      const frameBuffer = fs.readFileSync(framePath);
      const compressedBuffer = await compressImage(frameBuffer, 100);
      const base64 = compressedBuffer.toString('base64');
      const timeSeconds = i * frameInterval;
      framesWithTime.push({ index: i, time: timeSeconds, base64, fileName: frameFiles[i] });
    }
    
    // 7. 调用多模态模型分析
    const splitPoints = await analyzeVideoShots(framesWithTime, duration, settings, taskId);
    
    await db.video2AiTasks.update(taskId, {
      progress: 80,
      output: { stage: 'creating_shots', splitPointsCount: splitPoints.length }
    });
    
    // 8. 按分割点创建分镜
    const sortedPoints = [...splitPoints].sort((a, b) => a - b);
    const allPoints = [0, ...sortedPoints];
    
    const shots = allPoints.map((startTime, i) => ({
      beginTime: startTime,
      endTime: allPoints[i + 1] || duration,
      type: 'shot',
      theme: ''
    }));
    
    await createShotsFromSplitData(taskId, videoUrl, shots, params, videoBuffer ? videoBuffer.length : 0);
    
    // 清理临时文件
    cleanupTempFiles(tempVideoPath, framesDir);
    
    console.log(`[AI] 视频分割完成: 生成了 ${shots.length} 个分镜`);
  } catch (error) {
    const tempVideoPath = path.join(__dirname, `temp_split_${taskId}.mp4`);
    const framesDir = path.join(__dirname, `temp_frames_${taskId}`);
    cleanupTempFiles(tempVideoPath, framesDir);
    throw error;
  }
}

async function createShotsFromSplitPoints(taskId, videoUrl, shots, params, themeSegments) {
  await db.video2AiTasks.update(taskId, {
    progress: 85,
    output: { stage: 'creating_shots', shotsCount: shots.length }
  });

  const autoAssignScene = params.sceneId === undefined || params.sceneId === null;
  let defaultSceneId = params.sceneId;

  // 如果启用自动分配场次，创建单一默认场次 "视频分割"
  if (autoAssignScene && shots.length > 0) {
    const sceneMap = await autoAssignScenesByNames(params.projectId, ['视频分割'], null);
    defaultSceneId = sceneMap.values().next().value;
  }

  /**
   * 根据时间范围查找所属的主题片段
   */
  function findThemeForTime(startTime, endTime, themeSegments) {
    if (!themeSegments || themeSegments.length === 0) {
      return null;
    }
    for (const seg of themeSegments) {
      if (startTime >= seg.beginTime && endTime <= seg.endTime) {
        return seg;
      }
    }
    return null;
  }

  const createdShots = [];

  // 按 beginTime 升序排列，确保分镜顺序与原始视频一致
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

      // 如果有对应的主题片段，追加到备注供用户参考
      if (themeSegments && themeSegments.length > 0) {
        const theme = findThemeForTime(startTime, endTime, themeSegments);
        if (theme) {
          notes += `\n所属主题: ${theme.theme || `主题 ${theme.index}`}`;
        }
      }
    }

    const shot = await db.video2Items.createShot({
      projectId: params.projectId,
      sceneId: defaultSceneId,
      sceneContent: sceneContent,
      notes: notes,
      estimatedDuration: Math.round(duration).toString(),
      status: 'pending'
    });

    const media = await db.video2ShotMedia.create({
      shotId: shot.id,
      url: videoUrl,
      type: 'video',
      filename: '',
      size: 0,
      duration: duration,
      sortOrder: 0,
      source: 'video_split_aliyun'
    });

    createdShots.push({ ...shot, media: [media] });

    await db.video2AiTasks.update(taskId, {
      progress: 85 + Math.round(((i + 1) / sortedShots.length) * 15)
    });
  }

  await db.video2AiTasks.update(taskId, {
    status: 'done',
    progress: 100,
    output: {
      shots: createdShots,
      total: createdShots.length,
      provider: 'aliyun',
      scenesCreated: autoAssignScene ? 1 : 0
    }
  });
}

async function createShotsFromSplitData(taskId, videoUrl, shots, params, videoSize) {
  const autoAssignScene = params.sceneId === undefined || params.sceneId === null;
  let sceneMap = new Map();
  
  if (autoAssignScene && shots.length > 0) {
    sceneMap = await autoAssignScenesByNames(params.projectId, ['视频分割'], null);
  }
  
  const defaultSceneId = sceneMap.size > 0 ? sceneMap.values().next().value : params.sceneId;
  
  const createdShots = [];
  
  for (let i = 0; i < shots.length; i++) {
    const shotInfo = shots[i];
    const startTime = shotInfo.beginTime || 0;
    const endTime = shotInfo.endTime || 0;
    const duration = endTime - startTime;
    
    const shot = await db.video2Items.createShot({
      projectId: params.projectId,
      sceneId: defaultSceneId,
      sceneContent: `镜头 ${i + 1}（AI 自动分割）`,
      notes: `时间范围: ${formatTime(startTime)} - ${formatTime(endTime)}`,
      estimatedDuration: Math.round(duration).toString(),
      status: 'pending'
    });
    
    const media = await db.video2ShotMedia.create({
      shotId: shot.id,
      url: videoUrl,
      type: 'video',
      filename: '',
      size: videoSize || 0,
      duration: duration,
      sortOrder: 0,
      source: 'video_split_ai'
    });
    
    createdShots.push({ ...shot, media: [media] });
    
    await db.video2AiTasks.update(taskId, {
      progress: 80 + Math.round(((i + 1) / shots.length) * 20)
    });
  }
  
  await db.video2AiTasks.update(taskId, {
    status: 'done',
    progress: 100,
    output: {
      shots: createdShots,
      total: createdShots.length,
      provider: 'ai_frame',
      scenesCreated: sceneMap.size
    }
  });
}

// ========== 视频分割辅助函数 ==========

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

async function analyzeVideoShots(framesWithTime, totalDuration, settings, taskId) {
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
    text: `请分析以下视频截图序列，找出镜头切换（场景转换）的时间点。

视频总时长：${totalDuration.toFixed(1)} 秒
截图间隔：约 ${actualInterval} 秒
共 ${frames.length} 张截图

请找出明显的镜头切换点，要求：
1. 只返回时间点（秒数），精确到整数
2. 只返回明显的场景/镜头转换，忽略轻微的镜头移动
3. 如果不确定某帧是否是切换点，就不要返回
4. 返回格式：JSON 数组，例如 [3, 8, 15, 22]

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
    text: `请返回镜头切换的时间点（秒数）数组，JSON 格式，不要任何额外说明。`
  });
  
  const messages = [
    {
      role: 'user',
      content
    }
  ];
  
  // 使用多模态模型降级链
  const multimodalChain = [
    { model: 'gemini-3.5-flash', provider: 'geekai', cost: 'mid_high' },
    { model: 'gemini-3.1-flash-image', provider: 'geekai', cost: 'mid' },
    { model: 'qwen3.7-plus', provider: 'geekai', cost: 'low' },
    { model: 'qwen3.7-max', provider: 'geekai', cost: 'mid' },
  ];
  
  try {
    const result = await aiClient.callChatWithFallback(messages, multimodalChain, settings, {
      temperature: 0.2,
      max_tokens: 2000,
      json: true,
      taskId
    });
    
    // 解析返回的 JSON
    let splitPoints = [];
    try {
      const jsonMatch = result.content.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        splitPoints = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn('[AI] 解析分割点 JSON 失败:', e.message);
    }
    
    // 过滤和验证
    const validPoints = splitPoints
      .map(t => Math.round(Number(t)))
      .filter(t => !isNaN(t) && t > 0 && t < totalDuration);
    
    // 去重并排序
    return [...new Set(validPoints)].sort((a, b) => a - b);
  } catch (error) {
    console.error('[AI] 视频分析失败:', error.message);
    // 如果所有模型都失败了，返回一个粗略的分割（每 15 秒一个）
    const fallbackPoints = [];
    for (let t = 15; t < totalDuration; t += 15) {
      fallbackPoints.push(Math.round(t));
    }
    return fallbackPoints;
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

app.get('/api/video2/aliyun/status', (req, res) => {
  res.json({
    success: true,
    configured: aliyunVideo.isAliyunConfigured()
  });
});

// ========== MPS 视频转码 API ==========

// 提交转码任务
app.post('/api/video2/aliyun/transcode', async (req, res) => {
  try {
    const { videoUrl, targetBitrate, width, height, pipelineId, projectId } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: '缺少 videoUrl 参数' });
    }

    if (!aliyunVideo.isAliyunConfigured()) {
      return res.status(400).json({ success: false, message: '阿里云 AccessKey 未配置' });
    }

    // 生成任务 ID
    const taskId = `transcode-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;

    // 初始化任务状态（持久化到数据库）
    const options = { targetBitrate, width, height, pipelineId, projectId };
    await db.video2TranscodeTasks.create({
      id: taskId,
      status: 'pending',
      progress: 0,
      videoUrl,
      options
    });

    // 提交转码任务到阿里云
    const result = await aliyunVideo.submitTranscodeTask(videoUrl, {
      targetBitrate,
      width,
      height,
      pipelineId
    });

    // 更新任务状态
    await db.video2TranscodeTasks.update(taskId, {
      jobId: result.jobId,
      requestId: result.requestId,
      outputObject: result.outputObject
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

// 查询转码任务状态
app.get('/api/video2/aliyun/transcode/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    let task = await db.video2TranscodeTasks.get(taskId);

    if (!task) {
      return res.status(404).json({ success: false, message: '任务不存在' });
    }

    // 如果任务还在处理中,查询阿里云状态
    if (task.status === 'pending' || task.status === 'processing') {
      try {
        const result = await aliyunVideo.getTranscodeResult(task.jobId);

        const updates = {
          status: result.status,
          progress: result.progress
        };

        if (result.status === 'done' && result.outputUrl) {
          // 转码完成,下载输出视频并上传到项目 OSS
          console.log(`[MPS] 转码完成: ${taskId}, 输出 URL: ${result.outputUrl}`);

          try {
            // 下载转码后的视频
            const response = await fetch(result.outputUrl);
            if (!response.ok) {
              throw new Error(`下载转码视频失败: HTTP ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // 上传到项目 OSS
            const ossConfig = aliyunVideo.getOSSConfig();
            const ext = 'mp4';
            const fileName = `transcode-${Date.now()}-${Math.random().toString(36).substr(2, 8)}.${ext}`;
            const folder = task.options && task.options.projectId ? `projects/${task.options.projectId}/videos` : 'projects/default/videos';
            const ossKey = `${folder}/${fileName}`;

            if (isOSSConfigured && ossClient) {
              const ossResult = await ossClient.put(ossKey, buffer);
              updates.outputUrl = ossResult.url;
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

        await db.video2TranscodeTasks.update(taskId, updates);
        task = await db.video2TranscodeTasks.get(taskId);
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
      error: task.error
    });
  } catch (error) {
    console.error('[MPS] 查询转码任务失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/video2/stats', async (req, res) => {
  try {
    const { projectId, sceneId } = req.query;
    const filter = {};
    if (projectId !== undefined) {
      filter.projectId = parseInt(projectId);
    }
    if (sceneId !== undefined) {
      filter.sceneId = sceneId === 'null' ? null : parseInt(sceneId);
    }
    const stats = await db.video2Items.getStats(filter);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[video2] 获取统计失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/video2/scene-stats', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success: false, message: '缺少 projectId' });
    const stats = await db.video2Items.getSceneStats(parseInt(projectId));
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[video2] 获取场次统计失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== 项目备份/恢复端点 ==========

app.get('/api/video2/projects/:id/backup', async (req, res) => {
  try {
    const { id } = req.params;
    const projectId = parseInt(id);

    const data = await db.video2Items.exportProject(projectId);
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

app.post('/api/video2/projects/import', async (req, res) => {
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
    const result = await db.video2Items.importProject(parsedData, targetId, mode);

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

app.get('/api/video2/projects/:id/export', async (req, res) => {
  try {
    const { id } = req.params;
    const { format = 'docx', includeImages = 'true' } = req.query;
    
    const project = await db.video2Projects.getById(parseInt(id));
    if (!project) {
      return res.status(404).json({ success: false, message: '项目不存在' });
    }
    
    // 获取项目下的所有分镜
    const shots = await db.video2Items.getByFilter({
      projectId: parseInt(id),
      deleted: 0
    });
    
    // 获取项目下的所有场次（用于名称映射）
    const scenes = await db.video2Scenes.getByProjectId(parseInt(id));
    const sceneNameMap = {};
    scenes.forEach(scene => {
      sceneNameMap[scene.id] = scene.name;
    });
    
    // 为每个分镜关联 media
    const shotsWithMedia = await Promise.all(shots.map(async (shot) => {
      const media = await db.video2ShotMedia.getByShotId(shot.id);
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
            index: shot.shotIndex || (i + 1),
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
            bottom: { style: 'thin', color: { argx: 'FFE5E7EB' } }
          };
        }
      });

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(project.name)}_分镜脚本.xlsx"`);
      res.send(Buffer.from(buffer));
      console.log(`[video2] 导出 Excel 成功，共 ${shots.length} 个分镜`);
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

        for (const shot of sceneShots) {
          doc.fontSize(13).fillColor('#111').text(`分镜 #${shot.shotIndex || ''} ${shot.sceneContent || shot.title || ''}`);
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
      console.log(`[video2] 导出 PDF 成功，共 ${shots.length} 个分镜`);
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
      for (const shot of sceneShots) {
        children.push(new Paragraph({
          text: `分镜 #${shot.shotIndex || ''} ${shot.sceneContent || shot.title || ''}`,
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
    
    console.log(`[video2] 导出项目 ${id} 成功，共 ${shots.length} 个分镜`);
  } catch (error) {
    console.error('[video2] 导出失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/video2/add', async (req, res) => {
  warnDeprecated('POST /api/video2/add', 'POST /api/video2/shots');
  try {
    const { title, filename, url, size, duration, projectId, sceneId, type, coverUrl, reference } = req.body;
    if (!title || !filename || !url) {
      return res.status(400).json({ success: false, message: '缺少必要参数: title, filename, url' });
    }
    const item = await db.video2Items.create({
      title, filename, url, size, duration,
      status: 'pending',
      projectId: projectId !== undefined ? parseInt(projectId) : null,
      sceneId: sceneId !== undefined ? parseInt(sceneId) : null,
      type: type || 'video',
      coverUrl: coverUrl || null,
      reference: reference ? 1 : 0
    });
    console.log(`[video2] 新增${type === 'image' ? '图片' : '视频'}: ${title}`);
    res.json({ success: true, data: item });

    if ((!type || type === 'video') && url && (url.includes('aliyuncs.com') || url.includes('qiziwenhua.top'))) {
      const posterUrl = url + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
      setTimeout(() => {
        fetch(posterUrl, { method: 'GET', signal: AbortSignal.timeout(15000) })
          .then((r) => {
            if (r.ok) console.log(`[video2] 截图预热成功: ${title}`);
            else console.log(`[video2] 截图预热 HTTP ${r.status}: ${title}`);
          })
          .catch((e) => console.log(`[video2] 截图预热忽略: ${e.message}`));
      }, 500);
    }
  } catch (error) {
    console.error('[video2] 新增失败:', error.message);
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
    const ok = await db.video2Items.updateStatus(id, status);
    if (!ok) return res.status(404).json({ success: false, message: '分镜不存在' });
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新状态失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.put('/api/video2/shots/:id/status', updateShotStatus);
app.put('/api/video2/:id/status', (req, res) => {
  warnDeprecated('PUT /api/video2/:id/status', 'PUT /api/video2/shots/:id/status');
  updateShotStatus(req, res);
});

app.put('/api/video2/:id/shotNo', async (req, res) => {
  warnDeprecated('PUT /api/video2/:id/shotNo', 'PUT /api/video2/shots/:id');
  try {
    const id = parseInt(req.params.id);
    const { shotNo } = req.body;
    const ok = await db.video2Items.updateShotNo(id, shotNo);
    if (!ok) return res.status(404).json({ success: false, message: '视频不存在' });
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新镜头号失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

async function softDeleteShot(req, res) {
  try {
    const id = parseInt(req.params.id);
    const ok = await db.video2Items.softDelete(id);
    if (!ok) return res.status(404).json({ success: false, message: '分镜不存在' });
    console.log(`[video2] 分镜 ID ${id} 已移入垃圾桶`);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 软删除失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.delete('/api/video2/shots/:id', softDeleteShot);
app.delete('/api/video2/:id', (req, res) => {
  warnDeprecated('DELETE /api/video2/:id', 'DELETE /api/video2/shots/:id');
  softDeleteShot(req, res);
});

async function hardDeleteShot(req, res) {
  try {
    const id = parseInt(req.params.id);
    const item = await db.video2Items.getById(id);
    if (!item) return res.status(404).json({ success: false, message: '分镜不存在' });
    await db.video2Items.hardDelete(id);
    await deleteOssFile(item.url);
    console.log(`[video2] 分镜 ID ${id} 已彻底删除`);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 彻底删除失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.delete('/api/video2/shots/:id/hard', hardDeleteShot);
app.delete('/api/video2/videos/:id/hard', (req, res) => {
  warnDeprecated('DELETE /api/video2/videos/:id/hard', 'DELETE /api/video2/shots/:id/hard');
  hardDeleteShot(req, res);
});

async function restoreShot(req, res) {
  try {
    const id = parseInt(req.params.id);
    const ok = await db.video2Items.restore(id);
    if (!ok) return res.status(404).json({ success: false, message: '分镜不存在' });
    console.log(`[video2] 分镜 ID ${id} 已从垃圾桶恢复`);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 恢复失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.post('/api/video2/shots/:id/restore', restoreShot);
app.post('/api/video2/videos/:id/restore', (req, res) => {
  warnDeprecated('POST /api/video2/videos/:id/restore', 'POST /api/video2/shots/:id/restore');
  restoreShot(req, res);
});

app.put('/api/video2/videos/:id/title', async (req, res) => {
  warnDeprecated('PUT /api/video2/videos/:id/title', 'PUT /api/video2/shots/:id');
  try {
    const id = parseInt(req.params.id);
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: '标题不能为空' });
    }
    const ok = await db.video2Items.updateTitle(id, title.trim());
    if (!ok) return res.status(404).json({ success: false, message: '视频不存在' });
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 修改标题失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

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
      await db.video2Items.updateSort(normalized);
      return res.json({ success: true, changes: normalized.length });
    }
    if (!finalIds || finalIds.length === 0) {
      return res.status(400).json({ success: false, message: 'ids 应为非空数组' });
    }
    const numIds = finalIds.map(Number);
    if (finalAction === 'softDelete') {
      changes = await db.video2Items.batchSoftDelete(numIds);
    } else if (finalAction === 'restore') {
      changes = await db.video2Items.batchRestore(numIds);
    } else if (finalAction === 'hardDelete') {
      const urls = await db.video2Items.batchHardDelete(numIds);
      await deleteOssFiles(urls);
      changes = numIds.length;
    } else if (finalAction === 'changeScene') {
      changes = await db.video2Items.batchChangeScene(numIds, sceneId !== undefined && sceneId !== null ? parseInt(sceneId) : null);
    } else {
      return res.status(400).json({ success: false, message: '不支持的操作: ' + finalAction });
    }
    res.json({ success: true, changes });
  } catch (error) {
    console.error('[video2] 批量操作失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
}
app.put('/api/video2/shots/batch-update', batchUpdateShots);
app.put('/api/video2/videos/batch-update', (req, res) => {
  warnDeprecated('PUT /api/video2/videos/batch-update', 'PUT /api/video2/shots/batch-update');
  batchUpdateShots(req, res);
});

app.put('/api/video2/sort', async (req, res) => {
  warnDeprecated('PUT /api/video2/sort', 'PUT /api/video2/shots/batch-update');
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ success: false, message: '参数 orders 应为非空数组' });
    }
    const normalized = orders
      .filter(function(item) { return item && typeof item.id === 'number' && typeof item.sortOrder === 'number'; })
      .map(function(item) { return { id: item.id, sortOrder: item.sortOrder }; });
    if (normalized.length === 0) {
      return res.status(400).json({ success: false, message: '参数 orders 无效' });
    }
    await db.video2Items.updateSort(normalized);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新排序失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Projects API ====================

app.get('/api/video2/projects', async (req, res) => {
  try {
    const projects = await db.video2Projects.getAll();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, data: projects.map(p => ({
      ...p,
      shareUrl: `${origin}/share/project/${p.id}`
    })) });
  } catch (error) {
    console.error('[video2] 获取项目列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/video2/projects', async (req, res) => {
  try {
    const { name, description, coverUrl } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '项目名称不能为空' });
    }
    const project = await db.video2Projects.create({ name: name.trim(), description: description || '', coverUrl });
    console.log(`[video2] 新建项目: ${name}`);
    res.json({ success: true, data: project });
  } catch (error) {
    console.error('[video2] 新建项目失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/video2/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const project = await db.video2Projects.getById(id);
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
    console.error('[video2] 获取项目详情失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, coverUrl } = req.body;
    const existing = await db.video2Projects.getById(id);
    if (!existing) return res.status(404).json({ success: false, message: '项目不存在' });
    await db.video2Projects.update(id, {
      name: name !== undefined ? name.trim() : undefined,
      description: description !== undefined ? description : undefined,
      coverUrl: coverUrl !== undefined ? coverUrl : undefined
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新项目失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/projects/sort', async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders)) return res.status(400).json({ success: false, message: 'orders 应为数组' });
    await db.video2Projects.updateSort(orders.filter(o => o && typeof o.id === 'number' && typeof o.sortOrder === 'number'));
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新项目排序失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/video2/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await db.video2Projects.getById(id);
    if (!existing) return res.status(404).json({ success: false, message: '项目不存在' });
    const videos = await db.video2Items.getByFilter({ projectId: id });
    const urls = videos.map(v => v.url);
    await db.video2Projects.delete(id);
    await deleteOssFiles(urls);
    console.log(`[video2] 项目 ID ${id} 已删除，含 ${urls.length} 个视频`);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 删除项目失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Scenes API ====================

app.get('/api/video2/projects/:projectId/scenes', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const project = await db.video2Projects.getById(projectId);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const scenes = await db.video2Scenes.getByProjectId(projectId);
    res.json({ success: true, data: scenes });
  } catch (error) {
    console.error('[video2] 获取场次列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/video2/projects/:projectId/scenes', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '场次名称不能为空' });
    }
    const project = await db.video2Projects.getById(projectId);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    const scene = await db.video2Scenes.create({ projectId, name: name.trim() });
    console.log(`[video2] 新建场次: ${name}`);
    res.json({ success: true, data: scene });
  } catch (error) {
    console.error('[video2] 新建场次失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/scenes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, scrollPosition } = req.body;
    await db.video2Scenes.update(id, {
      name: name !== undefined ? name.trim() : undefined,
      scrollPosition: scrollPosition !== undefined ? parseInt(scrollPosition) : undefined
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新场次失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/scenes/sort', async (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders)) return res.status(400).json({ success: false, message: 'orders 应为数组' });
    await db.video2Scenes.updateSort(orders.filter(o => o && typeof o.id === 'number' && typeof o.sortOrder === 'number'));
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新场次排序失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/video2/scenes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.video2Scenes.delete(id);
    console.log(`[video2] 场次 ID ${id} 已删除，视频归到未分类`);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 删除场次失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== video2 上传与封面 API ====================

app.post('/api/video2/upload/image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    if (!validateFileSize(req.file.size, 'image')) {
      return res.status(400).json({ error: `图片不能超过 ${FILE_SIZE_LIMITS.image / (1024*1024)}MB` });
    }
    const { projectId, sceneId, reference, createShot } = req.body || {};
    const title = req.body && req.body.title ? req.body.title : req.file.originalname;
    const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 8)}-${req.file.originalname}`;
    const filePath = req.file.path;
    const originalSizeKB = (req.file.size / 1024).toFixed(2);
    let compressed = false;
    let fileBuffer = fs.readFileSync(filePath);
    if (req.file.size > 300 * 1024) {
      try {
        fileBuffer = await compressImage(fileBuffer, 300);
        compressed = true;
      } catch (e) {
        console.warn('[video2] 图片压缩失败，使用原图:', e.message);
      }
    }
    let fileUrl = '';
    let ossKey = '';
    const forceLocalStorage = req.query.forceLocal === 'true';
    if (isOSSConfigured && !forceLocalStorage && ossClient) {
      try {
        // OSS 路径按项目ID分文件夹，未指定项目时使用 default/projects/images
        const folder = projectId ? `projects/${projectId}/images` : 'projects/default/images';
        ossKey = `${folder}/${fileName}`;
        const result = await ossClient.put(ossKey, fileBuffer);
        fileUrl = result.url;
        try { fs.unlinkSync(filePath); } catch (e) {}
        console.log(`[video2] 图片 OSS 上传成功 (${folder}): ${fileName}, url: ${fileUrl}`);
      } catch (ossError) {
        console.warn('[video2] OSS 上传失败:', ossError.message);
        try { fs.unlinkSync(filePath); } catch (e) {}
        return res.status(500).json({ error: 'OSS 上传失败', ossError: true });
      }
    } else {
      if (compressed) fs.writeFileSync(filePath, fileBuffer);
      fileUrl = `/uploads/${fileName}`;
      console.log(`[video2] 图片本地上传: ${fileName}`);
    }
    let item;
    if (createShot && projectId) {
      const shot = await db.video2Items.createShot({
        projectId: parseInt(projectId),
        sceneId: sceneId ? parseInt(sceneId) : null,
        sceneContent: title,
        status: 'pending',
        type: 'image',
        filename: fileName,
        url: fileUrl,
        size: req.file.size,
      });
      await db.video2ShotMedia.create({
        shotId: shot.id,
        url: fileUrl,
        type: 'image',
        filename: fileName,
        size: req.file.size,
        source: reference ? 'reference' : 'upload'
      });
      item = { id: shot.id, shotId: shot.id, url: fileUrl, filename: fileName, isShot: true };
    } else {
      item = await db.video2Items.create({
        title, filename: fileName, url: fileUrl,
        size: req.file.size,
        status: 'pending',
        projectId: projectId ? parseInt(projectId) : null,
        sceneId: sceneId ? parseInt(sceneId) : null,
        type: 'image',
        reference: reference ? 1 : 0
      });
    }
    if (projectId && !reference) {
      trySetProjectCoverIfDefault(parseInt(projectId), fileUrl, 'image').catch(() => {});
    }
    res.json({ success: true, url: fileUrl, ossKey, filename: fileName, compressed, size: originalSizeKB, id: item.id });
  } catch (error) {
    console.error('[video2] 图片上传失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// OSS 签名 URL 代理 - 用于私有 Bucket 的图片/视频访问
app.get('/api/video2/oss-proxy', async (req, res) => {
  try {
    const { url, key } = req.query;
    if (!isOSSConfigured || !ossClient) {
      console.warn('[video2][oss-proxy] OSS 未配置');
      return res.status(400).json({ error: 'OSS 未配置' });
    }
    
    let ossKey = key;
    let urlBucket = null;
    let queryParams = null;
    
    // 如果没有直接传 key，尝试从 URL 中提取
    if (!ossKey && url) {
      const urlStr = String(url);
      console.log('[video2][oss-proxy] 从 URL 提取 key:', urlStr);
      
      // 尝试匹配 aliyuncs.com 域名（同时提取 bucket 名称）
      let match = urlStr.match(/^https?:\/\/([^.]+)\.oss-[^.]+\.aliyuncs\.com\/([^?]+)(\?.*)?$/);
      if (match) {
        urlBucket = match[1];
        ossKey = decodeURIComponent(match[2]);
        queryParams = match[3] || null;
        console.log('[video2][oss-proxy] aliyuncs URL, bucket:', urlBucket, 'key:', ossKey, 'query:', queryParams);
      } else {
        // 尝试匹配自定义域名格式（如 xxx.qiziwenhua.top/key 或 qiziwenhua.top/xxx/key）
        // 去掉协议和域名，取路径部分
        try {
          const urlObj = new URL(urlStr);
          ossKey = decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
          queryParams = urlObj.search || null;
          console.log('[video2][oss-proxy] 自定义域名 URL, key:', ossKey, 'query:', queryParams);
        } catch (e) {
          // 如果不是完整 URL，尝试直接作为路径
          if (urlStr.startsWith('/')) {
            ossKey = decodeURIComponent(urlStr.slice(1));
          }
        }
      }
    }
    
    if (!ossKey) {
      console.warn('[video2][oss-proxy] 无法获取 OSS key, url:', url, 'key:', key);
      return res.status(400).json({ error: '无法获取 OSS key' });
    }
    
    // 如果 URL 中的 bucket 与当前 ossClient 的 bucket 不一致，切换 bucket
    let targetClient = ossClient;
    if (urlBucket && urlBucket !== OSS_BUCKET) {
      console.log('[video2][oss-proxy] URL bucket (' + urlBucket + ') 与配置 bucket (' + OSS_BUCKET + ') 不一致，切换 bucket');
      try {
        targetClient = new OSS({
          accessKeyId: OSS_ACCESS_KEY_ID,
          accessKeySecret: OSS_ACCESS_KEY_SECRET,
          bucket: urlBucket,
          region: OSS_REGION,
          secure: true
        });
      } catch (e) {
        console.warn('[video2][oss-proxy] 切换 bucket 失败，使用默认 bucket:', e.message);
        targetClient = ossClient;
      }
    }
    
    console.log('[video2][oss-proxy] 生成签名 URL, bucket:', targetClient.options.bucket, 'key:', ossKey);
    let signedUrl = targetClient.signatureUrl(ossKey, { expires: 3600 });
    
    // 如果原始 URL 有查询参数（如 x-oss-process），附加到签名 URL 上
    if (queryParams && queryParams.length > 1) {
      const separator = signedUrl.includes('?') ? '&' : '?';
      signedUrl = signedUrl + separator + queryParams.slice(1);
      console.log('[video2][oss-proxy] 附加查询参数后的签名 URL:', signedUrl.substring(0, 120) + '...');
    }
    
    console.log('[video2][oss-proxy] 签名 URL 生成成功，开始获取内容...');
    
    const response = await fetch(signedUrl);
    if (!response.ok) {
      console.warn('[video2][oss-proxy] OSS 响应错误:', response.status, response.statusText, 'url:', signedUrl.substring(0, 100) + '...');
      return res.status(response.status).json({ error: 'OSS 响应错误: ' + response.status });
    }
    
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    console.log('[video2][oss-proxy] 获取成功, type:', contentType, 'size:', contentLength);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    console.error('[video2][oss-proxy] 代理失败:', error.message);
    console.error('[video2][oss-proxy] error stack:', error.stack);
    res.status(500).json({ error: '代理失败: ' + error.message });
  }
});

// 签名 URL 接口：前端直连 OSS，服务器只负责生成签名
app.get('/api/video2/oss-sign-url', async (req, res) => {
  try {
    const { url, key, bucket: targetBucket } = req.query;
    if (!isOSSConfigured || !ossClient) {
      return res.status(400).json({ error: 'OSS 未配置' });
    }

    let ossKey = key;
    let urlBucket = null;

    // 从 URL 中提取 key
    if (!ossKey && url) {
      const urlStr = String(url);
      const match = urlStr.match(/^https?:\/\/([^.]+)\.oss-[^.]+\.aliyuncs\.com\/([^?]+)(\?.*)?$/);
      if (match) {
        urlBucket = match[1];
        ossKey = decodeURIComponent(match[2]);
      } else {
        try {
          const urlObj = new URL(urlStr);
          ossKey = decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
        } catch (e) {
          if (urlStr.startsWith('/')) ossKey = decodeURIComponent(urlStr.slice(1));
        }
      }
    }

    if (!ossKey) {
      return res.status(400).json({ error: '无法获取 OSS key' });
    }

    // 确定目标 bucket
    const finalBucket = targetBucket || urlBucket || OSS_BUCKET;
    let targetClient = ossClient;

    if (finalBucket && finalBucket !== OSS_BUCKET) {
      try {
        targetClient = new OSS({
          accessKeyId: OSS_ACCESS_KEY_ID,
          accessKeySecret: OSS_ACCESS_KEY_SECRET,
          bucket: finalBucket,
          region: OSS_REGION,
          secure: true
        });
      } catch (e) {
        console.warn('[oss-sign-url] 切换 bucket 失败，使用默认:', e.message);
        targetClient = ossClient;
      }
    }

    // 生成签名 URL（1小时有效期）
    const signedUrl = targetClient.signatureUrl(ossKey, { expires: 3600 });
    res.json({ signedUrl, key: ossKey, bucket: finalBucket });
  } catch (error) {
    console.error('[oss-sign-url] 生成签名失败:', error.message);
    res.status(500).json({ error: '生成签名失败: ' + error.message });
  }
});

// 批量签名 URL 接口：一次性为多个 URL 生成签名（减少前端请求）
app.get('/api/video2/oss-sign-urls', async (req, res) => {
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
      let urlBucket = null;

      const match = str.match(/^https?:\/\/([^.]+)\.oss-[^.]+\.aliyuncs\.com\/([^?]+)(\?.*)?$/);
      if (match) {
        urlBucket = match[1];
        ossKey = decodeURIComponent(match[2]);
      } else {
        try {
          const urlObj = new URL(str);
          ossKey = decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
        } catch (e) {
          if (str.startsWith('/')) ossKey = decodeURIComponent(str.slice(1));
        }
      }

      if (ossKey) {
        const finalBucket = urlBucket || OSS_BUCKET;
        let targetClient = ossClient;
        if (finalBucket !== OSS_BUCKET) {
          try {
            targetClient = new OSS({
              accessKeyId: OSS_ACCESS_KEY_ID,
              accessKeySecret: OSS_ACCESS_KEY_SECRET,
              bucket: finalBucket,
              region: OSS_REGION,
              secure: true
            });
          } catch (e) {
            targetClient = ossClient;
          }
        }
        try {
          results[str] = targetClient.signatureUrl(ossKey, { expires: 3600 });
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

// OSS 上传凭证接口：前端直传 OSS，服务器只负责生成凭证
app.get('/api/video2/oss-upload-credential', async (req, res) => {
  try {
    const { projectId, filename, type } = req.query;
    if (!isOSSConfigured || !ossClient) {
      return res.status(400).json({ error: 'OSS 未配置' });
    }
    if (!projectId || !filename || !type) {
      return res.status(400).json({ error: '缺少必要参数: projectId, filename, type' });
    }

    const subDir = type === 'video' ? 'videos' : 'images';
    const ossKey = `projects/${projectId}/${subDir}/${Date.now()}-${Math.random().toString(36).substr(2, 8)}-${filename}`;

    // 生成表单上传签名
    const policy = Buffer.from(JSON.stringify({
      expiration: new Date(Date.now() + 3600 * 1000).toISOString(),
      conditions: [['content-length-range', 0, 500 * 1024 * 1024]]
    })).toString('base64');

    const signature = crypto.createHmac('sha1', OSS_ACCESS_KEY_SECRET).update(policy).digest('base64');

    res.json({
      host: `https://${OSS_BUCKET}.oss-${OSS_REGION}.aliyuncs.com`,
      accessKeyId: OSS_ACCESS_KEY_ID,
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

app.post('/api/video2/upload/video', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    if (!validateFileSize(req.file.size, 'video')) {
      return res.status(400).json({ error: `视频不能超过 ${FILE_SIZE_LIMITS.video / (1024*1024)}MB` });
    }
    const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 8)}-${req.file.originalname}`;
    const filePath = req.file.path;
    const shouldCompress = req.query.compress === 'true';
    const forceLocalStorage = req.query.forceLocal === 'true';
    const taskId = 'v2-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);

    video2VideoTasks.set(taskId, {
      status: 'processing', progress: 0, compressProgress: 0, uploadProgress: 0,
      message: '上传中...', result: null, error: null,
      filePath, fileName, shouldCompress, forceLocalStorage,
      projectId: req.body && req.body.projectId ? parseInt(req.body.projectId) : null,
      sceneId: req.body && req.body.sceneId ? parseInt(req.body.sceneId) : null,
      reference: req.body && req.body.reference ? 1 : 0,
      createShot: req.body && req.body.createShot ? true : false,
      title: req.body && req.body.title ? req.body.title : null,
      fileSize: req.file.size,
      createdAt: Date.now()
    });
    res.json({ taskId, status: 'queued' });

    (async () => {
      try {
        const task = video2VideoTasks.get(taskId);
        if (!task) return;
        let fileUrl = '';
        let compressed = false;
        let uploadPath = filePath;
        let isTempFile = false;

        if (task.shouldCompress) {
          try {
            const bitrate = await getVideoBitrate(filePath);
            if (bitrate && bitrate > 3000) {
              task.message = '正在压缩视频...';
              video2VideoTasks.set(taskId, task);
              const compressResult = await compressVideoFile(filePath, 3000);
              if (compressResult.success && compressResult.outputPath) {
                uploadPath = compressResult.outputPath;
                isTempFile = true;
                compressed = true;
                task.compressProgress = 100;
                if (compressResult.size) {
                  task.fileSize = compressResult.size;
                }
              }
            }
          } catch (e) {
            console.warn('[video2] 视频压缩失败，使用原始文件:', e.message);
          }
        }

        task.uploadProgress = 50;
        task.message = '正在上传...';
        video2VideoTasks.set(taskId, task);

        if (isOSSConfigured && !task.forceLocalStorage && ossClient) {
          try {
            // OSS 路径按项目ID分文件夹，未指定项目时使用 default
            const folder = task.projectId ? `projects/${task.projectId}/videos` : 'projects/default/videos';
            const ossKey = `${folder}/${task.fileName}`;
            const result = await ossClient.put(ossKey, uploadPath);
            fileUrl = result.url;
            // 清理临时文件
            if (isTempFile) {
              try { fs.unlinkSync(uploadPath); } catch (e) {}
            }
            try { if (filePath !== uploadPath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
            console.log(`[video2] 视频 OSS 上传成功 (${folder}): ${task.fileName}`);
          } catch (e) {
            console.warn('[video2] OSS 上传失败:', e.message);
            throw new Error('OSS 上传失败');
          }
        } else {
          fileUrl = `/uploads/${task.fileName}`;
        }

        task.uploadProgress = 100;
        task.status = 'done';
        task.message = '上传成功';
        task.result = { url: fileUrl, compressed, fileName: task.fileName };

        let item;
        if (task.createShot && task.projectId) {
          const shot = await db.video2Items.createShot({
            projectId: task.projectId,
            sceneId: task.sceneId,
            sceneContent: task.title || task.fileName,
            status: 'pending',
            type: 'video',
            filename: task.fileName,
            url: fileUrl,
            size: task.fileSize,
          });
          await db.video2ShotMedia.create({
            shotId: shot.id,
            url: fileUrl,
            type: 'video',
            filename: task.fileName,
            size: task.fileSize,
            source: task.reference ? 'reference' : 'upload'
          });
          item = { id: shot.id, shotId: shot.id, url: fileUrl, filename: task.fileName, isShot: true };
        } else {
          item = await db.video2Items.create({
            title: task.title || task.fileName,
            filename: task.fileName,
            url: fileUrl,
            size: task.fileSize,
            status: 'pending',
            projectId: task.projectId,
            sceneId: task.sceneId,
            type: 'video',
            reference: task.reference
          });
        }
        if (task.projectId && !task.reference) {
          trySetProjectCoverIfDefault(task.projectId, fileUrl, 'video').catch(() => {});
        }
        task.result.id = item.id;
        video2VideoTasks.set(taskId, task);
        console.log(`[video2] 视频上传完成: ${task.fileName} (compressed=${compressed})`);
      } catch (err) {
        const task = video2VideoTasks.get(taskId);
        if (task) {
          task.status = 'error';
          task.error = err.message;
          task.message = '上传失败';
          video2VideoTasks.set(taskId, task);
        }
        console.error('[video2] 视频上传处理失败:', err.message);
      }
    })();
  } catch (error) {
    console.error('[video2] 视频上传接口失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/video2/upload/status/:taskId', async (req, res) => {
  const task = video2VideoTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ status: 'not_found' });
  res.json({
    status: task.status,
    progress: task.progress,
    message: task.message,
    result: task.result,
    error: task.error
  });
});

app.post('/api/video2/upload/from-url', async (req, res) => {
  try {
    const { url, type, projectId, sceneId, title, reference } = req.body;
    if (!url) return res.status(400).json({ success: false, message: '缺少 url' });

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ success: false, message: 'URL 格式无效' });
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ success: false, message: '仅支持 HTTP/HTTPS 链接' });
    }

    let probeOk = false;
    let detectedType = null;
    let probeError = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const probe = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (probe.ok) {
        probeOk = true;
        const contentType = probe.headers.get('content-type') || '';
        if (contentType.startsWith('image/')) detectedType = 'image';
        else if (contentType.startsWith('video/')) detectedType = 'video';
      } else {
        probeError = `HTTP ${probe.status}`;
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        probeError = '探测超时';
      } else {
        probeError = err.message;
      }
    }

    if (!probeOk) {
      return res.status(400).json({ success: false, message: `URL 无法访问：${probeError || '未知错误'}` });
    }

    const actualType = type === 'image' ? 'image' : (detectedType || 'video');
    const folder = projectId ? `projects/${projectId}/${actualType}s` : `projects/default/${actualType}s`;
    const ext = (url.split('.').pop() || '').split('?')[0] || (actualType === 'image' ? 'jpg' : 'mp4');
    const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 8)}.${ext}`;

    let fileUrl = '';
    if (isOSSConfigured && ossClient) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`无法下载远程文件: HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const ossKey = `${folder}/${fileName}`;
      console.log(`[video2] URL 转存到 OSS (${folder}): ${url}`);
      const result = await ossClient.put(ossKey, buffer);
      fileUrl = result.url;
      console.log(`[video2] URL 转存成功: ${url} -> ${ossKey}`);
    } else {
      fileUrl = url;
    }

    const item = await db.video2Items.create({
      title: title || fileName,
      filename: fileName,
      url: fileUrl,
      status: 'pending',
      projectId: projectId ? parseInt(projectId) : null,
      sceneId: sceneId ? parseInt(sceneId) : null,
      type: actualType,
      reference: reference ? 1 : 0
    });
    if (projectId && !reference) {
      trySetProjectCoverIfDefault(parseInt(projectId), fileUrl, actualType).catch(() => {});
    }
    res.json({ success: true, url: fileUrl, id: item.id, filename: fileName, type: actualType });
  } catch (error) {
    console.error('[video2] URL 转存失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/projects/:id/cover', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { coverUrl } = req.body;
    if (!coverUrl) return res.status(400).json({ success: false, message: 'coverUrl 不能为空' });
    const project = await db.video2Projects.getById(id);
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });
    await db.video2Projects.update(id, { coverUrl });
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新项目封面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/video2/projects/:id/reference', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const { title, type, url, filename, sceneId } = req.body;
    if (!url) return res.status(400).json({ success: false, message: '缺少 url' });
    const actualType = type === 'image' ? 'image' : 'video';
    const item = await db.video2Items.create({
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
    console.error('[video2] 添加参考文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/video2/projects/:id/references', async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const items = await db.video2Items.getByFilter({ projectId, deleted: 0, reference: 1 });
    res.json({ success: true, data: items });
  } catch (error) {
    console.error('[video2] 获取参考文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 删除项目参考文件
app.delete('/api/video2/projects/:projectId/references/:itemId', async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    const itemId = parseInt(req.params.itemId);
    const item = await db.video2Items.getById(itemId);
    if (!item || item.projectId !== projectId) {
      return res.status(404).json({ success: false, message: '参考文件不存在' });
    }
    await db.video2Items.softDelete(itemId);
    // 如果被删的文件同时是项目封面，清除封面
    const project = await db.video2Projects.getById(projectId);
    if (project && project.coverUrl === item.url) {
      await db.video2Projects.update(projectId, { coverUrl: '' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 删除参考文件失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/video2/scenes/:sceneId/references', async (req, res) => {
  try {
    const sceneId = parseInt(req.params.sceneId);
    if (!sceneId || isNaN(sceneId)) {
      return res.status(400).json({ success: false, message: '无效的场次 ID' });
    }
    const images = await db.video2ShotMedia.getBySceneId(sceneId);
    res.json({ success: true, data: images });
  } catch (error) {
    console.error('[video2] 获取场次场景图失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/videos/:id/set-cover', async (req, res) => {
  warnDeprecated('PUT /api/video2/videos/:id/set-cover', 'PUT /api/video2/projects/:id/cover');
  try {
    const id = parseInt(req.params.id);
    const item = await db.video2Items.getById(id);
    if (!item || !item.projectId) return res.status(404).json({ success: false, message: '记录不存在' });
    let coverUrl = item.url;
    if (item.type !== 'image' && coverUrl && (coverUrl.includes('aliyuncs.com') || coverUrl.includes('qiziwenhua.top'))) {
      coverUrl = coverUrl + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
    }
    const ok = await db.video2Items.setCover(item.projectId, id);
    if (ok) {
      await db.video2Projects.update(item.projectId, { coverUrl });
    }
    res.json({ success: true, coverUrl });
  } catch (error) {
    console.error('[video2] 设置封面失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== video2 微信分享落地页 ====================

function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.toString().replace(/[&<>"]/g, m => map[m]);
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
    const project = await db.video2Projects.getById(projectId);
    if (!project) {
      return res.redirect('/');
    }

    const distIndexPath = path.join(distDir, 'index.html');
    let html = fs.readFileSync(distIndexPath, 'utf-8');

    const origin = `${req.protocol}://${req.get('host')}`;
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
      .replace('</body>', `<script>setTimeout(function(){window.location.href='${redirectUrl}';},500);</script></body>`);

    console.log(`[video2] 为项目 ID ${projectId} 渲染了分享落地页`);
    res.send(html);
  } catch (error) {
    console.error('[video2] 渲染分享落地页失败:', error);
    res.redirect('/');
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/') || req.path.startsWith('/images/') || req.path.startsWith('/ffmpeg/') || req.path.startsWith('/share/')) {
    return next();
  }
  res.sendFile(path.join(distDir, 'index.html'));
});

const server = app.listen(port, () => {
  console.log(`Video2 server running on http://localhost:${port}`);
});

server.timeout = 2400000;
server.keepAliveTimeout = 65000;
