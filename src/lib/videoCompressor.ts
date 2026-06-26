declare global {
  interface Window {
    FFmpegWASM: {
      FFmpeg: new () => FFmpegWasmInstance;
    };
  }
}

interface FFmpegWasmInstance {
  load: (config?: { coreURL?: string; wasmURL?: string }) => Promise<void>;
  writeFile: (name: string, data: Uint8Array) => Promise<void>;
  readFile: (name: string) => Promise<Uint8Array>;
  deleteFile: (name: string) => Promise<void>;
  exec: (args: string[]) => Promise<number>;
  on: (event: string, callback: (data: any) => void) => void;
  terminate: () => void;
}

export type VideoBitrateInfo = {
  bitrateKbps: number | null;
  duration: number | null;
  width?: number;
  height?: number;
  resolution?: '1080p' | '720p' | '480p' | 'other';
};

// 动态目标码率配置
const TARGET_BITRATE_CONFIG = {
  '1080p': 3000,  // 1080p 及以上
  '720p': 2000,    // 720p
  '480p': 1000,    // 480p
  'other': 1500    // 其他分辨率
};

// 默认码率（兼容旧配置）
const DEFAULT_TARGET_BITRATE_KBPS = 3000;

const FFMPEG_BASE = '/ffmpeg';
const UMD_SCRIPT_URL = `${FFMPEG_BASE}/ffmpeg.umd.js`;
const CORE_JS_URL = `${FFMPEG_BASE}/ffmpeg-core.js`;
const CORE_WASM_URL = `${FFMPEG_BASE}/ffmpeg-core.wasm`;

let ffmpegWasmLoaded = false;
let ffmpegWasmLoading: Promise<boolean> | null = null;

/**
 * 根据分辨率获取目标码率
 */
export function getTargetBitrate(resolution: string | undefined): number {
  const res = resolution || 'other';
  return TARGET_BITRATE_CONFIG[res as keyof typeof TARGET_BITRATE_CONFIG] || DEFAULT_TARGET_BITRATE_KBPS;
}

/**
 * 根据分辨率判断是否需要压缩
 * 注意：此函数不再提供"跳过"选项，高码率视频必须压缩
 */
export function needsCompression(bitrateKbps: number, resolution: string | undefined): boolean {
  const targetBitrate = getTargetBitrate(resolution);
  return bitrateKbps > targetBitrate;
}

export async function estimateVideoBitrate(file: File): Promise<VideoBitrateInfo> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.style.display = 'none';
    const url = URL.createObjectURL(file);
    let resolved = false;

    const done = (bitrateKbps: number | null, duration: number | null, width?: number, height?: number) => {
      if (resolved) return;
      resolved = true;
      video.removeAttribute('src');
      video.load();
      document.body.removeChild(video);
      URL.revokeObjectURL(url);
      
      // 根据高度判断分辨率
      let resolution: '1080p' | '720p' | '480p' | 'other' = 'other';
      if (height) {
        if (height >= 1080) resolution = '1080p';
        else if (height >= 720) resolution = '720p';
        else if (height >= 480) resolution = '480p';
      }
      
      resolve({ bitrateKbps, duration, width, height, resolution });
    };

    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (duration && duration > 0 && isFinite(duration)) {
        const fileSizeBits = file.size * 8;
        const bitrateKbps = Math.round(fileSizeBits / duration / 1000);
        done(bitrateKbps, duration, width, height);
      } else {
        done(null, null, width, height);
      }
    };

    video.onerror = () => {
      done(null, null);
    };

    document.body.appendChild(video);
    video.src = url;
  });
}

async function loadFFmpegUMD(): Promise<boolean> {
  if (ffmpegWasmLoaded) return true;
  if (ffmpegWasmLoading) return ffmpegWasmLoading;

  ffmpegWasmLoading = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = UMD_SCRIPT_URL;
    script.onload = () => {
      ffmpegWasmLoaded = true;
      resolve(true);
    };
    script.onerror = () => {
      ffmpegWasmLoading = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return ffmpegWasmLoading;
}

async function fetchAsBlobURL(url: string): Promise<string> {
  const response = await fetch(url);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export async function compressVideoInBrowser(
  file: File,
  targetResolution?: '1080p' | '720p' | '480p' | 'other',
  onProgress?: (stage: 'loading' | 'compressing', progress: number) => void
): Promise<{ success: true; file: File } | { success: false; message: string }> {
  try {
    onProgress?.('loading', 0);
    const umdLoaded = await loadFFmpegUMD();
    if (!umdLoaded || !window.FFmpegWASM) {
      return { success: false, message: 'FFmpeg 组件加载失败，请检查网络连接' };
    }

    onProgress?.('loading', 30);

    const { FFmpeg } = window.FFmpegWASM;
    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }: { message: string }) => {
      console.log('FFmpeg:', message);
    });

    ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      onProgress?.('compressing', progress * 100);
    });

    onProgress?.('loading', 50);
    await ffmpeg.load({
      coreURL: await fetchAsBlobURL(CORE_JS_URL),
      wasmURL: await fetchAsBlobURL(CORE_WASM_URL),
    });
    onProgress?.('loading', 100);
    onProgress?.('compressing', 0);

    // 根据目标分辨率获取目标码率
    const targetBitrate = getTargetBitrate(targetResolution);
    const inputFileName = 'input' + getFileExtension(file.name);
    const outputFileName = 'output.mp4';

    await ffmpeg.writeFile(inputFileName, new Uint8Array(await file.arrayBuffer()));

    // 构建 ffmpeg 命令
    const ffmpegArgs = [
      '-i', inputFileName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', `${targetBitrate}k`,
      '-maxrate', `${targetBitrate}k`,
      '-bufsize', `${targetBitrate * 2}k`,
      '-crf', '28',
      '-movflags', '+faststart',
      '-y',
      outputFileName,
    ];

    await ffmpeg.exec(ffmpegArgs);

    const data = await ffmpeg.readFile(outputFileName);
    const newFileName = file.name.replace(/\.[^.]+$/, '.mp4');
    const compressedFile = new File([data], newFileName, { type: 'video/mp4' });

    try {
      await ffmpeg.deleteFile(inputFileName);
      await ffmpeg.deleteFile(outputFileName);
      ffmpeg.terminate();
    } catch (e) { /* ignore */ }

    onProgress?.('compressing', 100);
    return { success: true, file: compressedFile };
  } catch (error) {
    console.error('浏览器压缩失败:', error);
    return { success: false, message: `压缩失败: ${(error as Error).message}` };
  }
}

function getFileExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || 'mp4';
  return '.' + ext;
}