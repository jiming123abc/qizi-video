const FILE_SIZE_LIMITS = {
  image: 20 * 1024 * 1024,
  video: 1024 * 1024 * 1024
};

const CLOUDFLARE_MAX_MB = 95;

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const ALLOWED_MIME_TYPES = {
  image: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']
};

function validateFileSize(file: File, type: 'image' | 'video'): { valid: boolean; maxSizeMB: number } {
  const maxSize = FILE_SIZE_LIMITS[type];
  return {
    valid: file.size <= maxSize,
    maxSizeMB: maxSize / (1024 * 1024)
  };
}

function validateFileType(file: File, type: 'image' | 'video'): boolean {
  return ALLOWED_MIME_TYPES[type].includes(file.type);
}

const API_BASE_URL = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_API_URL || '');

export function getOssProxyUrl(ossUrl: string, ossKey?: string): string {
  if (!ossUrl) return ossUrl;
  if (ossUrl.startsWith('data:')) return ossUrl;
  if (ossUrl.startsWith('/uploads/')) return ossUrl;
  
  // 如果是相对路径（已经是代理路径），直接返回
  if (ossUrl.startsWith('/api/')) return ossUrl;
  
  // 检查是否是 OSS URL（包括 aliyuncs.com 和自定义域名）
  const isOssUrl = ossUrl.includes('aliyuncs.com') || 
                   ossUrl.includes('qiziwenhua.top') ||
                   ossUrl.includes('oss-');
  
  if (!isOssUrl) return ossUrl;
  
  // 优先使用 key 参数
  if (ossKey) {
    return `${API_BASE_URL}/api/video2/oss-proxy?key=${encodeURIComponent(ossKey)}`;
  }
  
  return `${API_BASE_URL}/api/video2/oss-proxy?url=${encodeURIComponent(ossUrl)}`;
}

export function getVideoPoster(url: string): string {
  if (url && (url.includes('aliyuncs.com') || url.includes('qiziwenhua.top'))) {
    return url + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
  }
  return '';
}

// ================ 签名 URL 缓存（1小时有效期） ================
const signUrlCache = new Map<string, { url: string; expires: number }>();

export async function getSignedOssUrl(ossUrl: string): Promise<string> {
  if (!ossUrl) return ossUrl;
  if (ossUrl.startsWith('data:')) return ossUrl;
  if (ossUrl.startsWith('/uploads/')) return ossUrl;
  if (ossUrl.startsWith('/api/')) return ossUrl;

  // 检查缓存
  const cached = signUrlCache.get(ossUrl);
  if (cached && cached.expires > Date.now()) {
    return cached.url;
  }

  // 调用服务端签名接口
  const res = await fetch(
    `${API_BASE_URL}/api/video2/oss-sign-url?url=${encodeURIComponent(ossUrl)}`
  );
  if (!res.ok) {
    console.error('[oss] 获取签名 URL 失败，使用原始 URL:', ossUrl);
    return ossUrl;
  }
  const { signedUrl } = await res.json();

  // 缓存 50 分钟（1小时有效期提前刷新）
  signUrlCache.set(ossUrl, { url: signedUrl, expires: Date.now() + 50 * 60 * 1000 });
  return signedUrl;
}

// 批量获取签名 URL（一次性请求，结果写入缓存）
export async function batchGetSignedUrls(urls: string[]): Promise<void> {
  // 过滤出需要签名的 URL（排除缓存命中和非 OSS URL）
  const toSign = urls.filter(u => {
    if (!u || u.startsWith('data:') || u.startsWith('/uploads/') || u.startsWith('/api/')) return false;
    const cached = signUrlCache.get(u);
    return !cached || cached.expires <= Date.now();
  });

  if (toSign.length === 0) return;

  try {
    const params = toSign.map(u => `urls=${encodeURIComponent(u)}`).join('&');
    const res = await fetch(`${API_BASE_URL}/api/video2/oss-sign-urls?${params}`);
    if (!res.ok) return;

    const { signedUrls } = await res.json();
    const now = Date.now();
    for (const [origUrl, signedUrl] of Object.entries(signedUrls)) {
      signUrlCache.set(origUrl, { url: signedUrl, expires: now + 50 * 60 * 1000 });
    }
  } catch (e) {
    console.error('[oss] 批量签名失败:', e);
  }
}

