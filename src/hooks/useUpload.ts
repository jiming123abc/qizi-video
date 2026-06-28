import { useState, useRef, useEffect, useCallback } from 'react';
import {
  uploadVideo2Image,
  uploadVideo2Video,
  uploadVideo2FromUrl,
  detectFileType,
  checkVideoBitrate,
} from '../lib/ossUtils';
import type { UploadDecision } from '../lib/ossUtils';

export interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled' | 'pending';
  message?: string;
}

export interface UseUploadOptions {
  projectId: number;
  currentSceneId: number | null;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onUploadComplete?: () => void;
  loadShots?: () => void | Promise<void>;
  loadStats?: () => void | Promise<void>;
  loadProject?: () => void | Promise<void>;
}

export function useUpload(options: UseUploadOptions) {
  const { projectId, currentSceneId, showToast, onUploadComplete, loadShots, loadStats, loadProject } = options;

  const [uploadTab, setUploadTab] = useState<'file' | 'url'>('file');
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [urlInputValue, setUrlInputValue] = useState('');
  const [urlError, setUrlError] = useState('');

  const [pendingCompressionVideo, setPendingCompressionVideo] = useState<File | null>(null);
  const [pendingCompressionDecision, setPendingCompressionDecision] = useState<UploadDecision | null>(null);
  const [pendingUploadIndex, setPendingUploadIndex] = useState<number>(-1);
  const pendingValidFilesRef = useRef<File[]>([]);
  const uploadCancelledRef = useRef(false);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);

  const [aliyunConfigured, setAliyunConfigured] = useState(false);

  useEffect(() => {
    fetch('/api/video2/aliyun/status')
      .then(res => res.json())
      .then(data => setAliyunConfigured(data.configured || false))
      .catch(() => {});
  }, []);

  const refreshAfterUpload = useCallback(async () => {
    if (loadShots) await loadShots();
    if (loadStats) await loadStats();
    if (loadProject) await loadProject();
    onUploadComplete?.();
  }, [loadShots, loadStats, loadProject, onUploadComplete]);

  const handleUploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    const valid = list.filter(f => {
      const d = detectFileType(f);
      if (!d.supported) {
        showToast(`忽略不支持的文件：${f.name}`);
      }
      return d.supported;
    });
    if (valid.length === 0) return;

    const initial: UploadingFile[] = valid.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`,
      name: f.name, size: f.size, progress: 5, status: 'uploading'
    }));
    setUploadingFiles(initial);
    pendingValidFilesRef.current = valid;
    uploadCancelledRef.current = false;
    uploadAbortControllerRef.current = new AbortController();

    let stopped = false;
    for (let i = 0; i < valid.length; i++) {
      if (uploadCancelledRef.current) {
        setUploadingFiles(prev => prev.map((uf, idx) => idx >= i ? { ...uf, status: 'cancelled', progress: 0, message: '已取消' } : uf));
        break;
      }

      const file = valid[i];
      const detected = detectFileType(file);

      if (detected.type === 'video') {
        setUploadingFiles(prev => prev.map((uf, idx) => idx === i ? { ...uf, progress: 5, message: '检测视频信息...' } : uf));
        const decision = await checkVideoBitrate(file);
        if (decision.decision === 'must_compress') {
          setUploadingFiles(prev => prev.map((uf, idx) => {
            if (idx === i) {
              return { ...uf, status: 'error', progress: 0, message: '需选择压缩方式' };
            } else if (idx > i) {
              return { ...uf, status: 'pending', progress: 0, message: '等待中' };
            }
            return uf;
          }));
          setPendingCompressionVideo(file);
          setPendingCompressionDecision(decision);
          setPendingUploadIndex(i);
          stopped = true;
          break;
        }
      }

      try {
        if (detected.type === 'image') {
          await uploadVideo2Image(file, {
            projectId,
            sceneId: currentSceneId !== null ? currentSceneId : undefined,
            title: file.name,
            createShot: true,
            signal: uploadAbortControllerRef.current?.signal
          });
          setUploadingFiles(prev => prev.map((uf, idx) => idx === i ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
        } else {
          await uploadVideo2Video(file, {
            projectId,
            sceneId: currentSceneId !== null ? currentSceneId : undefined,
            title: file.name,
            createShot: true,
            compressionMethod: 'none',
            skipBitrateCheck: true,
            signal: uploadAbortControllerRef.current?.signal,
            onProgress: p => {
              setUploadingFiles(prev => prev.map((uf, idx) => idx === i ? { ...uf, progress: p.progress, message: p.message } : uf));
            }
          });
          setUploadingFiles(prev => prev.map((uf, idx) => idx === i ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
        }
      } catch (e) {
        if (uploadCancelledRef.current) {
          setUploadingFiles(prev => prev.map((uf, idx) => idx >= i ? { ...uf, status: 'cancelled', progress: 0, message: '已取消' } : uf));
          break;
        }
        console.error('上传失败:', file.name, e);
        setUploadingFiles(prev => prev.map((uf, idx) => idx === i ? { ...uf, status: 'error', message: (e as Error).message } : uf));
      }
    }

    if (!stopped && !uploadCancelledRef.current) {
      await refreshAfterUpload();
      showToast(`上传完成（${valid.length} 项）`);
    }

    uploadAbortControllerRef.current = null;
  }, [projectId, currentSceneId, showToast, refreshAfterUpload]);

  const cancelUpload = useCallback(() => {
    uploadCancelledRef.current = true;
    if (uploadAbortControllerRef.current) {
      uploadAbortControllerRef.current.abort();
    }
  }, []);

  const handleCompressionDecision = useCallback(async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
    if (!pendingCompressionVideo || !pendingCompressionDecision || pendingUploadIndex < 0) {
      setPendingCompressionVideo(null);
      setPendingCompressionDecision(null);
      setPendingUploadIndex(-1);
      return;
    }

    const videoFile = pendingCompressionVideo;
    const idx = pendingUploadIndex;

    setPendingCompressionVideo(null);
    setPendingCompressionDecision(null);
    setPendingUploadIndex(-1);

    if (method === 'cancel') {
      return;
    }

    setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, status: 'uploading', progress: 10, message: '准备上传...' } : uf));

    (async () => {
      try {
        await uploadVideo2Video(videoFile, {
          projectId,
          sceneId: currentSceneId !== null ? currentSceneId : undefined,
          title: videoFile.name,
          createShot: true,
          compressionMethod: method,
          skipBitrateCheck: true,
          onProgress: p => {
            setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, progress: p.progress, message: p.message } : uf));
          }
        });
        setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
        await refreshAfterUpload();
      } catch (e) {
        console.error('上传失败:', videoFile.name, e);
        setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, status: 'error', message: (e as Error).message } : uf));
      }
    })();
  }, [pendingCompressionVideo, pendingCompressionDecision, pendingUploadIndex, projectId, currentSceneId, refreshAfterUpload]);

  const handleUploadFromUrl = useCallback(async () => {
    const url = urlInputValue.trim();
    if (!url) return;
    const newItem: UploadingFile = {
      id: `${Date.now()}-url`,
      name: url.substring(0, 50) + '...',
      size: 0,
      progress: 20,
      status: 'uploading'
    };
    setUploadingFiles(prev => [...prev, newItem]);
    try {
      await uploadVideo2FromUrl(url, {
        projectId,
        sceneId: currentSceneId !== null ? currentSceneId : undefined,
        title: url
      });
      setUploadingFiles(prev => prev.map(uf => uf.id === newItem.id ? { ...uf, progress: 100, status: 'done', message: '转存完成' } : uf));
      setUrlInputValue('');
      await refreshAfterUpload();
    } catch (e) {
      setUploadingFiles(prev => prev.map(uf => uf.id === newItem.id ? { ...uf, status: 'error', message: String(e) } : uf));
    }
  }, [urlInputValue, projectId, currentSceneId, refreshAfterUpload]);

  const clearUploadingFiles = useCallback(() => {
    setUploadingFiles([]);
  }, []);

  return {
    uploadingFiles,
    setUploadingFiles,
    uploadTab,
    setUploadTab,
    urlInputValue,
    setUrlInputValue,
    urlError,
    setUrlError,
    pendingCompressionVideo,
    pendingCompressionDecision,
    handleUploadFiles,
    handleUploadFromUrl,
    cancelUpload,
    handleCompressionDecision,
    aliyunConfigured,
    clearUploadingFiles,
  };
}
