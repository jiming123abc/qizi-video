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
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('./database');

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

const isOSSConfigured = 
  process.env.REACT_APP_OSS_ACCESS_KEY_ID && 
  process.env.REACT_APP_OSS_ACCESS_KEY_ID !== '你的OSS AccessKey ID' &&
  process.env.REACT_APP_OSS_ACCESS_KEY_SECRET && 
  process.env.REACT_APP_OSS_ACCESS_KEY_SECRET !== '你的OSS AccessKey Secret' &&
  process.env.REACT_APP_OSS_BUCKET && 
  process.env.REACT_APP_OSS_BUCKET !== '你的Bucket名称';

function findExecutable(names) {
  const { execSync } = require('child_process');
  for (const name of names) {
    try {
      const result = execSync(`which ${name} 2>/dev/null || command -v ${name} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (result) {
        try {
          execSync(`${result} -version 2>/dev/null`, { stdio: 'ignore' });
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
app.use(cors());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Content-Type: ${req.headers['content-type'] || 'none'}`);
  next();
});

app.use(express.json({ limit: '1mb' }));

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
    accessKeyId: process.env.REACT_APP_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.REACT_APP_OSS_ACCESS_KEY_SECRET,
    bucket: process.env.REACT_APP_OSS_BUCKET,
    region: process.env.REACT_APP_OSS_REGION || 'oss-cn-beijing',
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

async function getVideoBitrate(buffer) {
  return new Promise((resolve, reject) => {
    const tempPath = path.join(__dirname, `temp_${Date.now()}_probe.mp4`);
    
    const timeoutId = setTimeout(() => {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      console.warn('获取视频比特率超时');
      resolve(null);
    }, 30000);
    
    try {
      fs.writeFileSync(tempPath, buffer);
      
      ffmpeg.ffprobe(tempPath, (err, metadata) => {
        clearTimeout(timeoutId);
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (e) { }
        
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
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (e) { }
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
          `-b:v ${maxBitrateKbps}k`,
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

const video2VideoTasks = new Map();

// ==================== video2 视频片段管理 API（扩展版） ====================

app.get('/api/video2/list', async (req, res) => {
  try {
    const { projectId, sceneId, status, deleted } = req.query;
    const items = await db.video2Items.getByFilter({
      projectId: projectId !== undefined ? parseInt(projectId) : undefined,
      sceneId: sceneId !== undefined ? (sceneId === 'null' ? null : parseInt(sceneId)) : undefined,
      status,
      deleted: deleted !== undefined ? parseInt(deleted) : 0
    });
    res.json({ success: true, data: items });
  } catch (error) {
    console.error('[video2] 获取列表失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/video2/stats', async (req, res) => {
  try {
    const { projectId, sceneId } = req.query;
    let stats;
    if (projectId !== undefined) {
      const pid = parseInt(projectId);
      const sceneFilter = (sceneId !== undefined)
        ? { sceneId: sceneId === 'null' ? null : parseInt(sceneId) }
        : {};
      const pending = await db.video2Items.getByFilter({
        projectId: pid, status: 'pending', deleted: 0, ...sceneFilter
      });
      const done = await db.video2Items.getByFilter({
        projectId: pid, status: 'done', deleted: 0, ...sceneFilter
      });
      const trash = await db.video2Items.getByFilter({ projectId: pid, deleted: 1 });
      stats = { pending: pending.length, done: done.length, trash: trash.length, total: pending.length + done.length };
    } else {
      stats = await db.video2Items.getStats();
    }
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[video2] 获取统计失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/video2/add', express.json({ limit: '1mb' }), async (req, res) => {
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

app.put('/api/video2/:id/status', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (status !== 'pending' && status !== 'done') {
      return res.status(400).json({ success: false, message: 'status 只能是 pending 或 done' });
    }
    const ok = await db.video2Items.updateStatus(id, status);
    if (!ok) return res.status(404).json({ success: false, message: '视频不存在' });
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 更新状态失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/:id/shotNo', async (req, res) => {
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

app.delete('/api/video2/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ok = await db.video2Items.softDelete(id);
    if (!ok) return res.status(404).json({ success: false, message: '视频不存在' });
    console.log(`[video2] 视频 ID ${id} 已移入垃圾桶`);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 软删除失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/video2/videos/:id/hard', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const item = await db.video2Items.getById(id);
    if (!item) return res.status(404).json({ success: false, message: '视频不存在' });
    await db.video2Items.hardDelete(id);
    await deleteOssFile(item.url);
    console.log(`[video2] 视频 ID ${id} 已彻底删除`);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 彻底删除失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/video2/videos/:id/restore', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ok = await db.video2Items.restore(id);
    if (!ok) return res.status(404).json({ success: false, message: '视频不存在' });
    console.log(`[video2] 视频 ID ${id} 已从垃圾桶恢复`);
    res.json({ success: true });
  } catch (error) {
    console.error('[video2] 恢复失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/videos/:id/title', express.json({ limit: '1mb' }), async (req, res) => {
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

app.put('/api/video2/videos/batch-update', express.json({ limit: '1mb' }), async (req, res) => {
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
});

app.put('/api/video2/sort', express.json({ limit: '1mb' }), async (req, res) => {
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

app.post('/api/video2/projects', express.json({ limit: '1mb' }), async (req, res) => {
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

app.put('/api/video2/projects/:id', express.json({ limit: '1mb' }), async (req, res) => {
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

app.put('/api/video2/projects/sort', express.json({ limit: '1mb' }), async (req, res) => {
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

app.post('/api/video2/projects/:projectId/scenes', express.json({ limit: '1mb' }), async (req, res) => {
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

app.put('/api/video2/scenes/:id', express.json({ limit: '1mb' }), async (req, res) => {
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

app.put('/api/video2/scenes/sort', express.json({ limit: '1mb' }), async (req, res) => {
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
    const forceLocalStorage = req.query.forceLocal === 'true';
    if (isOSSConfigured && !forceLocalStorage && ossClient) {
      try {
        const ossKey = `imges2/${fileName}`;
        const result = await ossClient.put(ossKey, fileBuffer);
        fileUrl = result.url;
        try { fs.unlinkSync(filePath); } catch (e) {}
        console.log(`[video2] 图片 OSS 上传成功 (imges2): ${fileName}`);
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
    const { projectId, sceneId, reference } = req.body || {};
    const title = req.body && req.body.title ? req.body.title : fileName;
    const item = await db.video2Items.create({
      title, filename: fileName, url: fileUrl,
      size: req.file.size,
      status: 'pending',
      projectId: projectId ? parseInt(projectId) : null,
      sceneId: sceneId ? parseInt(sceneId) : null,
      type: 'image',
      reference: reference ? 1 : 0
    });
    res.json({ success: true, url: fileUrl, filename: fileName, compressed, size: originalSizeKB, id: item.id });
  } catch (error) {
    console.error('[video2] 图片上传失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
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
      createdAt: Date.now()
    });
    res.json({ taskId, status: 'queued' });

    (async () => {
      try {
        const task = video2VideoTasks.get(taskId);
        if (!task) return;
        let fileUrl = '';
        let compressed = false;
        let fileBufferToUpload = null;

        if (task.shouldCompress) {
          try {
            const fileBuffer = fs.readFileSync(filePath);
            const bitrate = await getVideoBitrate(fileBuffer);
            if (bitrate && bitrate > 3000) {
              task.message = '正在压缩视频...';
              video2VideoTasks.set(taskId, task);
              const compressedBuffer = await compressVideo(fileBuffer, 3000);
              if (compressedBuffer.length < fileBuffer.length) {
                fileBufferToUpload = compressedBuffer;
                compressed = true;
                task.compressProgress = 100;
              } else {
                fileBufferToUpload = fileBuffer;
              }
            } else {
              fileBufferToUpload = fileBuffer;
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
            const ossKey = `video2/${task.fileName}`;
            const result = fileBufferToUpload
              ? await ossClient.put(ossKey, fileBufferToUpload)
              : await ossClient.put(ossKey, filePath);
            fileUrl = result.url;
            try { fs.unlinkSync(filePath); } catch (e) {}
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

        const item = await db.video2Items.create({
          title: req.body && req.body.title ? req.body.title : task.fileName,
          filename: task.fileName,
          url: fileUrl,
          size: req.file.size,
          status: 'pending',
          projectId: task.projectId,
          sceneId: task.sceneId,
          type: 'video',
          reference: task.reference
        });
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

app.post('/api/video2/upload/from-url', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { url, type, projectId, sceneId, title, reference } = req.body;
    if (!url) return res.status(400).json({ success: false, message: '缺少 url' });

    const actualType = type === 'image' ? 'image' : 'video';
    const folder = actualType === 'image' ? 'imges2' : 'video2';
    const ext = (url.split('.').pop() || '').split('?')[0] || (actualType === 'image' ? 'jpg' : 'mp4');
    const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 8)}.${ext}`;

    let fileUrl = '';
    if (isOSSConfigured && ossClient) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`无法下载远程文件: HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const ossKey = `${folder}/${fileName}`;
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
    res.json({ success: true, url: fileUrl, id: item.id, filename: fileName, type: actualType });
  } catch (error) {
    console.error('[video2] URL 转存失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/video2/projects/:id/cover', express.json({ limit: '1mb' }), async (req, res) => {
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

app.post('/api/video2/projects/:id/reference', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const { title, type, url, filename } = req.body;
    if (!url) return res.status(400).json({ success: false, message: '缺少 url' });
    const actualType = type === 'image' ? 'image' : 'video';
    const item = await db.video2Items.create({
      title: title || (filename || '参考文件'),
      filename: filename || title || 'ref',
      url,
      status: 'pending',
      projectId,
      sceneId: null,
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

app.put('/api/video2/videos/:id/set-cover', express.json({ limit: '1mb' }), async (req, res) => {
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
    const description = project.description || '柒子文化拍摄辅助 · 项目分享';
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