// 从缓存获取签名 URL（同步，立即返回）
export function getSignedUrlFromCache(ossUrl: string): string {
  if (!ossUrl) return ossUrl;
  if (ossUrl.startsWith('data:')) return ossUrl;
  if (ossUrl.startsWith('/uploads/')) return ossUrl;
  if (ossUrl.startsWith('/api/')) return ossUrl;

  const cached = signUrlCache.get(ossUrl);
  if (cached && cached.expires > Date.now()) {
    return cached.url;
  }
  return ossUrl; // 未缓存时返回原始 URL
}

// ================ OSS 直传凭证 ================
export interface OssUploadCredential {
  host: string;
  accessKeyId: string;
  policy: string;
  signature: string;
  key: string;
  bucket: string;
  region: string;
}

export async function getOssUploadCredential(
  projectId: number,
  filename: string,
  type: 'image' | 'video'
): Promise<OssUploadCredential> {
  const res = await fetch(
    `${API_BASE_URL}/api/video2/oss-upload-credential?projectId=${projectId}&filename=${encodeURIComponent(filename)}&type=${type}`
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '获取上传凭证失败' }));
    throw new Error(err.error || '获取上传凭证失败');
  }
  return res.json();
}

// 直传文件到 OSS（使用服务端生成的凭证）
export async function uploadDirectToOss(
  file: File,
  credential: OssUploadCredential,
  onProgress?: (progress: UploadProgress) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', credential.host);

    const formData = new FormData();
    formData.append('key', credential.key);
    formData.append('OSSAccessKeyId', credential.accessKeyId);
    formData.append('policy', credential.policy);
    formData.append('signature', credential.signature);
    formData.append('file', file);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        onProgress?.({ phase: 'uploading', progress: pct, message: `上传中... ${pct}%` });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
        // 返回 OSS 文件 URL
        const fileUrl = `https://${credential.bucket}.oss-${credential.region}.aliyuncs.com/${credential.key}`;
        resolve(fileUrl);
      } else {
        reject(new Error(`OSS 上传失败: HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('网络错误')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));

    xhr.send(formData);
  });
}

export interface UploadProgress {
  phase: 'idle' | 'checking' | 'compressing' | 'uploading' | 'done';
  progress: number;
  message: string;
}

export interface UploadResult {
  url: string;
  compressed: boolean;
  compressionFailed?: boolean;
  originalSizeKB?: number;
  compressedSizeKB?: number;
  originalBitrate?: number;
  targetBitrate?: number;
  duration?: number;
}

export interface UploadError extends Error {
  ossError?: boolean;
  message: string;
}

export type UploadDecision = {
  decision: 'direct_upload' | 'must_compress';
  compressionMethod: 'server' | 'browser' | 'aliyun' | null;
  bitrateKbps: number | null;
  targetBitrateKbps: number;
  duration: number | null;
  resolution?: '1080p' | '720p' | '480p' | 'other';
  width?: number;
  height?: number;
  fileSizeMB: string;
  fileSizeMBNum: number;
};

// 图片上传（保持不变）
export async function uploadImage(
  file: File,
  onProgress?: (progress: UploadProgress) => void,
  forceLocal: boolean = false
): Promise<UploadResult> {
  if (!validateFileType(file, 'image')) {
    throw new Error('不支持的图片格式，请上传 JPG、PNG、WebP 或 GIF 格式');
  }
  
  const sizeValidation = validateFileSize(file, 'image');
  if (!sizeValidation.valid) {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    throw new Error(`图片大小不能超过 ${sizeValidation.maxSizeMB}MB，当前文件大小: ${fileSizeMB}MB`);
  }

  const fileSizeKB = (file.size / 1024).toFixed(1);
  onProgress?.({ phase: 'uploading', progress: 0, message: `正在上传图片 (${fileSizeKB}KB)...` });

  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const url = new URL(`${API_BASE_URL}/api/upload/image`);
    if (forceLocal) {
      url.searchParams.set('forceLocal', 'true');
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url.toString());
    xhr.timeout = 300000;

    xhr.upload.addEventListener('progress', (event) => {
      if (event.loaded && event.total) {
        const percentage = Math.round((event.loaded / event.total) * 100);
        onProgress?.({ phase: 'uploading', progress: percentage, message: `图片上传中... ${percentage}%` });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText);
          let message = '';
          if (result.compressed) {
            message = `图片压缩完成\n大小: ${result.originalSizeKB.toFixed(1)}KB -> ${result.compressedSizeKB.toFixed(1)}KB`;
          } else {
            message = `图片上传完成\n大小: ${result.originalSizeKB?.toFixed(1) || fileSizeKB}KB（无需压缩）`;
          }
          onProgress?.({ phase: 'uploading', progress: 100, message });
          resolve(result);
        } catch (error) {
          reject(new Error('解析响应失败'));
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          const uploadError: UploadError = new Error(error.message || error.error || '上传失败');
          uploadError.ossError = error.ossError === true;
          reject(uploadError);
        } catch {
          reject(new Error('上传失败'));
        }
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('网络错误'));
    });

    xhr.addEventListener('timeout', () => {
      reject(new Error('上传超时'));
    });

    xhr.send(formData);
  });
}

export async function checkVideoBitrate(file: File): Promise<UploadDecision> {
  const fileSizeMBNum = file.size / 1024 / 1024;
  const fileSizeMB = fileSizeMBNum.toFixed(2);
  
  const { estimateVideoBitrate, getTargetBitrate, needsCompression } = await import('./videoCompressor');
  const result = await estimateVideoBitrate(file);
  
  const targetBitrateKbps = getTargetBitrate(result.resolution);
  
  if (result.bitrateKbps === null || !needsCompression(result.bitrateKbps, result.resolution)) {
    return {
      decision: 'direct_upload',
      compressionMethod: null,
      bitrateKbps: result.bitrateKbps,
      targetBitrateKbps,
      duration: result.duration,
      resolution: result.resolution,
      width: result.width,
      height: result.height,
      fileSizeMB,
      fileSizeMBNum,
    };
  }
  
  const compressionMethod: 'server' | 'browser' = fileSizeMBNum <= CLOUDFLARE_MAX_MB ? 'server' : 'browser';
  
  return {
    decision: 'must_compress',
    compressionMethod,
    bitrateKbps: result.bitrateKbps,
    targetBitrateKbps,
    duration: result.duration,
    resolution: result.resolution,
    width: result.width,
    height: result.height,
    fileSizeMB,
    fileSizeMBNum,
  };
}

// 客户端直传 OSS（低码率视频，不经过服务器）
// TODO: OSS 路径已改为按项目ID分文件夹 (projectId/videos/ 或 default/videos/)
//       此函数需要添加 projectId 参数并更新 presign 请求的 folder 字段
export async function uploadVideoDirectToOSS(
  file: File,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult> {
  if (!validateFileType(file, 'video')) {
    throw new Error('不支持的视频格式，请上传 MP4、WebM、OGG 或 MOV 格式');
  }

  const sizeValidation = validateFileSize(file, 'video');
  if (!sizeValidation.valid) {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    throw new Error(`视频大小不能超过 ${sizeValidation.maxSizeMB}MB，当前文件大小: ${fileSizeMB}MB`);
  }

  onProgress?.({ phase: 'uploading', progress: 0, message: '正在获取上传凭证...' });

  const presignResponse = await fetch(`${API_BASE_URL}/api/oss/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder: 'videos',
      filename: file.name,
      contentType: file.type || 'video/mp4'
    })
  });

  if (!presignResponse.ok) {
    const err = await presignResponse.json();
    throw new Error(err.error || '获取上传凭证失败');
  }

  const { signedUrl, publicUrl } = await presignResponse.json();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.timeout = 600000;

    xhr.upload.addEventListener('progress', (event) => {
      if (event.loaded && event.total) {
        const percentage = Math.round((event.loaded / event.total) * 100);
        onProgress?.({ phase: 'uploading', progress: percentage, message: `视频上传中... ${percentage}%` });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
        onProgress?.({ phase: 'done', progress: 100, message: `视频上传完成\n大小: ${fileSizeMB}MB` });
        resolve({ url: publicUrl, compressed: false });
      } else {
        reject(new Error(`OSS 上传失败: HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('网络错误')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));

    xhr.send(file);
  });
}

// 轮询函数
async function pollTaskStatus(
  taskId: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<any> {
  let attempts = 0;
  const maxAttempts = 360; // 最多10分钟 (360 * 2秒)

  while (attempts < maxAttempts) {
    const res = await fetch(`${API_BASE_URL}/api/upload/video/status/${taskId}`);
    if (!res.ok) {
      throw new Error('获取任务状态失败');
    }
    const task = await res.json();

    if (task.status === 'completed') {
      return task.result;
    }
    if (task.status === 'failed') {
      const err: UploadError = new Error(task.error || '任务失败');
      err.ossError = task.ossError === true;
      throw err;
    }

    // 更新进度
    const phase: any = task.progress < 50 ? 'compressing' : (task.progress < 100 ? 'uploading' : 'done');
    const progress = task.progress;
    const message = task.message || '处理中...';
    onProgress?.({ phase, progress, message });

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒轮询一次
  }

  throw new Error('任务超时');
}

// 上传到服务器进行压缩（高码率视频，异步轮询模式）
export async function uploadVideoToServerWithCompression(
  file: File,
  onProgress?: (progress: UploadProgress) => void,
  forceLocal: boolean = false
): Promise<UploadResult> {
  if (!validateFileType(file, 'video')) {
    throw new Error('不支持的视频格式，请上传 MP4、WebM、OGG 或 MOV 格式');
  }

  const sizeValidation = validateFileSize(file, 'video');
  if (!sizeValidation.valid) {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    throw new Error(`视频大小不能超过 ${sizeValidation.maxSizeMB}MB，当前文件大小: ${fileSizeMB}MB`);
  }

  const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
  onProgress?.({ phase: 'compressing', progress: 0, message: `正在上传视频至服务器进行压缩 (${fileSizeMB}MB)...` });

  // 第一步：上传文件获取 taskId
  const formData = new FormData();
  formData.append('file', file);

  const url = new URL(`${API_BASE_URL}/api/upload/video`);
  url.searchParams.set('compress', 'true');
  if (forceLocal) {
    url.searchParams.set('forceLocal', 'true');
  }

  const uploadRes = await fetch(url.toString(), {
    method: 'POST',
    body: formData
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({ error: '上传失败' }));
    const uploadError: UploadError = new Error(err.message || err.error || '上传失败');
    uploadError.ossError = err.ossError === true;
    throw uploadError;
  }

  const { taskId } = await uploadRes.json();

  // 第二步：轮询任务状态
  onProgress?.({ phase: 'compressing', progress: 5, message: '文件上传完成，等待处理...' });
  const result = await pollTaskStatus(taskId, onProgress);

  const compressionFailed = result.compressionFailed === true;
  const compressed = result.compressed === true;

  if (compressionFailed) {
    onProgress?.({ phase: 'done', progress: 100, message: '压缩未成功，已上传原始视频' });
  } else if (compressed) {
    const origMB = (result.originalSizeKB / 1024).toFixed(2);
    const compMB = (result.compressedSizeKB / 1024).toFixed(2);
    onProgress?.({ phase: 'done', progress: 100, message: `视频压缩上传完成\n大小: ${origMB}MB -> ${compMB}MB` });
  } else {
    onProgress?.({ phase: 'done', progress: 100, message: `视频上传完成\n大小: ${fileSizeMB}MB（无需压缩）` });
  }

  return {
    url: result.url,
    compressed,
    compressionFailed,
    originalSizeKB: result.originalSizeKB,
    compressedSizeKB: result.compressedSizeKB,
  };
}

// 浏览器压缩后再直传 OSS（高码率视频，绕过 Cloudflare 100MB 限制）
export async function uploadVideoWithBrowserCompression(
  file: File,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult> {
  if (!validateFileType(file, 'video')) {
    throw new Error('不支持的视频格式，请上传 MP4、WebM、OGG 或 MOV 格式');
  }

  const sizeValidation = validateFileSize(file, 'video');
  if (!sizeValidation.valid) {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    throw new Error(`视频大小不能超过 ${sizeValidation.maxSizeMB}MB，当前文件大小: ${fileSizeMB}MB`);
  }

  const originalSizeKB = Math.round(file.size / 1024);
  onProgress?.({ phase: 'compressing', progress: 0, message: '正在加载浏览器压缩组件...' });

  const { compressVideoInBrowser } = await import('./videoCompressor');
  const compressResult = await compressVideoInBrowser(file, undefined, (stage, progress) => {
    if (stage === 'loading') {
      onProgress?.({ phase: 'compressing', progress: Math.min(progress * 0.3, 30), message: `正在加载压缩组件... ${Math.round(progress)}%` });
    } else {
      onProgress?.({ phase: 'compressing', progress: 30 + progress * 0.3, message: `正在浏览器中压缩视频... ${Math.round(progress)}%` });
    }
  });

  if (!compressResult.success) {
    throw new Error((compressResult as { success: false; message: string }).message);
  }

  const compressedFile = compressResult.file;
  const compressedSizeKB = Math.round(compressedFile.size / 1024);
  onProgress?.({ phase: 'uploading', progress: 60, message: `压缩完成，正在上传至 OSS (${(compressedSizeKB / 1024).toFixed(2)}MB)...` });

  const presignResponse = await fetch(`${API_BASE_URL}/api/oss/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder: 'videos',
      filename: compressedFile.name,
      contentType: 'video/mp4'
    })
  });

  if (!presignResponse.ok) {
    throw new Error('获取上传凭证失败');
  }

  const { signedUrl, publicUrl } = await presignResponse.json();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('Content-Type', 'video/mp4');
    xhr.timeout = 600000;

    xhr.upload.addEventListener('progress', (event) => {
      if (event.loaded && event.total) {
        const percentage = 60 + Math.round((event.loaded / event.total) * 40);
        onProgress?.({ phase: 'uploading', progress: percentage, message: `上传压缩后视频... ${Math.round((event.loaded / event.total) * 100)}%` });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.({ phase: 'done', progress: 100, message: `浏览器压缩完成\n${(originalSizeKB / 1024).toFixed(2)}MB -> ${(compressedSizeKB / 1024).toFixed(2)}MB` });
        resolve({
          url: publicUrl,
          compressed: true,
          originalSizeKB,
          compressedSizeKB,
        });
      } else {
        reject(new Error(`上传失败: HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('网络错误')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));
    xhr.send(compressedFile);
  });
}

// ================ video2 专用上传函数 ================

// 图片上传到 imges2 文件夹（通过后端 API 自动压缩）
export async function uploadVideo2Image(
  file: File,
  options?: {
    projectId?: number;
    sceneId?: number;
    reference?: boolean;
    title?: string;
    createShot?: boolean;
    onProgress?: (p: UploadProgress) => void;
    signal?: AbortSignal;
  }
): Promise<UploadResult & { id?: number; filename?: string; ossKey?: string }> {
  options?.onProgress?.({ phase: 'uploading', progress: 10, message: '上传图片中...' });

  const formData = new FormData();
  formData.append('file', file);
  if (options?.projectId) formData.append('projectId', String(options.projectId));
  if (options?.sceneId) formData.append('sceneId', String(options.sceneId));
  if (options?.reference) formData.append('reference', '1');
  if (options?.title) formData.append('title', options.title);
  if (options?.createShot) formData.append('createShot', '1');

  try {
    const response = await fetch(`${API_BASE_URL}/api/video2/upload/image`, {
      method: 'POST',
      body: formData,
      signal: options?.signal
    });

    options?.onProgress?.({ phase: 'uploading', progress: 80, message: '处理中...' });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`上传失败: ${errText}`);
    }

    const result = await response.json();
    options?.onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
    return {
      url: result.url,
      compressed: result.compressed || false,
      id: result.id,
      filename: result.filename,
      ossKey: result.ossKey
    };
  } catch (err) {
    options?.onProgress?.({ phase: 'idle', progress: 0, message: '上传失败' });
    throw err;
  }
}

// 视频上传到 video2 文件夹（通过后端 API，支持自动压缩）
export async function uploadVideo2Video(
  file: File,
  options?: {
    projectId?: number;
    sceneId?: number;
    reference?: boolean;
    title?: string;
    createShot?: boolean;
    compressionMethod?: 'server' | 'browser' | 'aliyun' | 'none';
    skipBitrateCheck?: boolean;
    onProgress?: (p: UploadProgress) => void;
    targetBitrate?: number;
    signal?: AbortSignal;
  }
): Promise<UploadResult & { id?: number; filename?: string; ossKey?: string }> {
  const method = options?.compressionMethod || 'none';
  const originalSizeKB = Math.round(file.size / 1024);

  let targetFile = file;
  let compressed = false;
  let decision: UploadDecision | null = null;

  if (!options?.skipBitrateCheck && method !== 'none') {
    options?.onProgress?.({ phase: 'checking', progress: 2, message: '正在检测视频信息...' });
    decision = await checkVideoBitrate(file);
  }

  if (method === 'browser') {
    options?.onProgress?.({ phase: 'compressing', progress: 5, message: '浏览器压缩中...' });
    const { compressVideoInBrowser } = await import('./videoCompressor');
    const compressResult = await compressVideoInBrowser(
      file,
      decision?.resolution,
      (stage: 'loading' | 'compressing', progress: number) => {
        const baseProgress = stage === 'loading' ? 5 + progress * 0.1 : 15 + progress * 0.5;
        options?.onProgress?.({
          phase: 'compressing',
          progress: Math.round(baseProgress),
          message: stage === 'loading' ? '正在加载压缩组件...' : '正在压缩视频...'
        });
      }
    );

    if (!compressResult.success) {
      throw new Error('压缩失败：' + (compressResult as { success: false; message: string }).message + '。请手动压缩后再上传。');
    }

    targetFile = compressResult.file;
    compressed = true;
    options?.onProgress?.({ phase: 'compressing', progress: 65, message: '压缩完成，正在上传...' });
  }

  // 阿里云 MPS 转码压缩
  if (method === 'aliyun') {
    options?.onProgress?.({ phase: 'uploading', progress: 5, message: '上传视频到 OSS...' });

    // 获取视频分辨率信息
    const videoInfo = await checkVideoBitrate(file);
    const { getTargetBitrate: getBitrate } = await import('./videoCompressor');

    // 调用阿里云转码
    const result = await uploadVideoWithAliyunCompression(file, {
      projectId: options?.projectId,
      targetBitrate: options?.targetBitrate || getBitrate(videoInfo.resolution),
      onProgress: (p) => {
        options?.onProgress?.({
          phase: p.phase,
          progress: 5 + p.progress * 0.95, // 映射到 5-100
          message: p.message
        });
      }
    });

    return {
      url: result.url,
      compressed: true,
      id: result.id,
      filename: result.filename,
      ossKey: result.ossKey,
      originalSizeKB,
      compressedSizeKB: result.compressedSizeKB,
      originalBitrate: videoInfo.bitrateKbps ?? undefined,
      targetBitrate: videoInfo.targetBitrateKbps,
      duration: videoInfo.duration ?? undefined,
    };
  }

  const formData = new FormData();
  formData.append('file', targetFile);
  if (options?.projectId) formData.append('projectId', String(options.projectId));
  if (options?.sceneId) formData.append('sceneId', String(options.sceneId));
  if (options?.reference) formData.append('reference', '1');
  if (options?.title) formData.append('title', options.title);
  if (options?.createShot) formData.append('createShot', '1');

  const useServerCompress = method === 'server';

  try {
    options?.onProgress?.({ phase: 'uploading', progress: 70, message: '上传视频中...' });

    const taskResp = await fetch(
      `${API_BASE_URL}/api/video2/upload/video${useServerCompress ? '?compress=true' : ''}`,
      { method: 'POST', body: formData, signal: options?.signal }
    );
    if (!taskResp.ok) throw new Error(`上传失败: HTTP ${taskResp.status}`);
    const { taskId } = await taskResp.json();
    options?.onProgress?.({ phase: 'uploading', progress: 75, message: '文件已提交，等待处理...' });

    let attempts = 0;
    const maxAttempts = 180;
    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000));
      const statusResp = await fetch(`${API_BASE_URL}/api/video2/upload/status/${taskId}`);
      if (!statusResp.ok) throw new Error('状态查询失败');
      const status = await statusResp.json();

      if (status.status === 'done') {
        options?.onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
        return {
          url: status.result.url,
          compressed: compressed || status.result.compressed || false,
          id: status.result.id,
          filename: status.result.fileName,
          ossKey: status.result.ossKey,
          originalSizeKB,
          compressedSizeKB: status.result.fileSize ? Math.round(status.result.fileSize / 1024) : undefined,
          originalBitrate: decision?.bitrateKbps ?? undefined,
          targetBitrate: decision?.targetBitrateKbps,
          duration: decision?.duration ?? undefined,
        };
      }
      if (status.status === 'error') {
        if (useServerCompress && status.error?.includes('压缩')) {
          throw new Error('服务端压缩失败：' + status.error + '。请手动压缩后再上传。');
        }
        throw new Error(status.error || '上传失败');
      }
      const progress = Math.min(95, 75 + Math.floor((attempts / maxAttempts) * 20));
      options?.onProgress?.({
        phase: status.status === 'processing' ? 'compressing' : 'uploading',
        progress,
        message: status.message || '处理中...'
      });
      attempts++;
    }
    throw new Error('上传超时');
  } catch (err) {
    options?.onProgress?.({ phase: 'idle', progress: 0, message: String(err) });
    throw err;
  }
}

// 阿里云 MPS 转码压缩上传
export async function uploadVideoWithAliyunCompression(
  file: File,
  options?: {
    projectId?: number;
    targetBitrate?: number;
    onProgress?: (p: UploadProgress) => void;
  }
): Promise<UploadResult & { id?: number; filename?: string; ossKey?: string }> {
  // 1. 先上传原视频到 OSS（临时存储）
  options?.onProgress?.({ phase: 'uploading', progress: 0, message: '上传原视频到 OSS...' });

  const formData = new FormData();
  formData.append('file', file);
  if (options?.projectId) formData.append('projectId', String(options.projectId));

  const uploadResp = await fetch(`${API_BASE_URL}/api/video2/upload/video`, {
    method: 'POST',
    body: formData
  });

  if (!uploadResp.ok) {
    const errText = await uploadResp.text();
    throw new Error(`上传原视频失败: ${errText}`);
  }

  const uploadResult = await uploadResp.json();
  const videoUrl = uploadResult.url;
  const ossKey = uploadResult.ossKey;

  options?.onProgress?.({ phase: 'compressing', progress: 20, message: '提交阿里云转码任务...' });

  // 2. 调用后端 /api/video2/aliyun/transcode 提交转码任务
  const transcodeResp = await fetch(`${API_BASE_URL}/api/video2/aliyun/transcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoUrl,
      ossKey,
      filename: file.name,
      targetBitrate: options?.targetBitrate
    })
  });

  if (!transcodeResp.ok) {
    const errText = await transcodeResp.text();
    throw new Error(`提交转码任务失败: ${errText}`);
  }

  const { taskId } = await transcodeResp.json();

  // 3. 轮询 /api/video2/aliyun/transcode/:taskId 查询状态
  let attempts = 0;
  const maxAttempts = 300; // 最大等待 10 分钟 (300 * 2秒)

  while (attempts < maxAttempts) {
    const statusResp = await fetch(`${API_BASE_URL}/api/video2/aliyun/transcode/${taskId}`);
    if (!statusResp.ok) {
      throw new Error('查询转码状态失败');
    }

    const status = await statusResp.json();

    if (status.status === 'completed' || status.status === 'done') {
      // 4. 转码完成，返回结果
      options?.onProgress?.({ phase: 'done', progress: 100, message: '阿里云转码完成' });

      return {
        url: status.url || videoUrl,
        compressed: true,
        id: status.id,
        filename: status.filename || file.name,
        ossKey: status.ossKey || ossKey,
        originalSizeKB: Math.round(file.size / 1024),
        compressedSizeKB: status.fileSize ? Math.round(status.fileSize / 1024) : undefined,
      };
    }

    if (status.status === 'failed' || status.status === 'error') {
      throw new Error(status.error || '阿里云转码失败');
    }

    // 更新进度：20-80 映射到转码进度
    const progress = 20 + Math.min(status.progress || 0, 100) * 0.6;
    options?.onProgress?.({
      phase: 'compressing',
      progress: Math.round(progress),
      message: status.message || '阿里云转码中...'
    });

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒轮询一次
  }

  throw new Error('阿里云转码超时（最长等待10分钟）');
}

// 从网络 URL 转存图片/视频到 OSS
export async function uploadVideo2FromUrl(
  url: string,
  options?: {
    type?: 'image' | 'video';
    projectId?: number;
    sceneId?: number;
    reference?: boolean;
    title?: string;
    onProgress?: (p: UploadProgress) => void;
  }
): Promise<{ url: string; id?: number; filename?: string; type: 'image' | 'video' }> {
  options?.onProgress?.({ phase: 'uploading', progress: 30, message: '正在从 URL 抓取文件...' });

  try {
    const response = await fetch(`${API_BASE_URL}/api/video2/upload/from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        type: options?.type,
        projectId: options?.projectId,
        sceneId: options?.sceneId,
        reference: options?.reference ? 1 : 0,
        title: options?.title
      })
    });
    if (!response.ok) throw new Error(`URL 转存失败: HTTP ${response.status}`);
    const result = await response.json();
    options?.onProgress?.({ phase: 'done', progress: 100, message: '转存完成' });
    return {
      url: result.url,
      id: result.id,
      filename: result.filename,
      type: result.type || (options?.type || 'video')
    };
  } catch (err) {
    options?.onProgress?.({ phase: 'idle', progress: 0, message: String(err) });
    throw err;
  }
}

// 文件类型检测：判断某个 File 是图片、视频，还是不支持
export function detectFileType(file: File): { supported: boolean; type: 'image' | 'video' | 'unknown'; mime: string } {
  const mime = file.type;
  if (ALLOWED_MIME_TYPES.image.includes(mime) || mime.startsWith('image/')) {
    return { supported: true, type: 'image', mime };
  }
  if (ALLOWED_MIME_TYPES.video.includes(mime) || mime.startsWith('video/')) {
    return { supported: true, type: 'video', mime };
  }
  return { supported: false, type: 'unknown', mime };
}