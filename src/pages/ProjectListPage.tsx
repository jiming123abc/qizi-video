import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Plus, Trash2, Share2, Film, HardDrive, ChevronRight, ChevronLeft, X, Play, Maximize2, Upload, Image as ImageIcon, Link2, CheckCircle2, XCircle, Info, Video } from 'lucide-react';
import { setupShareMetadata, copyToClipboard, isWeChat } from '../lib/shareUtils';
import { uploadVideo2Image, uploadVideo2Video, detectFileType, uploadVideo2FromUrl, checkVideoBitrate } from '../lib/ossUtils';
import { useSignedUrl } from '../hooks/useSignedUrl';
import type { UploadDecision } from '../lib/ossUtils';
import { ShareHint } from '../components/WeChatShareHint';
import { VideoCompressionDialog } from '../components/storyboard/VideoCompressionDialog';
import { MediaFullscreen } from '../components/storyboard/MediaFullscreen';
import { timeAgo, formatSize } from '../lib/utils';
import type { ShotMedia } from '../lib/types';

interface Project {
  id: number;
  name: string;
  description: string;
  coverUrl?: string;
  sortOrder: number;
  videoCount: number;
  totalSize: number;
  shareUrl: string;
  createdAt: string;
}

interface ReferenceItem {
  id: number;
  type: 'image' | 'video';
  url: string;
  title: string;
}

// 蓝紫渐变默认封面（与服务端一致）
const DEFAULT_COVER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#ec4899"/></linearGradient></defs><rect width="400" height="225" fill="url(#g)"/></svg>'
  );

// 从视频 URL 得到 OSS 截图 URL（仅用于参考素材是视频时的预览缩略图）
function getVideoPoster(url: string): string {
  if (url && (url.includes('aliyuncs.com') || url.includes('qiziwenhua.top'))) {
    return url + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
  }
  return '';
}

interface ProjectListPageProps {
  onSelectProject?: (projectId: number) => void;
}

