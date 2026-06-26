import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Plus, Trash2, Share2, Film, HardDrive, ChevronRight, ChevronLeft, X, Play, Maximize2, Upload, Image as ImageIcon, Link2, CheckCircle2, XCircle, Info } from 'lucide-react';
import { setupShareMetadata, copyToClipboard, isWeChat } from '../lib/shareUtils';
import { uploadVideo2Image, uploadVideo2Video, detectFileType, uploadVideo2FromUrl, checkVideoBitrate } from '../lib/ossUtils';
import type { UploadDecision } from '../lib/ossUtils';
import { ShareHint } from './WeChatShareHint';
import { VideoCompressionDialog } from './VideoCompressionDialog';
import { timeAgo, formatSize } from '../lib/utils';

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

interface Video2ProjectListProps {
  onSelectProject?: (projectId: number) => void;
}

export function Video2ProjectList({ onSelectProject }: Video2ProjectListProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

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
  const [fullscreenTitle, setFullscreenTitle] = useState<string>('');
  const fullscreenVideoRef = useRef<HTMLVideoElement>(null);

  // 全屏弹窗打开时自动播放视频
  useEffect(() => {
    if (fullscreenItem && fullscreenItem.type === 'video' && fullscreenVideoRef.current) {
      fullscreenVideoRef.current.play().catch(() => {});
    }
  }, [fullscreenItem]);

  const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/video2/projects');
      const data = await res.json();
      if (data.success) setProjects(data.data);
    } catch (e) {
      console.error('加载项目列表失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
    setupShareMetadata({
      title: '柒子文化拍摄辅助',
      desc: '专业的视频拍摄管理工具，帮助团队高效管理拍摄素材',
      link: window.location.href,
      imgUrl: '/images/hero-home.png'
    });
    document.title = '柒子文化拍摄辅助';
  }, [loadProjects]);

  // 加载某项目的参考文件
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

  // 兜底：若无参考文件，则加载项目内前 6 个普通素材作为预览
  const loadProjectMedia = useCallback(async (projectId: number) => {
    try {
      const params = new URLSearchParams();
      params.set('projectId', String(projectId));
      params.set('status', 'pending');
      const res = await fetch(`/api/video2/list?${params.toString()}`);
      const data = await res.json();
      const items: any[] = (data.data || []).slice(0, 6);
      const refs: ReferenceItem[] = items.map((it: any) => ({
        id: it.id,
        type: it.type,
        url: it.url,
        title: it.title
      }));
      setReferencesCache(prev => {
        if (prev[projectId] && prev[projectId]!.length > 0) return prev;
        return { ...prev, [projectId]: refs };
      });
    } catch (e) {
      console.error('加载项目素材兜底失败:', e);
    }
  }, []);

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
      desc: project.description || '柒子文化拍摄辅助 - 专业项目管理',
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

  const handleFileUploadToProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !uploadDialogProject) return;
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
          await uploadVideo2Image(file, {
            projectId: project.id,
            reference: true,
            title: file.name
          });
          if (!firstUploadedUrl) {
            firstUploadedUrl = '';
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
        showToast('上传失败：' + (err.message || '请重试'), 'error');
      }
    }

    if (!stopped) {
      await loadReferences(project.id);
      const newRefs = referencesCache[project.id] || [];
      if (newRefs.length > 0) {
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

    try {
      await uploadVideo2Video(file, {
        projectId: project.id,
        reference: true,
        title: file.name,
        compressionMethod: method,
        skipBitrateCheck: true,
        onProgress: p => {
          setUploadDialogMessage(`视频 ${index + 1}/${total}: ${p.message} (${p.progress}%)`);
        }
      });
      currentSuccess++;
      setUploadDialogMessage(`已上传 ${currentSuccess} / ${total}`);

      for (let i = index + 1; i < total; i++) {
        const nextFile = (document.querySelector('input[type="file"]') as HTMLInputElement)?.files?.[i];
        if (!nextFile) continue;
        const detected = detectFileType(nextFile);
        if (!detected.supported) continue;

        try {
          if (detected.type === 'image') {
            await uploadVideo2Image(nextFile, {
              projectId: project.id,
              reference: true,
              title: nextFile.name
            });
          } else {
            setUploadDialogMessage(`视频 ${i + 1}/${total}: 检测视频信息...`);
            const nextDecision = await checkVideoBitrate(nextFile);
            if (nextDecision.decision === 'must_compress') {
              pendingUploadRef.current = { file: nextFile, index: i, total, successCount: currentSuccess, project };
              setPendingCompressionVideo(nextFile);
              setPendingCompressionDecision(nextDecision);
              setUploadDialogMessage(`视频 ${i + 1}/${total}: 需选择压缩方式`);
              return;
            }
            await uploadVideo2Video(nextFile, {
              projectId: project.id,
              reference: true,
              title: nextFile.name,
              skipBitrateCheck: true,
              onProgress: p => {
                setUploadDialogMessage(`视频 ${i + 1}/${total}: ${p.message} (${p.progress}%)`);
              }
            });
          }
          currentSuccess++;
          setUploadDialogMessage(`已上传 ${currentSuccess} / ${total}`);
        } catch (err: any) {
          console.error('上传失败:', err);
          showToast('上传失败：' + (err.message || '请重试'), 'error');
        }
      }

      await loadReferences(project.id);
      const newRefs = referencesCache[project.id] || [];
      if (newRefs.length > 0) {
        const first = newRefs[0];
        const coverUrl = first.type === 'video' ? getVideoPoster(first.url) || first.url : first.url;
        await setProjectCover(project.id, coverUrl);
      }
      setUploadDialogMessage(`完成：成功 ${currentSuccess}`);
      setUploadDialogLoading(false);
      setTimeout(() => setUploadDialogMessage(''), 3000);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
    } catch (err: any) {
      console.error('压缩上传失败:', err);
      setUploadDialogMessage('失败：' + (err.message || '压缩上传失败'));
      setUploadDialogLoading(false);
      showToast('上传失败：' + (err.message || '请重试'), 'error');
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
      if (newRefs.length > 0) {
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
  const buildMediaList = (project: Project): ReferenceItem[] => {
    const refs = referencesCache[project.id] || [];
    const cover: ReferenceItem | null = project.coverUrl
      ? { id: -1, type: 'image', url: project.coverUrl, title: '封面' }
      : null;
    if (refs.length === 0) {
      return cover ? [cover] : [];
    }
    // 如果封面等于第一个参考素材（或其视频截图），则去重
    const firstRef = refs[0];
    const firstRefUrl = firstRef.url || '';
    const firstRefPoster = firstRef.type === 'video' ? getVideoPoster(firstRef.url) || firstRefUrl : firstRefUrl;
    const firstRefIsCover = cover && firstRef && (firstRefUrl === cover.url || firstRefPoster === cover.url);
    if (firstRefIsCover) return refs;
    return cover ? [cover, ...refs] : refs;
  };

  const moveCarousel = (projectId: number, dir: 1 | -1) => {
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
            <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-violet-300 via-pink-300 to-fuchsia-300 bg-clip-text text-transparent">
              柒子文化拍摄辅助
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
            // 首次进入项目列表时，尝试加载素材作为预览；优先参考文件，其次是项目内素材
            if (referencesCache[project.id] === undefined) {
              loadReferences(project.id).then(() => {
                if (!referencesCache[project.id] || referencesCache[project.id]!.length === 0) {
                  loadProjectMedia(project.id);
                }
              });
            }
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
                    // 统一渲染：图片与视频都显示为图片海报
                    const mediaSrc = current
                      ? (current.type === 'video'
                          ? (getVideoPoster(current.url) || current.url)
                          : current.url)
                      : DEFAULT_COVER;
                    return (
                      <img
                        src={mediaSrc}
                        alt={project.name}
                        className="w-full h-full object-cover cursor-pointer"
                        onClick={() => goToProject(project.id)}
                        onError={(ev) => { (ev.target as HTMLImageElement).src = DEFAULT_COVER; }}
                      />
                    );
                  })()}

                  {/* 底部渐变遮罩，增强文字对比度 */}
                  <div
                    className="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-slate-900/10 to-transparent"
                    onClick={() => goToProject(project.id)}
                  />

                  {/* 视频条目：点击播放按钮后弹窗播放视频 */}
                  {current && current.type === 'video' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setFullscreenItem(current);
                        setFullscreenTitle(project.name);
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
                            setCarouselIndex(prev => ({ ...prev, [project.id]: i }));
                          }}
                          className={`rounded-full transition-all ${i === currentIdx ? 'w-4 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/40 hover:bg-white/70'}`}
                        />
                      ))}
                    </div>
                  )}

                  {/* 右下：全屏预览（避免与右上分享/删除按钮重叠） */}
                  {current && current.type !== 'video' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setFullscreenItem(current);
                        setFullscreenTitle(project.name);
                      }}
                      className="absolute bottom-3 right-3 z-20 w-9 h-9 rounded-full border border-white/20 bg-black/50 backdrop-blur hover:bg-white/15 flex items-center justify-center transition"
                      title="全屏预览"
                    >
                      <Maximize2 className="w-4 h-4 text-white/80" />
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
                    <span className="inline-flex items-center gap-1">
                      <Film className="w-3.5 h-3.5" /> {project.videoCount} 项
                    </span>
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
          <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold">上传图片或视频作为封面 / 参考</h2>
                <p className="text-xs text-slate-400 mt-0.5">「{uploadDialogProject.name}」 — 第一张会自动设为封面</p>
              </div>
              <button onClick={() => !uploadDialogLoading && setUploadDialogProject(null)} className="w-9 h-9 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex gap-2 mb-4 bg-white/5 p-1 rounded-2xl">
              <button
                onClick={() => setUploadDialogTab('file')}
                className={`flex-1 py-2 text-sm rounded-xl transition ${uploadDialogTab === 'file' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                <Upload className="w-4 h-4 inline mr-1.5" />选择文件
              </button>
              <button
                onClick={() => setUploadDialogTab('url')}
                className={`flex-1 py-2 text-sm rounded-xl transition ${uploadDialogTab === 'url' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                <Link2 className="w-4 h-4 inline mr-1.5" />网络 URL
              </button>
            </div>

            {uploadDialogTab === 'file' ? (
              <div>
                <label className="block border-2 border-dashed border-white/15 hover:border-violet-400/40 rounded-2xl p-8 text-center cursor-pointer transition bg-white/[0.02]">
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={handleFileUploadToProject}
                    disabled={uploadDialogLoading}
                  />
                  <ImageIcon className="w-10 h-10 mx-auto mb-3 text-violet-300/60" />
                  <p className="text-sm font-medium mb-1">点击选择文件</p>
                  <p className="text-xs text-slate-500">支持图片 (jpg, png, webp, gif) 和视频 (mp4, webm)</p>
                </label>
                <p className="text-xs text-slate-500 mt-3">
                  提示：视频会在服务端自动压缩；非图片/视频文件会被忽略
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={uploadDialogUrl}
                    onChange={e => setUploadDialogUrl(e.target.value)}
                    placeholder="https://example.com/image.jpg 或 https://example.com/video.mp4"
                    className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm transition"
                    onKeyDown={e => e.key === 'Enter' && handleUrlUploadToProject()}
                    disabled={uploadDialogLoading}
                  />
                  <button
                    onClick={handleUrlUploadToProject}
                    disabled={!uploadDialogUrl.trim() || uploadDialogLoading}
                    className="px-4 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 transition"
                  >转存</button>
                </div>
                <p className="text-xs text-slate-500">链接必须是公开可访问资源地址</p>
              </div>
            )}

            {uploadDialogMessage && (
              <div className="mt-4 text-sm text-center text-violet-200 bg-violet-500/10 border border-violet-400/20 rounded-xl py-2.5">
                {uploadDialogMessage}
              </div>
            )}

            {/* 已有参考素材展示 */}
            {referencesCache[uploadDialogProject.id] && referencesCache[uploadDialogProject.id]!.length > 0 && (
              <div className="mt-5">
                <h3 className="text-sm font-medium mb-3 text-slate-300">已上传的素材（{referencesCache[uploadDialogProject.id]!.length}）</h3>
                <div className="grid grid-cols-3 gap-2 max-h-40 overflow-y-auto">
                  {referencesCache[uploadDialogProject.id]!.map(item => (
                    <div key={item.id} className="relative aspect-video rounded-xl overflow-hidden border border-white/10 bg-black/30">
                      {item.type === 'image' ? (
                        <img src={item.url} alt={item.title} className="w-full h-full object-cover" />
                      ) : (
                        <>
                          <img src={getVideoPoster(item.url)} alt={item.title} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Play className="w-6 h-6 text-white drop-shadow-lg" />
                          </div>
                        </>
                      )}
                      <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-[10px] uppercase">
                        {item.type}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 全屏预览弹窗 */}
      {fullscreenItem && (
        <div className="fixed inset-0 z-[80] bg-black/95 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setFullscreenItem(null)}>
          <button
            onClick={() => setFullscreenItem(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full border border-white/25 bg-white/5 hover:bg-white/15 flex items-center justify-center text-white z-10"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="max-w-6xl w-full max-h-full" onClick={e => e.stopPropagation()}>
            {fullscreenItem.type === 'image' ? (
              <img src={fullscreenItem.url} alt={fullscreenTitle || fullscreenItem.title} className="mx-auto max-w-full max-h-[80vh] object-contain rounded-2xl" />
            ) : (
              <video
                ref={fullscreenVideoRef}
                src={fullscreenItem.url}
                poster={getVideoPoster(fullscreenItem.url)}
                controls
                playsInline
                className="mx-auto max-w-full max-h-[80vh] rounded-2xl bg-black"
              />
            )}
            <p className="text-center text-sm text-slate-300 mt-4">{fullscreenTitle || fullscreenItem.title}</p>
          </div>
        </div>
      )}

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
