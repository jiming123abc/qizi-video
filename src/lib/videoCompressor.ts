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
};

const TARGET_BITRATE_KBPS = 3000;
const FFMPEG_BASE = '/ffmpeg';
const UMD_SCRIPT_URL = `${FFMPEG_BASE}/ffmpeg.umd.js`;
const CORE_JS_URL = `${FFMPEG_BASE}/ffmpeg-core.js`;
const CORE_WASM_URL = `${FFMPEG_BASE}/ffmpeg-core.wasm`;

let ffmpegWasmLoaded = false;
let ffmpegWasmLoading: Promise<boolean> | null = null;

export async function estimateVideoBitrate(file: File): Promise<VideoBitrateInfo> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.style.display = 'none';
    const url = URL.createObjectURL(file);
    let resolved = false;

    const done = (bitrateKbps: number | null, duration: number | null) => {
      if (resolved) return;
      resolved = true;
      video.removeAttribute('src');
      video.load();
      document.body.removeChild(video);
      URL.revokeObjectURL(url);
      resolve({ bitrateKbps, duration });
    };

    video.onloadedmetadata = () => {
      const duration = video.duration;
      if (duration && duration > 0 && isFinite(duration)) {
        const fileSizeBits = file.size * 8;
        const bitrateKbps = Math.round(fileSizeBits / duration / 1000);
        done(bitrateKbps, duration);
      } else {
        done(null, null);
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

    const inputFileName = 'input' + getFileExtension(file.name);
    const outputFileName = 'output.mp4';

    await ffmpeg.writeFile(inputFileName, new Uint8Array(await file.arrayBuffer()));

    await ffmpeg.exec([
      '-i', inputFileName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', `${TARGET_BITRATE_KBPS}k`,
      '-maxrate', `${TARGET_BITRATE_KBPS}k`,
      '-bufsize', `${TARGET_BITRATE_KBPS * 2}k`,
      '-crf', '28',
      '-movflags', '+faststart',
      '-y',
      outputFileName,
    ]);

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