export function ProjectListPage({ onSelectProject }: ProjectListPageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [projectStats, setProjectStats] = useState<Record<number, { done: number; pending: number; total: number }>>({});

  // 分享提示
  const [shareHintVisible, setShareHintVisible] = useState(false);
  const [shareHintMode, setShareHintMode] = useState<'wechat' | 'default'>('default');

  // 上传参考文件弹窗
  const [uploadDialogProject, setUploadDialogProject] = useState<Project | null>(null);
  const [uploadDialogTab, setUploadDialogTab] = useState<'file' | 'url'>('file');
  const [uploadDialogLoading, setUploadDialogLoading] = useState(false);
  const [uploadDialogUrl, setUploadDialogUrl] = useState('');
  const [uploadDialogMessage, setUploadDialogMessage] = useState('');

  // 视频压缩选择对话框
  const [pendingCompressionVideo, setPendingCompressionVideo] = useState<File | null>(null);
  const [pendingCompressionDecision, setPendingCompressionDecision] = useState<UploadDecision | null>(null);
  const pendingUploadRef = useRef<{ file: File; index: number; total: number; successCount: number; project: Project } | null>(null);

  // 阿里云配置状态
  const [aliyunConfigured, setAliyunConfigured] = useState(false);

  useEffect(() => {
    fetch('/api/video2/aliyun/status')
      .then(res => res.json())
      .then(data => setAliyunConfigured(data.configured || false))
      .catch(() => {});
  }, []);

  // 每个项目的参考文件缓存（含封面作为第一个元素）
  const [referencesCache, setReferencesCache] = useState<Record<number, ReferenceItem[]>>({});
  const [carouselIndex, setCarouselIndex] = useState<Record<number, number>>({});
  const [fullscreenItem, setFullscreenItem] = useState<ReferenceItem | null>(null);
  const [fullscreenProjectId, setFullscreenProjectId] = useState<number | null>(null);
  const [fullscreenTitle, setFullscreenTitle] = useState<string>('');
  const [signedMediaUrls, setSignedMediaUrls] = useState<Record<string, string>>({});
  const [cardPlayingProjectId, setCardPlayingProjectId] = useState<number | null>(null);
  const fullscreenVideoRef = useRef<HTMLVideoElement>(null);
  const cardVideoRef = useRef<HTMLVideoElement>(null);
  const signedFullscreenUrl = useSignedUrl(fullscreenItem?.url);
  const signedFullscreenPoster = useSignedUrl(fullscreenItem?.url ? getVideoPoster(fullscreenItem.url) : undefined);

  // 全屏弹窗打开时自动播放视频（通过 MediaFullscreen 组件的 autoPlay 处理）
  // fullscreenVideoRef 用于 MediaFullscreen 的 videoRefCallback

  const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  // 收集所有媒体 URL（含项目 coverUrl）并批量签名
  const signAllMediaUrls = useCallback(async () => {
    const urls: string[] = [];
    for (const refs of Object.values(referencesCache)) {
      for (const ref of refs) {
        if (ref.url) urls.push(ref.url);
        // 视频类型素材也需要对其海报 URL（带 x-oss-process）进行签名
        if (ref.type === 'video' && ref.url) {
          const poster = getVideoPoster(ref.url);
          if (poster && poster !== ref.url) urls.push(poster);
        }
      }
    }
    // 同时签名项目的 coverUrl
    for (const p of projects) {
      if (p.coverUrl) urls.push(p.coverUrl);
    }
    if (urls.length === 0) return;
    const { batchGetSignedUrls, getSignedUrlFromCache } = await import('../lib/ossUtils');
    const immediate: Record<string, string> = {};
    urls.forEach(u => { immediate[u] = getSignedUrlFromCache(u); });
    setSignedMediaUrls(prev => ({ ...prev, ...immediate }));
    batchGetSignedUrls(urls).then(() => {
      setSignedMediaUrls(prev => {
        const updated = { ...prev };
        urls.forEach(u => { updated[u] = getSignedUrlFromCache(u); });
        return updated;
      });
    });
  }, [referencesCache, projects]);

  // referencesCache 变化时批量签名（防抖，避免频繁触发）
  const signingRef = useRef(false);
  const signingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (signingRef.current) return;
    if (signingTimeoutRef.current) clearTimeout(signingTimeoutRef.current);
    signingTimeoutRef.current = setTimeout(() => {
      signingRef.current = true;
      // 过滤出需要签名的URL（非data:uri）
      const needsSigning: string[] = [];
      for (const refs of Object.values(referencesCache)) {
        for (const ref of refs) {
          if (ref.url && !ref.url.startsWith('data:')) {
            needsSigning.push(ref.url);
          }
        }
      }
      for (const p of projects) {
        if (p.coverUrl && !p.coverUrl.startsWith('data:')) {
          needsSigning.push(p.coverUrl);
        }
      }
      if (needsSigning.length > 0) {
        signAllMediaUrls().finally(() => {
          signingRef.current = false;
        });
      } else {
        signingRef.current = false;
      }
    }, 300);
    return () => {
      if (signingTimeoutRef.current) clearTimeout(signingTimeoutRef.current);
    };
  }, [referencesCache, projects, signAllMediaUrls]);

  // 加载某项目的参考文件（单个）
  const loadReferences = useCallback(async (projectId: number) => {
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/references`);
      const data = await res.json();
      const refs: ReferenceItem[] = (data.data || []).map((r: any) => ({
        id: r.id,
        type: r.type,
        url: r.url,
        title: r.title
      }));
      setReferencesCache(prev => ({ ...prev, [projectId]: refs }));
    } catch (e) {
      console.error('加载参考文件失败:', e);
    }
  }, []);

  // 批量加载所有项目的参考文件（一次请求获取所有）
  const loadAllReferences = useCallback(async (projectIds: number[]) => {
    if (projectIds.length === 0) return;
    try {
      const idsParam = projectIds.join(',');
      const res = await fetch(`/api/video2/projects/references/batch?ids=${idsParam}`);
      const data = await res.json();
      if (data.success && data.data) {
        setReferencesCache(prev => {
          const next = { ...prev };
          for (const [pid, refs] of Object.entries(data.data)) {
            const projectId = Number(pid);
            const refList: ReferenceItem[] = ((refs as any[]) || []).map((r: any) => ({
              id: r.id,
              type: r.type,
              url: r.url,
              title: r.title
            }));
            if (next[projectId] === undefined) {
              next[projectId] = refList;
            }
          }
          return next;
        });
      }
    } catch (e) {
      console.error('批量加载参考文件失败:', e);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/video2/projects');
      const data = await res.json();
      if (data.success) {
        setProjects(data.data);
        const ids = (data.data || []).map((p: Project) => p.id);
        
        // 批量获取统计数据
        ids.forEach(id => {
          fetch(`/api/video2/stats?projectId=${id}`)
            .then(r => r.json())
            .then(d => {
              if (d.success) {
                setProjectStats(prev => ({ ...prev, [id]: d.data }));
              }
            })
            .catch(() => {});
        });
        
        // 批量加载所有项目的参考文件（一次请求）
        if (ids.length > 0) {
          loadAllReferences(ids);
        }
      }
    } catch (e) {
      console.error('加载项目列表失败:', e);
    } finally {
      setLoading(false);
    }
  }, [loadAllReferences]);

  useEffect(() => {
    loadProjects();
    setupShareMetadata({
      title: '柒子文化AI拍摄辅助系统',
      desc: '专业的视频拍摄管理工具，帮助团队高效管理拍摄素材',
      link: window.location.href,
      imgUrl: '/images/hero-home.png'
    });
    document.title = '柒子文化AI拍摄辅助系统';
  }, [loadProjects]);

  // 删除项目参考文件
  const deleteReference = useCallback(async (projectId: number, itemId: number) => {
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/references/${itemId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setReferencesCache(prev => ({
          ...prev,
          [projectId]: (prev[projectId] || []).filter(item => item.id !== itemId)
        }));
        // 同步刷新项目列表（封面可能需要清除）
        loadProjects();
        showToast('参考素材已删除');
      }
    } catch (e) {
      console.error('删除参考文件失败:', e);
      showToast('删除失败', 'error');
    }
  }, [loadProjects, showToast]);

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreateLoading(true);
    try {
      const res = await fetch('/api/video2/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName.trim(),
          description: createDesc.trim(),
          coverUrl: DEFAULT_COVER
        })
      });
      const data = await res.json();
      if (data.success) {
        setShowCreateModal(false);
        setCreateName('');
        setCreateDesc('');
        await loadProjects();
        showToast('项目创建成功');
      } else {
        showToast(data.message || '创建失败，请重试', 'error');
      }
    } catch (e) {
      console.error('创建项目失败:', e);
      showToast('创建失败，请检查网络连接', 'error');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/video2/projects/${deleteTarget.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setProjects(prev => prev.filter(p => p.id !== deleteTarget.id));
        setDeleteTarget(null);
        showToast('项目已删除');
      }
    } catch (e) {
      console.error('删除项目失败:', e);
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleShare = async (project: Project) => {
    const shareUrl = project.shareUrl || `${window.location.origin}/share/video2/project/${project.id}`;
    setupShareMetadata({
      title: project.name,
      desc: project.description || '柒子文化AI拍摄辅助系统 - 专业项目管理',
      link: shareUrl,
      imgUrl: project.coverUrl || DEFAULT_COVER
    });
    await copyToClipboard(shareUrl);
    const inWeChat = typeof isWeChat === 'function' ? isWeChat() : false;
    setShareHintMode(inWeChat ? 'wechat' : 'default');
    setShareHintVisible(true);
  };

  const handleExport = (project: Project) => {
    // 导出分镜脚本
    window.open(`/api/video2/projects/${project.id}/export?format=docx&includeImages=true`, '_blank');
  };

  const openUploadDialog = (project: Project) => {
    setUploadDialogProject(project);
    setUploadDialogTab('file');
    setUploadDialogMessage('');
    setUploadDialogUrl('');
    if (!referencesCache[project.id]) {
      loadReferences(project.id);
    }
  };

  // 调用「设置项目封面」API，并本地乐观更新
  const setProjectCover = async (projectId: number, coverUrl: string) => {
    try {
      await fetch(`/api/video2/projects/${projectId}/cover`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverUrl })
      });
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, coverUrl } : p));
    } catch (e) {
      console.error('设置封面失败:', e);
    }
  };

  const deleteProjectCover = async (projectId: number) => {
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/cover`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setProjects(prev => prev.map(p => p.id === projectId ? { ...p, coverUrl: DEFAULT_COVER } : p));
        showToast('封面已删除');
      }
    } catch (e) {
      console.error('删除封面失败:', e);
      showToast('删除失败', 'error');
    }
  };

  const handleCoverImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !uploadDialogProject) return;
    
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      showToast('请选择图片文件', 'error');
      e.target.value = '';
      return;
    }
    
    const file = imageFiles[0];
    const project = uploadDialogProject;
    setUploadDialogLoading(true);
    setUploadDialogMessage('正在上传封面...');

    try {
      const result = await uploadVideo2Image(file, {
        projectId: project.id,
        reference: true,
        title: file.name,
        usage: 'project-cover'
      });
      if (result.url) {
        await setProjectCover(project.id, result.url);
        setUploadDialogMessage('封面设置成功');
      }
    } catch (err: any) {
      console.error('封面上传失败:', err);
      showToast(err.message || '封面上传失败，请重试', 'error');
      setUploadDialogMessage('上传失败');
    }

    setUploadDialogLoading(false);
    setTimeout(() => setUploadDialogMessage(''), 3000);
    e.target.value = '';
  };

  const handleReferenceVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !uploadDialogProject) return;
    
    const videoFiles = Array.from(files).filter(f => f.type.startsWith('video/'));
    if (videoFiles.length === 0) {
      showToast('请选择视频文件', 'error');
      e.target.value = '';
      return;
    }
    
    setUploadDialogLoading(true);
    setUploadDialogMessage(`正在上传 0 / ${videoFiles.length}`);

    let successCount = 0;
    const project = uploadDialogProject;
    let stopped = false;

    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      try {
        setUploadDialogMessage(`视频 ${i + 1}/${videoFiles.length}: 检测视频信息...`);
        const decision = await checkVideoBitrate(file);
        if (decision.decision === 'must_compress') {
          pendingUploadRef.current = { file, index: i, total: videoFiles.length, successCount, project, usage: 'project-reference' } as any;
          setPendingCompressionVideo(file);
          setPendingCompressionDecision(decision);
          setUploadDialogMessage(`视频 ${i + 1}/${videoFiles.length}: 需选择压缩方式`);
          stopped = true;
          break;
        }
        await uploadVideo2Video(file, {
          projectId: project.id,
          reference: true,
          title: file.name,
          usage: 'project-reference',
          skipBitrateCheck: true,
          onProgress: p => {
            setUploadDialogMessage(`视频 ${i + 1}/${videoFiles.length}: ${p.message} (${p.progress}%)`);
          }
        });
        successCount++;
        setUploadDialogMessage(`已上传 ${successCount} / ${videoFiles.length}`);
      } catch (err: any) {
        console.error('上传失败:', err);
        showToast(err.message || '上传失败，请重试', 'error');
      }
    }

    if (!stopped) {
      await loadReferences(project.id);
      setUploadDialogMessage(`完成：成功 ${successCount}`);
      setUploadDialogLoading(false);
      setTimeout(() => setUploadDialogMessage(''), 3000);
      e.target.value = '';
    }
  };

  const handleReferenceUrlUpload = async () => {
    const url = uploadDialogUrl.trim();
    if (!url || !uploadDialogProject) return;

    setUploadDialogLoading(true);
    setUploadDialogMessage('正在转存...');
    const project = uploadDialogProject;

    try {
      const res = await fetch(`/api/video2/projects/${project.id}/references/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (data.success) {
        await loadReferences(project.id);
        setUploadDialogMessage('转存成功');
        setUploadDialogUrl('');
      } else {
        throw new Error(data.error || '转存失败');
      }
    } catch (err: any) {
      console.error('URL转存失败:', err);
      showToast(err.message || '转存失败，请重试', 'error');
      setUploadDialogMessage('转存失败');
    }

    setUploadDialogLoading(false);
    setTimeout(() => setUploadDialogMessage(''), 3000);
  };

  const isDefaultCover = (coverUrl: string) => {
    return !coverUrl || coverUrl.startsWith('data:image/svg+xml');
  };

  const hasUserCover = (projectId: number) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return false;
    return !isDefaultCover(project.coverUrl);
  };

  const handleFileUploadToProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !uploadDialogProject) return;
    
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length > 1) {
      showToast('封面图片最多只能上传1张', 'error');
      e.target.value = '';
      return;
    }
    
    setUploadDialogLoading(true);
    setUploadDialogMessage(`正在上传 0 / ${files.length}`);

    let successCount = 0;
    let firstUploadedUrl: string | null = null;
    let firstUploadedType: 'image' | 'video' | null = null;
    const project = uploadDialogProject;
    let stopped = false;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const detected = detectFileType(file);
      if (!detected.supported) {
        continue;
      }
      try {
        if (detected.type === 'image') {
          const result = await uploadVideo2Image(file, {
            projectId: project.id,
            reference: true,
            title: file.name
          });
          if (result.url) {
            await setProjectCover(project.id, result.url);
          }
          if (!firstUploadedUrl) {
            firstUploadedUrl = result.url || '';
            firstUploadedType = 'image';
          }
        } else {
          setUploadDialogMessage(`视频 ${i + 1}/${files.length}: 检测视频信息...`);
          const decision = await checkVideoBitrate(file);
          if (decision.decision === 'must_compress') {
            pendingUploadRef.current = { file, index: i, total: files.length, successCount, project };
            setPendingCompressionVideo(file);
            setPendingCompressionDecision(decision);
            setUploadDialogMessage(`视频 ${i + 1}/${files.length}: 需选择压缩方式`);
            stopped = true;
            break;
          }
          await uploadVideo2Video(file, {
            projectId: project.id,
            reference: true,
            title: file.name,
            skipBitrateCheck: true,
            onProgress: p => {
              setUploadDialogMessage(`视频 ${i + 1}/${files.length}: ${p.message} (${p.progress}%)`);
            }
          });
          if (!firstUploadedUrl) firstUploadedType = 'video';
        }
        successCount++;
        setUploadDialogMessage(`已上传 ${successCount} / ${files.length}`);
      } catch (err: any) {
        console.error('上传失败:', err);
        showToast(err.message || '上传失败，请重试', 'error');
      }
    }

    if (!stopped) {
      await loadReferences(project.id);
      const newRefs = referencesCache[project.id] || [];
      const videoRefs = newRefs.filter(r => r.type === 'video');
      if (newRefs.length > 0 && !project.coverUrl) {
        const first = newRefs[0];
        const coverUrl = first.type === 'video' ? getVideoPoster(first.url) || first.url : first.url;
        await setProjectCover(project.id, coverUrl);
      }
      setUploadDialogMessage(`完成：成功 ${successCount}`);
      setUploadDialogLoading(false);
      setTimeout(() => setUploadDialogMessage(''), 3000);
      e.target.value = '';
    }
  };

  const handleCompressionSelect = async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
    const pending = pendingUploadRef.current;
    const videoFile = pendingCompressionVideo;
    const decision = pendingCompressionDecision;

    setPendingCompressionVideo(null);
    setPendingCompressionDecision(null);
    pendingUploadRef.current = null;

    if (method === 'cancel' || !pending || !videoFile || !decision) {
      setUploadDialogLoading(false);
      setUploadDialogMessage('已取消');
      setTimeout(() => setUploadDialogMessage(''), 3000);
      return;
    }

    const { file, index, total, successCount, project } = pending;
    let currentSuccess = successCount;
    const usage = (pending as any).usage || 'project-reference';

    try {
      await uploadVideo2Video(file, {
        projectId: project.id,
        reference: true,
        title: file.name,
        compressionMethod: method,
        usage,
        skipBitrateCheck: true,
        onProgress: p => {
          setUploadDialogMessage(`视频 ${index + 1}/${total}: ${p.message} (${p.progress}%)`);
        }
      });
      currentSuccess++;
      setUploadDialogMessage(`已上传 ${currentSuccess} / ${total}`);

      for (let i = index + 1; i < total; i++) {
        const nextFile = (document.querySelector('input[type="file"][accept*="video"]') as HTMLInputElement)?.files?.[i];
        if (!nextFile) continue;
        const detected = detectFileType(nextFile);
        if (!detected.supported || detected.type !== 'video') continue;

        try {
          setUploadDialogMessage(`视频 ${i + 1}/${total}: 检测视频信息...`);
          const nextDecision = await checkVideoBitrate(nextFile);
          if (nextDecision.decision === 'must_compress') {
            pendingUploadRef.current = { file: nextFile, index: i, total, successCount: currentSuccess, project, usage } as any;
            setPendingCompressionVideo(nextFile);
            setPendingCompressionDecision(nextDecision);
            setUploadDialogMessage(`视频 ${i + 1}/${total}: 需选择压缩方式`);
            return;
          }
          await uploadVideo2Video(nextFile, {
            projectId: project.id,
            reference: true,
            title: nextFile.name,
            usage,
            skipBitrateCheck: true,
            onProgress: p => {
              setUploadDialogMessage(`视频 ${i + 1}/${total}: ${p.message} (${p.progress}%)`);
            }
          });
          currentSuccess++;
          setUploadDialogMessage(`已上传 ${currentSuccess} / ${total}`);
        } catch (err: any) {
          console.error('上传失败:', err);
          showToast(err.message || '上传失败，请重试', 'error');
        }
      }

      await loadReferences(project.id);
      setUploadDialogMessage(`完成：成功 ${currentSuccess}`);
      setUploadDialogLoading(false);
      setTimeout(() => setUploadDialogMessage(''), 3000);
      const fileInput = document.querySelector('input[type="file"][accept*="video"]') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
    } catch (err: any) {
      console.error('压缩上传失败:', err);
      setUploadDialogMessage('失败：' + (err.message || '压缩上传失败'));
      setUploadDialogLoading(false);
      showToast(err.message || '上传失败，请重试', 'error');
    }
  };

  const handleUrlUploadToProject = async () => {
    if (!uploadDialogUrl.trim() || !uploadDialogProject) return;
    setUploadDialogLoading(true);
    setUploadDialogMessage('正在从 URL 抓取文件...');
    try {
      await uploadVideo2FromUrl(uploadDialogUrl.trim(), {
        projectId: uploadDialogProject.id,
        reference: true,
        title: 'URL 文件'
      });
      await loadReferences(uploadDialogProject.id);
      const newRefs = referencesCache[uploadDialogProject.id] || [];
      if (newRefs.length > 0 && !uploadDialogProject.coverUrl) {
        const first = newRefs[0];
        const coverUrl = first.type === 'video' ? getVideoPoster(first.url) || first.url : first.url;
        await setProjectCover(uploadDialogProject.id, coverUrl);
      }
      setUploadDialogMessage('转存成功');
      setUploadDialogUrl('');
    } catch (err) {
      console.error('URL 转存失败:', err);
      setUploadDialogMessage('转存失败，请检查链接是否可公开访问');
    } finally {
      setUploadDialogLoading(false);
      setTimeout(() => setUploadDialogMessage(''), 3000);
    }
  };

  const goToProject = (id: number) => {
    if (onSelectProject) {
      onSelectProject(id);
    } else {
      window.location.href = `/video2/project/${id}`;
    }
  };

  // 更新项目名称
  const updateProjectName = async (projectId: number, name: string) => {
    const n = name.trim();
    if (!n) return;
    try {
      await fetch(`/api/video2/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n })
      });
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, name: n } : p));
    } catch (e) {
      console.error('更新项目名称失败:', e);
    }
  };

  // 更新项目描述
  const updateProjectDescription = async (projectId: number, description: string) => {
    try {
      await fetch(`/api/video2/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description })
      });
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, description } : p));
    } catch (e) {
      console.error('更新项目描述失败:', e);
    }
  };

  // 轮播：封面 + reference 合并为一个展示列表（避免重复）
  // 只有当封面是真实的URL（非data:uri）时才显示
  const buildMediaList = (project: Project): ReferenceItem[] => {
    const refs = referencesCache[project.id] || [];
    const videoRefs = refs.filter(r => r.type === 'video');
    const hasUserCover = !isDefaultCover(project.coverUrl);
    
    const media: ReferenceItem[] = [];
    
    if (hasUserCover) {
      media.push({ id: -1, type: 'image', url: project.coverUrl, title: '封面' });
    }
    
    for (const ref of videoRefs) {
      media.push(ref);
    }
    
    return media;
  };

  const moveCarousel = (projectId: number, dir: 1 | -1) => {
    // 先暂停当前播放的视频
    if (cardVideoRef.current) {
      cardVideoRef.current.pause();
    }
    setCardPlayingProjectId(null);

    const media = buildMediaList(projects.find(p => p.id === projectId) || { id: projectId } as Project);
    if (media.length <= 1) return;
    const current = carouselIndex[projectId] || 0;
    const next = (current + dir + media.length) % media.length;
    setCarouselIndex(prev => ({ ...prev, [projectId]: next }));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-violet-950 to-pink-950 text-white">
      <div className="sticky top-0 z-30 backdrop-blur-xl bg-slate-900/70 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-violet-300 via-pink-300 to-fuchsia-300 bg-clip-text text-transparent leading-tight">
              柒子文化<span className="sm:hidden"><br /></span>AI拍摄辅助系统
            </h1>
            <p className="text-sm text-slate-400 mt-0.5 hidden sm:block">项目管理 · 多场景素材统筹</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-full border border-violet-400/40 bg-white/5 hover:bg-violet-500/20 hover:border-violet-400/70 text-sm font-medium transition-all"
          >
            <Plus className="w-4 h-4 text-violet-300" />
            <span>新建项目</span>
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {loading && <div className="text-center py-12 text-slate-400">加载中...</div>}

        {!loading && projects.length === 0 && (
          <div className="py-20 border border-dashed border-white/15 rounded-3xl bg-white/[0.02] text-center">
            <Film className="w-12 h-12 mx-auto mb-4 text-violet-300/60" />
            <p className="text-lg mb-2">还没有项目</p>
            <p className="text-sm text-slate-400 mb-6">点击右上角「新建项目」创建第一个项目</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-5 py-2.5 rounded-full border border-violet-400/40 bg-violet-500/20 hover:bg-violet-500/30 text-sm font-medium transition-all"
            >
              <Plus className="w-4 h-4 inline mr-1.5" />创建项目
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map(project => {
            const mediaList = buildMediaList(project);
            const currentIdx = carouselIndex[project.id] || 0;
            const hasMultiple = mediaList.length > 1;
            const current = mediaList[currentIdx] || null;

            return (
              <div
                key={project.id}
                className="group relative rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl overflow-hidden hover:border-violet-400/30 hover:shadow-2xl hover:shadow-violet-500/20 transition-all"
              >
                {/* 常驻右上角按钮：分享、导出、删除 */}
                <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleExport(project); }}
                    title="导出分镜脚本"
                    className="w-9 h-9 rounded-full border border-white/20 bg-white/5 backdrop-blur hover:bg-gradient-to-br hover:from-emerald-500 hover:to-teal-500 hover:border-transparent transition-all flex items-center justify-center"
                  >
                    <svg className="w-4 h-4 text-white/90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleShare(project); }}
                    title="分享项目"
                    className="w-9 h-9 rounded-full border border-white/20 bg-white/5 backdrop-blur hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent transition-all flex items-center justify-center"
                  >
                    <Share2 className="w-4 h-4 text-white/90" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(project); }}
                    title="删除项目"
                    className="w-9 h-9 rounded-full border border-white/20 bg-white/5 backdrop-blur hover:bg-red-500/30 hover:border-red-400/50 transition-all flex items-center justify-center"
                  >
                    <Trash2 className="w-4 h-4 text-white/90" />
                  </button>
                </div>

                {/* 封面/参考媒体区（轮播预览） */}
                <div
                  className="relative aspect-[16/10] overflow-hidden bg-black/30"
                >
                  {(() => {
                    const isCardPlaying = cardPlayingProjectId === project.id;
                    if (current && current.type === 'video' && isCardPlaying) {
                      const videoSrc = signedMediaUrls[current.url] || current.url;
                      return (
                        <video
                          ref={cardPlayingProjectId === project.id ? cardVideoRef : undefined}
                          src={videoSrc}
                          className="w-full h-full object-cover cursor-pointer"
                          playsInline
                          onClick={(e) => {
                            e.stopPropagation();
                            if (cardVideoRef.current) {
                              cardVideoRef.current.pause();
                            }
                            setCardPlayingProjectId(null);
                          }}
                        />
                      );
                    }
                    let mediaSrc = DEFAULT_COVER;
                    let fallbackSrc = '';
                    if (current && current.url) {
                      if (current.type === 'video') {
                        const posterUrl = getVideoPoster(current.url);
                        if (posterUrl) {
                          mediaSrc = signedMediaUrls[posterUrl] || posterUrl;
                          fallbackSrc = posterUrl;
                        } else {
                          mediaSrc = signedMediaUrls[current.url] || current.url;
                          fallbackSrc = current.url;
                        }
                      } else {
                        mediaSrc = signedMediaUrls[current.url] || current.url;
                        fallbackSrc = current.url;
                      }
                    }
                    return (
                      <img
                        src={mediaSrc}
                        alt={project.name}
                        className="w-full h-full object-cover cursor-pointer"
                        onClick={() => goToProject(project.id)}
                        onError={(ev) => {
                          const img = ev.target as HTMLImageElement;
                          if (fallbackSrc && img.src !== fallbackSrc && img.src !== DEFAULT_COVER) {
                            img.src = fallbackSrc;
                          } else if (img.src !== DEFAULT_COVER) {
                            img.src = DEFAULT_COVER;
                          }
                        }}
                      />
                    );
                  })()}

                  {/* 底部渐变遮罩，增强文字对比度 */}
                  <div
                    className="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-slate-900/10 to-transparent"
                    onClick={() => goToProject(project.id)}
                  />

                  {/* 视频条目：点击播放按钮在卡片内播放视频 */}
                  {current && current.type === 'video' && cardPlayingProjectId !== project.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setCardPlayingProjectId(project.id);
                      }}
                      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20"
                    >
                      <div className="w-14 h-14 rounded-full border-2 border-white/70 bg-black/40 backdrop-blur flex items-center justify-center hover:from-violet-500 hover:to-fuchsia-500 hover:bg-gradient-to-br transition">
                        <Play className="w-6 h-6 text-white fill-white ml-0.5" />
                      </div>
                    </button>
                  )}

                  {/* 左右切换按钮（仅当有多个媒体时） */}
                  {hasMultiple && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); moveCarousel(project.id, -1); }}
                        className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full border border-white/25 bg-black/50 hover:bg-white/20 flex items-center justify-center transition"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); moveCarousel(project.id, 1); }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full border border-white/25 bg-black/50 hover:bg-white/20 flex items-center justify-center transition"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </>
                  )}

                  {/* 圆点指示器（仅当有多个媒体时） */}
                  {hasMultiple && (
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10">
                      {mediaList.map((_, i) => (
                        <button
                          key={i}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (cardVideoRef.current) {
                              cardVideoRef.current.pause();
                            }
                            setCardPlayingProjectId(null);
                            setCarouselIndex(prev => ({ ...prev, [project.id]: i }));
                          }}
                          className={`rounded-full transition-all ${i === currentIdx ? 'w-4 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/40 hover:bg-white/70'}`}
                        />
                      ))}
                    </div>
                  )}

                  {/* 右下：全屏预览（有封面或参考视频时显示） */}
                  {mediaList.length > 0 && current && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setFullscreenItem(current);
                        setFullscreenProjectId(project.id);
                        setFullscreenTitle(project.name);
                      }}
                      className="absolute bottom-3 right-3 z-30 w-9 h-9 rounded-full border border-white/25 bg-black/50 backdrop-blur hover:bg-white/15 flex items-center justify-center transition"
                      title="全屏预览"
                    >
                      <Maximize2 className="w-4 h-4 text-white/90" />
                    </button>
                  )}
                </div>

                {/* 信息区 */}
                <div className="relative p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        defaultValue={project.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const v = e.currentTarget.value.trim();
                          if (v && v !== project.name) updateProjectName(project.id, v);
                          else if (!v) e.currentTarget.value = project.name;
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                          if (e.key === 'Escape' && project.name) (e.currentTarget as HTMLInputElement).value = project.name;
                        }}
                        className="w-full text-lg font-semibold bg-transparent border-b border-transparent hover:border-white/20 focus:border-violet-400/60 outline-none py-0.5 transition cursor-text truncate"
                        title="点击编辑项目名称"
                      />
                      <textarea
                        defaultValue={project.description || ''}
                        placeholder="点击添加描述..."
                        rows={2}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const v = e.currentTarget.value.trim();
                          if (v !== project.description) updateProjectDescription(project.id, v);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.currentTarget as HTMLTextAreaElement).blur();
                          if (e.key === 'Escape' && project.description) (e.currentTarget as HTMLTextAreaElement).value = project.description;
                        }}
                        className="w-full text-sm text-slate-400 bg-transparent border-b border-transparent hover:border-white/20 focus:border-violet-400/60 outline-none py-0.5 mt-1 line-clamp-2 transition cursor-text resize-none"
                        title="点击编辑项目描述"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                    {(() => {
                      const st = projectStats[project.id];
                      if (st && st.total > 0) {
                        const pct = Math.round((st.done / st.total) * 100);
                        const R = 8;
                        const C = 2 * Math.PI * R;
                        const offset = C * (1 - pct / 100);
                        return (
                          <span className="inline-flex items-center gap-1.5">
                            <svg width="18" height="18" viewBox="0 0 20 20">
                              <circle cx="10" cy="10" r={R} stroke="rgba(255,255,255,0.1)" strokeWidth="2.5" fill="none" />
                              <circle cx="10" cy="10" r={R} stroke="url(#progGrad)" strokeWidth="2.5" fill="none"
                                strokeDasharray={C} strokeDashoffset={offset} strokeLinecap="round"
                                transform="rotate(-90 10 10)" />
                              <defs>
                                <linearGradient id="progGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                  <stop offset="0%" stopColor="#8b5cf6" />
                                  <stop offset="100%" stopColor="#ec4899" />
                                </linearGradient>
                              </defs>
                            </svg>
                            {st.done}/{st.total} 已拍摄
                          </span>
                        );
                      }
                      return (
                        <span className="inline-flex items-center gap-1">
                          <Film className="w-3.5 h-3.5" /> {project.videoCount} 项
                        </span>
                      );
                    })()}
                    <span className="inline-flex items-center gap-1">
                      <HardDrive className="w-3.5 h-3.5" /> {formatSize(project.totalSize)}
                    </span>
                    <span className="ml-auto">{timeAgo(project.createdAt)}</span>
                  </div>

                  {/* 底部按钮：上传参考视频 / 设置封面 */}
                  <button
                    onClick={(e) => { e.stopPropagation(); openUploadDialog(project); }}
                    title="上传图片或视频作为项目封面 / 参考素材"
                    className="mt-3 w-full py-2.5 rounded-2xl border border-violet-400/30 bg-violet-500/10 hover:bg-violet-500/25 hover:border-violet-400/50 transition-all text-sm font-medium inline-flex items-center justify-center gap-2 text-violet-200"
                  >
                    <Upload className="w-4 h-4" />
                    <span>上传参考视频 / 设置封面</span>
                  </button>

                  {/* 打开项目按钮 */}
                  <button
                    onClick={() => goToProject(project.id)}
                    className="mt-2 w-full py-2 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 transition-all text-sm text-slate-300 inline-flex items-center justify-center gap-2"
                  >
                    <ChevronRight className="w-4 h-4" />
                    <span>打开项目</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 新建项目弹窗 */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => !createLoading && setShowCreateModal(false)}>
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold">新建项目</h2>
              <button onClick={() => setShowCreateModal(false)} className="w-9 h-9 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2 text-slate-300">项目名称</label>
                <input
                  type="text"
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  placeholder="例如：宣传片 2026 春季"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm transition"
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2 text-slate-300">描述（可选）</label>
                <textarea
                  value={createDesc}
                  onChange={e => setCreateDesc(e.target.value)}
                  rows={3}
                  placeholder="简单描述项目用途、客户信息等"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm resize-none transition"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={!createName.trim() || createLoading}
                className="px-5 py-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {createLoading ? '创建中...' : '创建项目'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => !deleteLoading && setDeleteTarget(null)}>
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="w-14 h-14 mx-auto rounded-full bg-red-500/15 border border-red-400/30 flex items-center justify-center mb-4">
              <Trash2 className="w-6 h-6 text-red-400" />
            </div>
            <h2 className="text-center text-lg font-semibold mb-1.5">删除项目</h2>
            <p className="text-center text-sm text-slate-400 mb-1">确定要删除「{deleteTarget.name}」吗？</p>
            <p className="text-center text-xs text-slate-500 mb-5">{deleteTarget.videoCount} 个视频 · {formatSize(deleteTarget.totalSize)} — 删除后无法恢复</p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleteLoading}
                className="px-5 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteLoading}
                className="px-5 py-2 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-medium disabled:opacity-50 transition"
              >
                {deleteLoading ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 上传参考文件对话框 */}
      {uploadDialogProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => !uploadDialogLoading && setUploadDialogProject(null)}>
          <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-semibold">项目封面与参考视频</h2>
                <p className="text-xs text-slate-400 mt-0.5">「{uploadDialogProject.name}」</p>
              </div>
              <button onClick={() => !uploadDialogLoading && setUploadDialogProject(null)} className="w-9 h-9 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 封面设置区 */}
            <div className="mb-6 p-4 rounded-2xl bg-white/[0.03] border border-white/10">
              <h3 className="text-sm font-medium mb-3 text-slate-200 flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-violet-400" />
                项目封面
              </h3>
              
              <div className="flex gap-4 items-start">
                {/* 封面预览 */}
                <div className="w-32 h-20 rounded-xl overflow-hidden border border-white/10 bg-black/30 flex-shrink-0">
                  {!isDefaultCover(uploadDialogProject.coverUrl) ? (
                    <img 
                      src={signedMediaUrls[uploadDialogProject.coverUrl] || uploadDialogProject.coverUrl} 
                      alt="封面" 
                      className="w-full h-full object-cover" 
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-500">
                      <ImageIcon className="w-8 h-8" />
                    </div>
                  )}
                </div>
                
                {/* 操作按钮 */}
                <div className="flex-1 space-y-2">
                  <label className="block w-full">
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleCoverImageUpload}
                      disabled={uploadDialogLoading}
                    />
                    <div className={`w-full py-2 text-center text-sm rounded-xl cursor-pointer transition ${uploadDialogLoading ? 'bg-white/5 text-slate-500 cursor-not-allowed' : 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white hover:opacity-90'}`}>
                      <Upload className="w-4 h-4 inline mr-1.5" />
                      {!isDefaultCover(uploadDialogProject.coverUrl) ? '更换封面' : '上传封面'}
                    </div>
                  </label>
                  {!isDefaultCover(uploadDialogProject.coverUrl) && (
                    <button
                      onClick={() => deleteProjectCover(uploadDialogProject.id)}
                      disabled={uploadDialogLoading}
                      className="w-full py-2 text-sm rounded-xl bg-white/5 text-slate-300 hover:bg-white/10 hover:text-red-400 transition disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4 inline mr-1.5" />
                      删除封面
                    </button>
                  )}
                  <p className="text-xs text-slate-500 mt-1">
                    仅支持单张图片 (jpg, png, webp, gif)
                  </p>
                </div>
              </div>
            </div>

            {/* 参考视频区 */}
            <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/10">
              <h3 className="text-sm font-medium mb-3 text-slate-200 flex items-center gap-2">
                <Video className="w-4 h-4 text-violet-400" />
                参考视频
              </h3>

              {/* 上传方式切换 */}
              <div className="flex gap-2 mb-3 bg-white/5 p-1 rounded-xl">
                <button
                  onClick={() => setUploadDialogTab('file')}
                  className={`flex-1 py-1.5 text-xs rounded-lg transition ${uploadDialogTab === 'file' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  <Upload className="w-3.5 h-3.5 inline mr-1" />选择文件
                </button>
                <button
                  onClick={() => setUploadDialogTab('url')}
                  className={`flex-1 py-1.5 text-xs rounded-lg transition ${uploadDialogTab === 'url' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  <Link2 className="w-3.5 h-3.5 inline mr-1" />网络 URL
                </button>
              </div>

              {uploadDialogTab === 'file' ? (
                <div>
                  <label className="block border-2 border-dashed border-white/15 hover:border-violet-400/40 rounded-xl p-5 text-center cursor-pointer transition bg-white/[0.02]">
                    <input
                      type="file"
                      multiple
                      accept="video/*"
                      className="hidden"
                      onChange={handleReferenceVideoUpload}
                      disabled={uploadDialogLoading}
                    />
                    <Video className="w-8 h-8 mx-auto mb-2 text-violet-300/60" />
                    <p className="text-sm font-medium mb-1">点击选择视频文件</p>
                    <p className="text-xs text-slate-500">支持 mp4, webm 等视频格式</p>
                  </label>
                  <p className="text-xs text-slate-500 mt-2">
                    提示：高码率视频需选择压缩方式
                  </p>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      type="text"
                      value={uploadDialogUrl}
                      onChange={e => setUploadDialogUrl(e.target.value)}
                      placeholder="https://example.com/video.mp4"
                      className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm transition"
                      onKeyDown={e => e.key === 'Enter' && handleReferenceUrlUpload()}
                      disabled={uploadDialogLoading}
                    />
                    <button
                      onClick={handleReferenceUrlUpload}
                      disabled={!uploadDialogUrl.trim() || uploadDialogLoading}
                      className="px-4 py-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 transition"
                    >转存</button>
                  </div>
                  <p className="text-xs text-slate-500">链接必须是公开可访问的视频地址</p>
                </div>
              )}

              {/* 已上传参考视频列表 */}
              {referencesCache[uploadDialogProject.id] && referencesCache[uploadDialogProject.id]!.filter(r => r.type === 'video').length > 0 && (
                <div className="mt-4">
                  <h4 className="text-xs font-medium mb-2 text-slate-400">已上传视频（{referencesCache[uploadDialogProject.id]!.filter(r => r.type === 'video').length}）</h4>
                  <div className="grid grid-cols-3 gap-2 max-h-40 overflow-y-auto">
                    {referencesCache[uploadDialogProject.id]!.filter(r => r.type === 'video').map(item => (
                      <div key={item.id} className="relative aspect-video rounded-lg overflow-hidden border border-white/10 bg-black/30 group">
                        <img src={signedMediaUrls[getVideoPoster(item.url)] || getVideoPoster(item.url) || item.url} alt={item.title} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Play className="w-5 h-5 text-white drop-shadow-lg" />
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteReference(uploadDialogProject.id, item.id); }}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500/80 hover:bg-red-500 flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                          title="删除"
                        >
                          <X className="w-3 h-3 text-white" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {uploadDialogMessage && (
              <div className="mt-4 text-sm text-center text-violet-200 bg-violet-500/10 border border-violet-400/20 rounded-xl py-2.5">
                {uploadDialogMessage}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 全屏预览弹窗 */}
      <MediaFullscreen
        isOpen={fullscreenItem !== null}
        onClose={() => {
          setFullscreenItem(null);
          setFullscreenProjectId(null);
        }}
        mediaType={fullscreenItem?.type || 'image'}
        mediaUrl={fullscreenItem?.url || ''}
        filename={fullscreenTitle || fullscreenItem?.title}
        mediaList={fullscreenProjectId ? (buildMediaList(projects.find(p => p.id === fullscreenProjectId) || { id: fullscreenProjectId } as Project).map((ref: ReferenceItem): ShotMedia => ({
          id: ref.id,
          shotId: 0,
          url: ref.url,
          type: ref.type,
          filename: ref.title,
          size: 0,
          createdAt: '',
          updatedAt: '',
        }))) : undefined}
        currentIndex={fullscreenProjectId ? carouselIndex[fullscreenProjectId] || 0 : undefined}
        onIndexChange={fullscreenProjectId ? (index: number) => setCarouselIndex(prev => ({ ...prev, [fullscreenProjectId]: index })) : undefined}
        videoRefCallback={(ref) => { fullscreenVideoRef.current = ref; }}
      />

      {/* 微信分享提示 */}
      <ShareHint
        isVisible={shareHintVisible}
        onClose={() => setShareHintVisible(false)}
        mode={shareHintMode}
      />

      {/* 视频压缩选择对话框 */}
      <VideoCompressionDialog
        isOpen={pendingCompressionVideo !== null}
        onClose={() => { setPendingCompressionVideo(null); setPendingCompressionDecision(null); pendingUploadRef.current = null; }}
        file={pendingCompressionVideo}
        decision={pendingCompressionDecision}
        aliyunConfigured={aliyunConfigured}
        onSelect={handleCompressionSelect}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[90] px-4 py-2.5 rounded-2xl bg-slate-800/95 border border-white/10 text-sm shadow-xl">
          {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 inline mr-2 text-green-400" />}
          {toast.type === 'error' && <XCircle className="w-4 h-4 inline mr-2 text-red-400" />}
          {toast.type === 'info' && <Info className="w-4 h-4 inline mr-2 text-blue-400" />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
