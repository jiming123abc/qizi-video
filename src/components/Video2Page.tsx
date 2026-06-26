import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Play, CheckCircle2, Trash2, X, FileVideo, Maximize2, Share2, Plus, ArrowLeft, RotateCcw, Image as ImageIcon, Link2, Check, GripVertical, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Settings as SettingsIcon, Sparkles, Scissors, BarChart3, Search, XCircle, Info, MoreHorizontal, Merge } from 'lucide-react';
import { setupShareMetadata, copyToClipboard, isWeChat as checkIsWeChat } from '../lib/shareUtils';
import { uploadVideo2Image, uploadVideo2Video, uploadVideo2FromUrl, detectFileType, getOssProxyUrl, checkVideoBitrate } from '../lib/ossUtils';
import type { UploadDecision } from '../lib/ossUtils';
import { VideoCompressionDialog } from './VideoCompressionDialog';
import { ShareHint } from './WeChatShareHint';
import { timeAgo } from '../lib/utils';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useToast } from '../hooks/useToast';
import { useScenes } from '../hooks/useScenes';
import { useShots } from '../hooks/useShots';

// 分镜组件
import { ShotCard } from './storyboard/ShotCard';
import { ShotSearchBar } from './storyboard/ShotSearchBar';
import { ShotSkeleton } from './storyboard/ShotSkeleton';
import { EmptyState } from './storyboard/EmptyState';
import { BottomTabBar } from './storyboard/BottomTabBar';
import MediaManagerDialog from './storyboard/MediaManagerDialog';
import AddShotDialog from './storyboard/AddShotDialog';
import VideoSplitDialog from './storyboard/VideoSplitDialog';

// AI 组件
import AIScriptDialog from './ai/AIScriptDialog';
import AIImageGenDialog from './ai/AIImageGenDialog';
import AIUsagePanel from './ai/AIUsagePanel';

// 设置组件
import SettingsDialog from './settings/SettingsDialog';

// 类型
import type { Shot, ShotMedia, Project, Scene } from '../lib/types';

interface Video2PageProps {
  projectId: number;
  onBack?: () => void;
}

interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled';
  message?: string;
}

// 视频 poster（OSS 截图）
function getPosterUrl(videoUrl: string): string {
  if (videoUrl && (videoUrl.includes('aliyuncs.com') || videoUrl.includes('qiziwenhua.top'))) {
    return getOssProxyUrl(videoUrl + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast');
  }
  return '';
}

export function Video2Page({ projectId, onBack }: Video2PageProps) {
  const { toast, toastVisible, showToast, hideToast } = useToast();

  const {
    scenes,
    setScenes,
    currentSceneId,
    setCurrentSceneId,
    dragSceneId,
    setDragSceneId,
    dragOverSceneId,
    setDragOverSceneId,
    canScrollLeft,
    canScrollRight,
    sceneTabRef,
    sortedScenes,
    loadScenes,
    createScene: createSceneApi,
    renameScene: renameSceneApi,
    deleteScene: deleteSceneApi,
    handleSceneDragStart,
    handleSceneDragOver,
    handleSceneDrop,
    moveScene,
    updateSceneScrollState,
    scrollSceneTabs,
  } = useScenes({ projectId, showToast });

  const {
    shots,
    setShots,
    shotsLoading,
    setShotsLoading,
    selectedIds,
    setSelectedIds,
    dragItemId,
    setDragItemId,
    dragOverItemId,
    setDragOverItemId,
    dragHandlePressedRef,
    loadShots: loadShotsApi,
    toggleSelect,
    selectAll,
    updateShot,
    updateShotStatus,
    updateShotNo,
    softDelete,
    restoreItem,
    hardDelete,
    batchSoftDelete,
    batchRestore,
    batchHardDelete,
    batchMoveToScene,
    batchMergeShots,
    handleItemDragStart,
    handleDragHandleMouseDown,
    handleItemDragOver,
    handleItemDrop: handleItemDropApi,
    moveItem: moveItemApi,
    cloneShot,
  } = useShots({ projectId, showToast });

  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<{ pending: number; done: number; trash: number; unclassified: number }>({ pending: 0, done: 0, trash: 0, unclassified: 0 });
  const [loading, setLoading] = useState(true);

  const [currentTab, setCurrentTab] = useState<'pending' | 'done' | 'trash'>('pending');
  const [searchQuery, setSearchQuery] = useState('');

  // 已拍摄按钮确认弹窗
  const [showConfirmDialog, setShowConfirmDialog] = useState<Shot | null>(null);

  // 通用确认弹窗
  const [genericConfirm, setGenericConfirm] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    confirmButtonClass?: string;
    onConfirm: () => void;
    onCancel?: () => void;
  } | null>(null);

  const [newSceneName, setNewSceneName] = useState('');
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showMergeConfirm, setShowMergeConfirm] = useState(false);
  const [renameSceneId, setRenameSceneId] = useState<number | null>(null);
  const [renameSceneName, setRenameSceneName] = useState('');
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadTab, setUploadTab] = useState<'file' | 'url'>('file');
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [urlInputValue, setUrlInputValue] = useState('');

  const [shareHintVisible, setShareHintVisible] = useState(false);
  const [shareHintMode, setShareHintMode] = useState<'wechat' | 'default'>('default');

  // 镜头号输入弹窗
  const [showShotNoDialog, setShowShotNoDialog] = useState<Shot | null>(null);
  // 'markDone': 从未拍摄标记为已拍摄时触发（显示说明文字）
  // 'edit': 从已拍摄标签页点击编号按钮触发（不显示说明文字）
  const [shotNoDialogMode, setShotNoDialogMode] = useState<'markDone' | 'edit'>('markDone');
  const [shotNoInputValue, setShotNoInputValue] = useState('');

  // 场次管理面板
  const [showSceneManager, setShowSceneManager] = useState(false);
  const [sceneManagerMode, setSceneManagerMode] = useState<'list' | 'create' | 'edit'>('list');

  const containerRef = useRef<HTMLDivElement | null>(null);

  // 视频元素 ref 管理（微信播放需要同步手势调用）
  const videoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());

  // 视频互斥播放
  const [playingVideoKey, setPlayingVideoKey] = useState<string | null>(null);

  // 视频压缩选择对话框
  const [pendingCompressionVideo, setPendingCompressionVideo] = useState<File | null>(null);
  const [pendingCompressionDecision, setPendingCompressionDecision] = useState<UploadDecision | null>(null);
  const [pendingUploadIndex, setPendingUploadIndex] = useState<number>(-1);
  const pendingValidFilesRef = useRef<File[]>([]);
  const uploadCancelledRef = useRef(false);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);

  // 阿里云配置状态
  const [aliyunConfigured, setAliyunConfigured] = useState(false);

  useEffect(() => {
    fetch('/api/video2/aliyun/status')
      .then(res => res.json())
      .then(data => setAliyunConfigured(data.configured || false))
      .catch(() => {});
  }, []);

  const handleVideoPlay = useCallback((shotId: number, mediaId: number) => {
    setPlayingVideoKey(`${shotId}-${mediaId}`);
  }, []);

  const handleVideoPause = useCallback((shotId: number, mediaId: number) => {
    setPlayingVideoKey(null);
  }, []);

  const [fullscreenItem, setFullscreenItem] = useState<ShotMedia | null>(null);
  const fullscreenVideoRef = useRef<HTMLVideoElement>(null);

  // ============ 新对话框状态 ============
  const [showAddShotDialog, setShowAddShotDialog] = useState(false);
  const [showAIScriptDialog, setShowAIScriptDialog] = useState(false);
  const [showAIImageGenDialog, setShowAIImageGenDialog] = useState(false);
  const [showVideoSplitDialog, setShowVideoSplitDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [showAIUsagePanel, setShowAIUsagePanel] = useState(false);
  const [showMobileMoreMenu, setShowMobileMoreMenu] = useState(false);
  const [showMediaManager, setShowMediaManager] = useState(false);
  const [selectedShotForMedia, setSelectedShotForMedia] = useState<Shot | null>(null);
  const [selectedShotForAIGen, setSelectedShotForAIGen] = useState<Shot | null>(null);
  const [selectedVideoForSplit, setSelectedVideoForSplit] = useState<string | null>(null);

  // 展开的分镜ID
  const [expandedShotId, setExpandedShotId] = useState<number | null>(null);

  // 全屏弹窗打开时自动播放视频
  useEffect(() => {
    if (fullscreenItem && fullscreenItem.type === 'video' && fullscreenVideoRef.current) {
      fullscreenVideoRef.current.play().catch(() => {});
    }
  }, [fullscreenItem]);

  // 全屏弹窗支持 Escape 键关闭
  useEscapeKey(() => setFullscreenItem(null), fullscreenItem !== null);

  // 互斥播放：当前正在卡片内播放的 item id
  const [playingItemId, setPlayingItemId] = useState<number | null>(null);

  // 当 playingItemId 变化时：
  // 1) 暂停非当前的视频（确保打开弹窗/切换时停止）
  // 2) 对当前播放项调用 .play()，恢复 IntersectionObserver 驱动的手机浏览器滚动自动播放
  useEffect(() => {
    videoRefs.current.forEach((v, id) => {
      if (id !== playingItemId) {
        try { v.pause(); } catch (_) {}
      }
    });
    if (playingItemId !== null) {
      const v = videoRefs.current.get(playingItemId);
      if (v) {
        v.play().catch(() => {});
      }
    }
  }, [playingItemId]);

  // 滚动位置记录（key = sceneId-tab）
  const scrollPositionsRef = useRef<Map<string, number>>(new Map());
  const userManualSelectedUnclassifiedRef = useRef(false);

  // 平板/桌面检测（用于区分桌面端拖拽 vs 手机端箭头排序）
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // ============ 数据加载 ============
  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/video2/projects/${projectId}`);
      const data = await res.json();
      if (data.success) {
        // 统一 name 字段：后端现在也会返回 name 和 title
        const raw = data.data || {};
        const name = (raw.name && String(raw.name).trim()) ||
                     (raw.title && String(raw.title).trim()) ||
                     '未命名项目';
        setProject({ ...raw, name });
      }
    } catch (e) {
      console.error('加载项目信息失败:', e);
    }
  }, [projectId]);

  // 项目名称就地重命名
  const updateProjectName = async (newName: string) => {
    const name = newName.trim();
    if (!name || !project) return;
    try {
      const res = await fetch(`/api/video2/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.success !== false) {
        setProject({ ...project, name });
      }
    } catch (e) {
      console.error('更新项目名称失败:', e);
    }
  };

  const loadShots = useCallback(async () => {
    await loadShotsApi(currentSceneId, currentTab);
    const key = `${currentSceneId === null ? 'null' : currentSceneId}-${currentTab}`;
    const saved = scrollPositionsRef.current.get(key);
    if (saved !== undefined) {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: saved, behavior: 'instant' });
      });
    }
  }, [loadShotsApi, currentSceneId, currentTab]);

  const loadStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('projectId', String(projectId));
      if (currentTab !== 'trash') {
        if (currentSceneId === null) params.set('sceneId', 'null');
        else params.set('sceneId', String(currentSceneId));
      }
      const res = await fetch(`/api/video2/stats?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        const s = data.data || {};
        setStats({ 
          pending: s.pending || 0, 
          done: s.done || 0, 
          trash: s.trash || 0,
          unclassified: s.unclassified ?? 0
        });
      }
    } catch (e) {
      console.error('加载统计失败:', e);
    }
  }, [projectId, currentSceneId, currentTab]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadProject(), loadScenes(), loadShots(), loadStats()]);
  }, [loadProject, loadScenes, loadShots, loadStats]);

  useEffect(() => {
    setLoading(true);
    refreshAll().then(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SEO / 分享元数据
  useEffect(() => {
    if (!project) return;
    document.title = project.name + ' · 柒子文化拍摄辅助';
    setupShareMetadata({
      title: project.name,
      desc: project.description || '柒子文化拍摄辅助 - 专业项目管理',
      link: window.location.href,
      imgUrl: project.coverUrl || ''
    });
  }, [project]);

  // 切换场次 / tab
  useEffect(() => {
    loadShots();
    loadStats();
    // 切换 tab 时停止当前播放
    setPlayingItemId(null);
  }, [currentSceneId, currentTab, loadShots, loadStats]);

  // 自动跳转场次逻辑：当 currentSceneId === null 且存在场次时，自动跳转到第一个场次
  // 例外：用户手动选择了"未分类"时不强制跳转
  useEffect(() => {
    if (userManualSelectedUnclassifiedRef.current) return;
    if (currentSceneId === null && scenes.length > 0) {
      setCurrentSceneId(scenes[0].id);
      setSelectedIds(new Set());
    }
  }, [scenes, currentSceneId]);

  // ============ 滚动位置记录 ============
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let rafId = 0;
    const onScroll = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        const key = `${currentSceneId === null ? 'null' : currentSceneId}-${currentTab}`;
        scrollPositionsRef.current.set(key, window.pageYOffset);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [currentSceneId, currentTab]);

  // ============ 状态切换（点击状态标签或圆圈复选框） ============
  const toggleStatus = async (shot: Shot, skipDialog?: boolean) => {
    const newStatus = shot.status === 'pending' ? 'done' : 'pending';
    // 未拍摄 → 已拍摄：先弹出镜头号输入框
    if (newStatus === 'done' && !skipDialog) {
      setPlayingItemId(null);
      setShotNoInputValue(shot.shotNo || '');
      setShowShotNoDialog(shot);
      return;
    }
    // 已拍摄 → 未拍摄：先弹出确认对话框
    if (newStatus === 'pending' && !skipDialog) {
      setShowConfirmDialog(shot);
      return;
    }
    try {
      await fetch(`/api/video2/shots/${shot.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      // 本地立即移除：点击后自动移动到对应的 tab
      setShots(prev => prev.filter(it => it.id !== shot.id));
      // 同步 stats
      await loadStats();
      showToast(newStatus === 'done' ? '已标记为已拍摄' : '已回到未拍摄');
    } catch (e) {
      console.error('更新状态失败:', e);
    }
  };

  // ============ 镜头号确认（标记为已拍摄时） ============
  const confirmShotNo = async () => {
    if (!showShotNoDialog) return;
    const shot = showShotNoDialog;
    const shotNo = shotNoInputValue.trim();
    try {
      const updateData: { status: string; shotNo?: string } = { status: 'done' };
      if (shotNo) {
        updateData.shotNo = shotNo;
      }
      await fetch(`/api/video2/shots/${shot.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });
      setShots(prev => prev.filter(it => it.id !== shot.id));
      await loadStats();
      showToast('已标记为已拍摄');
    } catch (e) {
      console.error('更新状态/镜头号失败:', e);
    } finally {
      setShowShotNoDialog(null);
      setShotNoInputValue('');
    }
  };

  // 更新已有项目的镜头号（已拍摄卡片上点击镜头号）
  // 打开镜头编号编辑对话框
  const handleShotNoClick = (shot: Shot) => {
    setShotNoInputValue(shot.shotNo || '');
    setShotNoDialogMode('edit');
    setShowShotNoDialog(shot);
  };

  // ============ 删除 / 恢复（包装 useShots + 本地状态） ============
  const softDeleteWithStats = async (id: number) => {
    await softDelete(id);
    await loadStats();
  };

  const restoreItemWithStats = async (id: number) => {
    await restoreItem(id);
    await loadStats();
  };

  const hardDeleteWithConfirm = (id: number) => {
    hardDelete(id, async (doDelete) => {
      setGenericConfirm({
        isOpen: true,
        title: '彻底删除',
        message: '确定彻底删除此素材吗？无法恢复。',
        confirmText: '彻底删除',
        onConfirm: async () => {
          setGenericConfirm(null);
          await doDelete();
          await loadStats();
        }
      });
    });
  };

  // ============ 批量操作（包装 useShots + 本地状态） ============
  const batchSoftDeleteWithStats = async () => {
    await batchSoftDelete();
    await loadStats();
  };

  const batchRestoreWithStats = async () => {
    await batchRestore();
    await loadStats();
  };

  const batchHardDeleteWithConfirm = () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    batchHardDelete(async (doDelete) => {
      setGenericConfirm({
        isOpen: true,
        title: '批量彻底删除',
        message: `确定彻底删除所选 ${count} 项？无法恢复。`,
        confirmText: '彻底删除',
        onConfirm: async () => {
          setGenericConfirm(null);
          await doDelete();
          await loadStats();
        }
      });
    });
  };

  const batchMoveToSceneAndClose = async (sceneId: number | null) => {
    await batchMoveToScene(sceneId);
    setShowMoveModal(false);
  };

  const batchMergeShotsWithReload = () => {
    if (selectedIds.size < 2) {
      showToast('请选择至少2个分镜进行合并', 'info');
      return;
    }
    setShowMergeConfirm(true);
  };

  const confirmMergeShots = async () => {
    setShowMergeConfirm(false);
    await batchMergeShots(loadShots);
  };

  // ============ 设置项目封面（上传后自动调用） ============
  const setProjectCover = async (coverUrl: string) => {
    try {
      await fetch(`/api/video2/projects/${projectId}/cover`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverUrl })
      });
      setProject(prev => prev ? { ...prev, coverUrl } : prev);
    } catch (e) {
      console.error('设置封面失败:', e);
    }
  };

  // ============ 场次管理（包装 useScenes + 本地 UI 状态） ============
  const createScene = async () => {
    const name = newSceneName.trim();
    if (!name) return;
    await createSceneApi(name);
    setNewSceneName('');
    setSceneManagerMode('list');
    userManualSelectedUnclassifiedRef.current = false;
    await loadStats();
  };

  const renameScene = async () => {
    if (renameSceneId === null) return;
    const name = renameSceneName.trim();
    if (!name) return;
    await renameSceneApi(renameSceneId, name);
    setRenameSceneId(null);
    setRenameSceneName('');
    setSceneManagerMode('list');
    await loadStats();
  };

  const deleteScene = async (id: number) => {
    await deleteSceneApi(id);
    await loadStats();
  };

  // ============ 拖拽排序（分镜卡片） ============
  // 分镜卡片拖拽（包装 useShots + isMobile 判断 + scrollIntoView）
  const handleItemDragStartWrap = (id: number, e: React.DragEvent) => {
    if (isMobile) {
      setDragItemId(id);
      return;
    }
    handleItemDragStart(id, e);
  };

  const handleItemDrop = async (targetId: number) => {
    await handleItemDropApi(targetId, isMobile, scrollItemIntoView);
  };

  const moveItem = async (itemId: number, dir: -1 | 1) => {
    await moveItemApi(itemId, dir, scrollItemIntoView);
  };

  const cloneShotWithReload = async (id: number) => {
    await cloneShot(id, loadShots);
  };

  // 将指定卡片滚动到可视区（垂直居中）
  const scrollItemIntoView = (itemId: number) => {
    window.requestAnimationFrame(() => {
      const el = document.querySelector(`[data-item-id="${itemId}"]`);
      if (el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }
    });
  };

  // ============ 视频分割 ============
  const videoSplitInputRef = useRef<HTMLInputElement>(null);

  const handleSplitVideoUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const detected = detectFileType(file);
    if (detected.type !== 'video') {
      showToast('请选择视频文件');
      return;
    }

    setShowUploadDialog(true);
    setUploadTab('file');
    const uploadId = `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    setUploadingFiles([{
      id: uploadId,
      name: file.name,
      size: file.size,
      progress: 5,
      status: 'uploading'
    }]);

    try {
      const result = await uploadVideo2Video(file, {
        projectId,
        sceneId: currentSceneId !== null ? currentSceneId : undefined,
        title: file.name,
        createShot: true,
        onProgress: p => {
          setUploadingFiles(prev => prev.map(uf => uf.id === uploadId ? { ...uf, progress: p.progress, message: p.message } : uf));
        }
      });

      setUploadingFiles(prev => prev.map(uf => uf.id === uploadId ? { ...uf, progress: 100, status: 'done', message: '上传完成，准备分割...' } : uf));

      if (result.url) {
        setSelectedVideoForSplit(result.url);
        setTimeout(() => {
          setShowUploadDialog(false);
          setUploadingFiles([]);
          setShowVideoSplitDialog(true);
        }, 500);
      }

      await loadShots();
      await loadStats();
    } catch (e) {
      console.error('视频上传失败:', e);
      setUploadingFiles(prev => prev.map(uf => uf.id === uploadId ? { ...uf, status: 'error', message: '失败' } : uf));
      showToast('视频上传失败', 'error');
    }

    if (videoSplitInputRef.current) videoSplitInputRef.current.value = '';
  };

  // ============ 上传 ============
  const handleUploadFiles = async (files: FileList | File[]) => {
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

    let firstCoverUrl: string | null = null;
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
          if (!firstCoverUrl) firstCoverUrl = '';
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
      await loadShots();
      await loadStats();
      await loadProject();
      showToast(`上传完成（${valid.length} 项）`);
    }

    uploadAbortControllerRef.current = null;
  };

  const handleCancelUpload = () => {
    uploadCancelledRef.current = true;
    if (uploadAbortControllerRef.current) {
      uploadAbortControllerRef.current.abort();
    }
  };

  const handleCompressionSelect = async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
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
        await loadShots();
        await loadStats();
      } catch (e) {
        console.error('上传失败:', videoFile.name, e);
        setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, status: 'error', message: (e as Error).message } : uf));
      }
    })();
  };

  const handleUploadFromUrl = async () => {
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
      await loadShots();
      await loadStats();
      await loadProject();
    } catch (e) {
      setUploadingFiles(prev => prev.map(uf => uf.id === newItem.id ? { ...uf, status: 'error', message: String(e) } : uf));
    }
  };

  // ============ 分享 ============
  const handleShare = async () => {
    const shareUrl = window.location.origin + `/share/video2/project/${projectId}`;
    setupShareMetadata({
      title: project?.name || '项目',
      desc: project?.description || '',
      link: shareUrl,
      imgUrl: project?.coverUrl || ''
    });
    await copyToClipboard(shareUrl);
    setShareHintMode(checkIsWeChat() ? 'wechat' : 'default');
    setShareHintVisible(true);
  };

  const backToProjectList = () => {
    if (onBack) {
      onBack();
    } else {
      window.history.back();
    }
  };

  // ============ 渲染 ============
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-violet-950 to-pink-950 text-white flex flex-col items-center justify-center">
        <div className="relative">
          <div className="w-16 h-16 rounded-full border-4 border-violet-500/20 border-t-violet-500 animate-spin" />
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 blur-xl -z-10" />
        </div>
        <div className="mt-6 text-slate-300 text-sm">加载中...</div>
        {project && (
          <div className="mt-2 text-slate-500 text-xs">{project.name}</div>
        )}
      </div>
    );
  }

  // ============ 分镜渲染 ============
  const renderShotCard = (shot: Shot, index: number, total: number) => {
    const isSelected = selectedIds.has(shot.id);
    const isFirst = index <= 0;
    const isLast = index >= total - 1;

    const handleUpdate = (id: number, fields: Partial<Shot>) => {
      setShots(prev => prev.map(s => s.id === id ? { ...s, ...fields } : s));
      // API 更新
      fetch(`/api/video2/shots/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
      }).catch(console.error);
    };

    const handleDelete = (id: number) => {
      softDeleteWithStats(id);
    };

    const handleClone = (id: number) => {
      cloneShotWithReload(id);
    };

    const handleSort = (id: number, direction: 'up' | 'down') => {
      moveItem(id, direction === 'up' ? -1 : 1);
    };

    const handleExpand = (id: number) => {
      setExpandedShotId(prev => prev === id ? null : id);
    };

    const handleManageMedia = (s: Shot) => {
      setSelectedShotForMedia(s);
      setShowMediaManager(true);
    };

    const handleUploadMedia = (s: Shot) => {
      setSelectedShotForMedia(s);
      setShowMediaManager(true);
    };

    const handleFullscreen = (media: ShotMedia) => {
      setFullscreenItem(media);
    };

    const handleAiGenerate = (s: Shot) => {
      setSelectedShotForAIGen(s);
      setShowAIImageGenDialog(true);
    };

    const handleSplitVideo = (s: Shot) => {
      const videoUrl = s.type === 'video' ? s.url : (s.media?.find(m => m.type === 'video')?.url || '');
      if (videoUrl) {
        setSelectedVideoForSplit(videoUrl);
        setShowVideoSplitDialog(true);
      }
    };

    return (
      <div
        key={shot.id}
        data-item-id={String(shot.id)}
        onDragOver={(e) => handleItemDragOver(e, shot.id)}
        onDragLeave={() => setDragOverItemId(null)}
        onDrop={(e) => { e.preventDefault(); handleItemDrop(shot.id); }}
        draggable={currentTab !== 'trash'}
        onDragStart={(e) => {
          handleItemDragStartWrap(shot.id, e);
          try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
        }}
        onDragEnd={() => { setDragItemId(null); setDragOverItemId(null); }}
        className={`relative transition-all duration-200 ${
          dragItemId === shot.id ? 'opacity-60 scale-[0.98]' : ''
        } ${dragOverItemId === shot.id && dragItemId !== shot.id ? 'ring-2 ring-violet-400/70 ring-offset-2 ring-offset-slate-900 rounded-2xl' : ''}`}
      >
        {dragOverItemId === shot.id && dragItemId !== shot.id && dragItemId !== null && (
          <div className="absolute -top-1 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-500 to-fuchsia-500 rounded-full z-10 pointer-events-none" />
        )}
        <ShotCard
          shot={shot}
          isSelected={isSelected}
          onSelect={(s) => toggleSelect(s.id)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onClone={handleClone}
          onSort={handleSort}
          onExpand={handleExpand}
          isExpanded={expandedShotId === shot.id}
          onManageMedia={handleManageMedia}
          onUploadMedia={handleUploadMedia}
          onAiGenerate={handleAiGenerate}
          onSplitVideo={handleSplitVideo}
          onFullscreen={handleFullscreen}
          isFirst={isFirst}
          isLast={isLast}
          isMobile={isMobile}
          currentTab={currentTab}
          onStatusClick={(s) => toggleStatus(s)}
          onShotNoClick={handleShotNoClick}
          onDragHandleMouseDown={handleDragHandleMouseDown}
          onVideoPlay={handleVideoPlay}
          onVideoPause={handleVideoPause}
          playingVideoKey={playingVideoKey}
        />
      </div>
    );
  };

  // 排序后的 shots（按 sortOrder）
  const sortedShots = [...shots].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  // 搜索过滤后的 shots
  const filteredShots = searchQuery.trim() === ''
    ? sortedShots
    : sortedShots.filter(shot => {
        const query = searchQuery.toLowerCase();
        return (
          shot.sceneContent?.toLowerCase().includes(query) ||
          shot.actors?.toLowerCase().includes(query) ||
          shot.location?.toLowerCase().includes(query) ||
          shot.narration?.toLowerCase().includes(query)
        );
      });

  // 上传按钮是否可用
  const uploadAvailable = currentTab === 'pending';

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-slate-900 via-violet-950 to-pink-950 text-white pb-24"
    >
      {/* 顶部栏 */}
      <div className="sticky top-0 z-30 backdrop-blur-xl bg-slate-900/75 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-3">
          <button
            onClick={backToProjectList}
            className="w-9 h-9 rounded-full border border-white/20 bg-white/5 hover:bg-white/10 flex items-center justify-center transition"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <input
              type="text"
              defaultValue={project?.name || ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v && v !== project?.name) updateProjectName(v);
                else if (!v && project) e.currentTarget.value = project.name;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                if (e.key === 'Escape' && project) (e.currentTarget as HTMLInputElement).value = project.name;
              }}
              className="w-full text-lg sm:text-2xl font-bold bg-transparent border-b border-transparent hover:border-white/20 focus:border-violet-400/60 outline-none transition truncate"
              title="点击编辑项目名称"
            />
            {project?.description && (
              <p className="text-xs sm:text-sm text-slate-400 hidden sm:block truncate mt-0.5">{project.description}</p>
            )}
          </div>
          {/* 工具按钮组（桌面端图标，移动端文字） */}
          <div className="hidden sm:flex items-center gap-1">
            <button
              onClick={handleShare}
              className="w-9 h-9 rounded-full border border-violet-400/40 bg-white/5 hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
              title="分享项目"
            >
              <Share2 className="w-4 h-4 text-white/90" />
            </button>

            {/* AI 生成分镜 */}
            <button
              onClick={() => { setPlayingItemId(null); setShowAIScriptDialog(true); }}
              className="w-9 h-9 rounded-full border border-violet-400/40 bg-white/5 hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
              title="AI 生成分镜"
            >
              <Sparkles className="w-4 h-4 text-white/90" />
            </button>

            {/* 视频分割 */}
            <button
              onClick={() => { setPlayingItemId(null); videoSplitInputRef.current?.click(); }}
              className="w-9 h-9 rounded-full border border-violet-400/40 bg-white/5 hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
              title="视频分割为分镜"
            >
              <Scissors className="w-4 h-4 text-white/90" />
            </button>

            {/* 费用统计 */}
            <button
              onClick={() => { setPlayingItemId(null); setShowAIUsagePanel(true); }}
              className="w-9 h-9 rounded-full border border-violet-400/40 bg-white/5 hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
              title="费用统计"
            >
              <BarChart3 className="w-4 h-4 text-white/90" />
            </button>

            {/* 设置 */}
            <button
              onClick={() => { setPlayingItemId(null); setShowSettingsDialog(true); }}
              className="w-9 h-9 rounded-full border border-violet-400/40 bg-white/5 hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
              title="设置"
            >
              <SettingsIcon className="w-4 h-4 text-white/90" />
            </button>
          </div>

          {/* 移动端：AI + 更多菜单 + 上传 */}
          <div className="flex sm:hidden items-center gap-1 relative">
            <button
              onClick={() => { setPlayingItemId(null); setShowAIScriptDialog(true); }}
              className="px-2 py-1 rounded text-xs border border-violet-400/40 bg-white/5 hover:bg-violet-500/30 transition"
            >
              AI
            </button>
            <div className="relative">
              <button
                onClick={() => setShowMobileMoreMenu(v => !v)}
                className="w-8 h-8 rounded-full border border-violet-400/40 bg-white/5 hover:bg-violet-500/30 flex items-center justify-center transition"
                title="更多"
              >
                <MoreHorizontal className="w-4 h-4 text-white/80" />
              </button>
              {showMobileMoreMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMobileMoreMenu(false)} />
                  <div className="absolute right-0 top-full mt-2 w-40 rounded-2xl border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl py-1 z-50">
                    <button
                      onClick={() => { setShowMobileMoreMenu(false); handleShare(); }}
                      className="w-full px-4 py-2.5 text-left text-sm hover:bg-white/5 flex items-center gap-2 transition"
                    >
                      <Share2 className="w-4 h-4 text-violet-300" />
                      分享
                    </button>
                    <button
                      onClick={() => { setShowMobileMoreMenu(false); setPlayingItemId(null); videoSplitInputRef.current?.click(); }}
                      className="w-full px-4 py-2.5 text-left text-sm hover:bg-white/5 flex items-center gap-2 transition"
                    >
                      <Scissors className="w-4 h-4 text-violet-300" />
                      视频分割
                    </button>
                    <button
                      onClick={() => { setShowMobileMoreMenu(false); setPlayingItemId(null); setShowAIUsagePanel(true); }}
                      className="w-full px-4 py-2.5 text-left text-sm hover:bg-white/5 flex items-center gap-2 transition"
                    >
                      <BarChart3 className="w-4 h-4 text-violet-300" />
                      费用统计
                    </button>
                    <div className="my-1 border-t border-white/5" />
                    <button
                      onClick={() => { setShowMobileMoreMenu(false); setPlayingItemId(null); setShowSettingsDialog(true); }}
                      className="w-full px-4 py-2.5 text-left text-sm hover:bg-white/5 flex items-center gap-2 transition"
                    >
                      <SettingsIcon className="w-4 h-4 text-violet-300" />
                      设置
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <button
            onClick={() => { if (uploadAvailable) { setPlayingItemId(null); setShowUploadDialog(true); } }}
            disabled={!uploadAvailable}
            className={`inline-flex items-center gap-2 px-3 sm:px-4 py-2 rounded-full border text-sm font-medium transition ${
              uploadAvailable
                ? 'border-violet-400/40 bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white'
                : 'border-white/10 bg-white/5 text-slate-500 cursor-not-allowed'
            }`}
            title={uploadAvailable ? '批量上传' : '当前 tab 不支持上传'}
          >
            <Upload className="w-4 h-4" />
            <span className="hidden sm:inline">批量上传</span>
            <span className="inline sm:hidden">上传</span>
          </button>
        </div>

        {/* 场次 Tab 栏：桌面端六个点手柄在选中 tab 内部 */}
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 pb-3">
          {/* 左侧渐变遮罩 + 左箭头 */}
          {canScrollLeft && (
            <>
              <div className="absolute left-0 top-0 bottom-0 w-10 bg-gradient-to-r from-slate-900 via-slate-900/80 to-transparent z-10 pointer-events-none" />
              <button
                onClick={() => scrollSceneTabs('left')}
                className="absolute left-2 top-1/2 -translate-y-1/2 z-20 w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition"
                title="向左滚动"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </>
          )}
          {/* 右侧渐变遮罩 + 右箭头 */}
          {canScrollRight && (
            <>
              <div className="absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-slate-900 via-slate-900/80 to-transparent z-10 pointer-events-none" />
              <button
                onClick={() => scrollSceneTabs('right')}
                className="absolute right-2 top-1/2 -translate-y-1/2 z-20 w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition"
                title="向右滚动"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </>
          )}
          <div
            ref={sceneTabRef}
            onScroll={updateSceneScrollState}
            className="overflow-x-auto scrollbar-hide"
          >
          <div className="flex items-center gap-2 min-w-max px-1">
            {sortedScenes.map((scene) => {
              const isActive = currentSceneId === scene.id;
              const isDragOverScene = dragOverSceneId === scene.id && dragSceneId !== scene.id;
              const isDraggingScene = dragSceneId === scene.id;
              return (
                <button
                  key={scene.id}
                  onClick={() => { setCurrentSceneId(scene.id); setSelectedIds(new Set()); }}
                  draggable={!isMobile}
                  onDragOver={(e) => handleSceneDragOver(e, scene.id)}
                  onDragLeave={() => setDragOverSceneId(null)}
                  onDrop={(e) => { e.preventDefault(); handleSceneDrop(scene.id); }}
                  onDragStart={(e) => { if (!isMobile) { handleSceneDragStart(scene.id); try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {} } }}
                  onDragEnd={() => { setDragSceneId(null); setDragOverSceneId(null); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPlayingItemId(null);
                    setRenameSceneId(scene.id);
                    setRenameSceneName(scene.name);
                    setSceneManagerMode('edit');
                    setShowSceneManager(true);
                  }}
                  className={`inline-flex items-center gap-1.5 pl-2 pr-3 sm:pr-4 py-1.5 rounded-full text-xs sm:text-sm font-medium whitespace-nowrap border transition-all duration-200 ${
                    isDraggingScene ? 'opacity-50 scale-95' : ''
                  } ${
                    isActive
                      ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 border-transparent text-white shadow-lg shadow-violet-500/25'
                      : 'border-white/15 bg-white/5 text-slate-300 hover:bg-white/10'
                  } ${isDragOverScene ? 'ring-2 ring-violet-400/70 scale-105' : ''}`}
                  title={isActive ? '点击切换 · 右键重命名' : '点击切换场次 · 右键重命名'}
                >
                  {isActive && !isMobile && (
                    <GripVertical className="w-3.5 h-3.5 text-white/90 shrink-0 cursor-grab active:cursor-grabbing" />
                  )}
                  <span>{scene.name}</span>
                </button>
              );
            })}

            {/* 未分类 - 只有存在未分类分镜时才显示 */}
            {stats.unclassified > 0 && (
              <button
                onClick={() => {
                  userManualSelectedUnclassifiedRef.current = true;
                  setCurrentSceneId(null);
                  setSelectedIds(new Set());
                }}
                className={`px-3 sm:px-4 py-1.5 rounded-full text-xs sm:text-sm font-medium whitespace-nowrap border transition ${
                  currentSceneId === null
                    ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 border-transparent text-white shadow-lg shadow-violet-500/25'
                    : 'border-white/15 bg-white/5 text-slate-300 hover:bg-white/10'
                }`}
                title="未分类"
              >
                未分类
              </button>
            )}

            {/* 无场次提示：没有任何场次且没有未分类时显示 */}
            {scenes.length === 0 && stats.unclassified === 0 && (
              <span className="px-2 text-xs text-slate-500">
                无场次
              </span>
            )}

            {/* + 场次管理 */}
            <button
              onClick={() => {
                setPlayingItemId(null);
                setSceneManagerMode('list');
                setShowSceneManager(true);
              }}
              className="w-8 h-8 rounded-full border border-dashed border-white/25 hover:border-violet-400/50 hover:bg-violet-500/10 text-slate-400 hover:text-violet-200 flex items-center justify-center transition shrink-0"
              title="场次管理"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          </div>
        </div>

        {/* 批量操作栏（sticky，滚动常驻） */}
        {selectedIds.size > 0 && (
          <div className="border-t border-white/10 bg-slate-900/75 backdrop-blur">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex items-center gap-2 flex-wrap">
              <button
                onClick={selectAll}
                className="px-3 py-1.5 rounded-full text-xs border border-white/20 bg-white/5 hover:bg-white/10 transition"
              >
                全选 {shots.length}
              </button>
              <span className="text-xs text-slate-300">已选 {selectedIds.size}</span>
              <span className="flex-1" />
              {currentTab === 'trash' ? (
                <>
                  <button
                    onClick={batchRestoreWithStats}
                    className="px-3 py-1.5 rounded-full text-xs border border-white/20 bg-white/5 hover:bg-white/10 transition"
                  >
                    <RotateCcw className="w-3.5 h-3.5 inline mr-1" /> 恢复
                  </button>
                  <button
                    onClick={batchHardDeleteWithConfirm}
                    className="px-3 py-1.5 rounded-full text-xs border border-red-400/30 bg-red-500/10 hover:bg-red-500/20 text-red-200 transition"
                  >
                  <Trash2 className="w-3.5 h-3.5 inline mr-1" /> 彻底删除
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={batchMergeShotsWithReload}
                  disabled={selectedIds.size < 2}
                  className={`px-3 py-1.5 rounded-full text-xs border transition ${
                    selectedIds.size >= 2
                      ? 'border-emerald-400/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200'
                      : 'border-white/10 bg-white/[0.02] text-white/30 cursor-not-allowed'
                  }`}
                >
                  合并分镜
                </button>
                <button
                  onClick={() => { setPlayingItemId(null); setShowMoveModal(true); }}
                  className="px-3 py-1.5 rounded-full text-xs border border-violet-400/30 bg-violet-500/10 hover:bg-violet-500/20 text-violet-200 transition"
                >
                  移动到场次
                </button>
                <button
                  onClick={batchSoftDeleteWithStats}
                  className="px-3 py-1.5 rounded-full text-xs border border-white/20 bg-white/5 hover:bg-white/10 transition"
                >
                  <Trash2 className="w-3.5 h-3.5 inline mr-1" /> 删除
                </button>
              </>
            )}
            </div>
          </div>
        )}

      {/* 主体内容 */}
      <div
        ref={containerRef}
        className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* 搜索框（垃圾桶 Tab 下隐藏） */}
        {currentTab !== 'trash' && (
          <ShotSearchBar
            value={searchQuery}
            onChange={(v) => {
              setSearchQuery(v);
              setSelectedIds(new Set());
              setPlayingVideoKey(null);
            }}
          />
        )}

        {/* 分镜卡片网格 */}
        {shotsLoading ? (
          <ShotSkeleton count={8} />
        ) : filteredShots.length === 0 ? (
          searchQuery.trim() !== '' ? (
            <EmptyState
              icon={<Search className="w-10 h-10 text-slate-400" />}
              title="未找到匹配的分镜"
              description="尝试使用其他关键词搜索"
            />
          ) : currentTab === 'trash' ? (
            <EmptyState
              icon={<Trash2 className="w-10 h-10 text-slate-400" />}
              title="垃圾桶是空的"
              description="返回「未拍摄 / 已拍摄」查看素材"
            />
          ) : currentTab === 'pending' ? (
            <EmptyState
              icon={<FileVideo className="w-10 h-10 text-violet-300/60" />}
              title="暂无分镜"
              description="点击下方「增加分镜」或「AI 生成分镜」开始"
              action={
                <button
                  onClick={() => setShowAddShotDialog(true)}
                  className="px-4 py-2 rounded-full border border-violet-400/40 bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium hover:shadow-lg hover:shadow-violet-500/25 transition"
                >
                  <Plus className="w-4 h-4 inline mr-1.5" /> 增加分镜
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={<FileVideo className="w-10 h-10 text-slate-400" />}
              title="当前场次无分镜"
              description="请切换到「未拍摄」后再操作"
            />
          )
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredShots.map((shot, idx) => renderShotCard(shot, idx, filteredShots.length))}
          </div>
        )}
      </div>

      {/* 新增分镜浮动按钮 */}
      {currentTab !== 'trash' && shots.length > 0 && (
        <button
          onClick={() => setShowAddShotDialog(true)}
          className="fixed right-6 bottom-20 z-40 w-14 h-14 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/40 hover:shadow-xl hover:shadow-violet-500/50 flex items-center justify-center transition-all hover:scale-105 active:scale-95"
          title="新增分镜"
        >
          <Plus className="w-6 h-6" />
        </button>
      )}

      {/* 底部 Tab：未拍摄 / 已拍摄 / 垃圾桶（数字实时更新） */}
      <BottomTabBar
        tabs={[
          { key: 'pending', label: '未拍摄', count: stats.pending },
          { key: 'done', label: '已拍摄', count: stats.done },
          { key: 'trash', label: '垃圾桶', count: stats.trash }
        ]}
        activeTab={currentTab}
        onTabChange={(key) => { setCurrentTab(key as 'pending' | 'done' | 'trash'); setSelectedIds(new Set()); setPlayingVideoKey(null); }}
      />

      {/* ============ 弹窗 ============ */}

      {/* 移动到场次 */}
      {showMoveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowMoveModal(false)}>
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">移动到...（{selectedIds.size} 项）</h2>
              <button onClick={() => setShowMoveModal(false)} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1.5 max-h-80 overflow-y-auto">
              <button
                onClick={() => batchMoveToSceneAndClose(null)}
                className={`w-full text-left px-4 py-2.5 rounded-xl text-sm border transition ${currentSceneId === null ? 'border-violet-400/40 bg-violet-500/15 text-violet-100' : 'border-white/10 hover:bg-white/5'}`}
              >未分类</button>
              {sortedScenes.map(s => (
                <button
                  key={s.id}
                  onClick={() => batchMoveToSceneAndClose(s.id)}
                  className={`w-full text-left px-4 py-2.5 rounded-xl text-sm border transition ${currentSceneId === s.id ? 'border-violet-400/40 bg-violet-500/15 text-violet-100' : 'border-white/10 hover:bg-white/5'}`}
                >{s.name}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 合并分镜确认弹窗 */}
      {showMergeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowMergeConfirm(false)}>
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">确认合并分镜</h2>
              <button onClick={() => setShowMergeConfirm(false)} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mb-5 p-4 rounded-xl bg-amber-500/10 border border-amber-400/20">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                  <Merge className="w-5 h-5 text-amber-300" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-amber-200">将合并 {selectedIds.size} 个分镜</p>
                  <p className="text-xs text-amber-200/70">
                    合并后将保留第一个分镜的标题和描述，所有分镜的参考画面将合并到新分镜中。
                  </p>
                  <p className="text-xs text-amber-200/70">
                    被合并的分镜会被删除，此操作不可撤销。
                  </p>
                </div>
              </div>
            </div>
            <div className="mb-5 p-3 rounded-xl bg-white/[0.03] border border-white/10">
              <div className="text-xs text-slate-400 mb-2">合并后参考画面总数</div>
              <div className="text-sm font-medium text-slate-200">
                {(() => {
                  const selectedShots = shots.filter(s => selectedIds.has(s.id));
                  const totalMedia = selectedShots.reduce((sum, s) => sum + (s.media?.length || (s.reference ? 1 : 0)), 0);
                  return totalMedia > 10 ? `${totalMedia} 张（超过 10 张上限，仅保留前 10 张）` : `${totalMedia} 张`;
                })()}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowMergeConfirm(false)}
                className="px-4 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition"
              >取消</button>
              <button
                onClick={confirmMergeShots}
                className="px-4 py-2 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white text-sm font-medium transition hover:shadow-lg hover:shadow-emerald-500/25"
              >确认合并</button>
            </div>
          </div>
        </div>
      )}

      {/* 镜头号输入弹窗 */}
      {showShotNoDialog !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { setShowShotNoDialog(null); setShotNoInputValue(''); }}>
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">输入镜头编号</h2>
              <button onClick={() => { setShowShotNoDialog(null); setShotNoInputValue(''); }} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            {shotNoDialogMode === 'markDone' && (
              <p className="text-xs text-slate-400 mb-4">将此镜头标记为已拍摄</p>
            )}
            <input
              type="text"
              value={shotNoInputValue}
              onChange={(e) => setShotNoInputValue(e.target.value)}
              placeholder="镜头编号（可留空）"
              className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm transition mb-5"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (shotNoDialogMode === 'edit' && showShotNoDialog) {
                    updateShotNo(showShotNoDialog, shotNoInputValue);
                    setShowShotNoDialog(null);
                    setShotNoInputValue('');
                  } else {
                    confirmShotNo();
                  }
                }
                if (e.key === 'Escape') { setShowShotNoDialog(null); setShotNoInputValue(''); }
              }}
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => { setShowShotNoDialog(null); setShotNoInputValue(''); }}
                className="px-3 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition"
              >取消</button>
              <button
                onClick={() => {
                  if (shotNoDialogMode === 'edit' && showShotNoDialog) {
                    updateShotNo(showShotNoDialog, shotNoInputValue);
                    setShowShotNoDialog(null);
                    setShotNoInputValue('');
                  } else {
                    confirmShotNo();
                  }
                }}
                className="px-4 py-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium transition"
              >确认</button>
            </div>
          </div>
        </div>
      )}

      {/* 已拍摄按钮确认弹窗 */}
      {showConfirmDialog !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowConfirmDialog(null)}>
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">确认操作</h2>
              <button onClick={() => setShowConfirmDialog(null)} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mb-5 p-3 rounded-xl bg-white/[0.03] border border-white/10">
              <div className="text-xs text-slate-400 mb-1">分镜编号</div>
              <div className="text-sm font-medium text-slate-200">{showConfirmDialog.shotNo || '未编号'}</div>
              <div className="text-xs text-slate-400 mt-2 mb-1">画面内容</div>
              <div className="text-sm text-slate-300 line-clamp-2">{showConfirmDialog.sceneContent || showConfirmDialog.title || '无描述'}</div>
            </div>
            <p className="text-sm text-slate-300 mb-5">将此镜头标记为未拍摄</p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowConfirmDialog(null)}
                className="px-3 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition"
              >取消</button>
              <button
                onClick={() => {
                  if (showConfirmDialog) toggleStatus(showConfirmDialog, true);
                  setShowConfirmDialog(null);
                }}
                className="px-4 py-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium transition"
              >确认</button>
            </div>
          </div>
        </div>
      )}

      {/* 通用确认弹窗 */}
      {genericConfirm && genericConfirm.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { genericConfirm.onCancel?.(); setGenericConfirm(null); }}>
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">{genericConfirm.title}</h2>
              <button onClick={() => { genericConfirm.onCancel?.(); setGenericConfirm(null); }} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-slate-300 mb-5 whitespace-pre-line">{genericConfirm.message}</p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => { genericConfirm.onCancel?.(); setGenericConfirm(null); }}
                className="px-3 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition"
              >{genericConfirm.cancelText || '取消'}</button>
              <button
                onClick={genericConfirm.onConfirm}
                className={genericConfirm.confirmButtonClass || 'px-4 py-2 rounded-xl bg-gradient-to-br from-red-500 to-rose-500 text-white text-sm font-medium transition'}
              >{genericConfirm.confirmText || '确认'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 批量上传弹窗 */}
      {showUploadDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => {
          const isUploading = uploadingFiles.some(f => f.status === 'uploading');
          if (!isUploading) {
            setShowUploadDialog(false);
          } else {
            setGenericConfirm({
              isOpen: true,
              title: '上传进行中',
              message: '文件正在上传中，您可以选择取消上传或让上传在后台继续。',
              confirmText: '取消上传',
              cancelText: '后台继续',
              confirmButtonClass: 'px-4 py-2 rounded-xl bg-gradient-to-br from-red-500 to-rose-500 text-white text-sm font-medium transition',
              onConfirm: () => {
                setGenericConfirm(null);
                handleCancelUpload();
                setShowUploadDialog(false);
              },
              onCancel: () => {
                setGenericConfirm(null);
                setShowUploadDialog(false);
              }
            });
          }
        }}>
          <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold">批量上传</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  当前场次：{currentSceneId === null ? '未分类' : (scenes.find(s => s.id === currentSceneId)?.name || '')}
                </p>
              </div>
              <button onClick={() => {
                const isUploading = uploadingFiles.some(f => f.status === 'uploading');
                if (!isUploading) {
                  setShowUploadDialog(false);
                } else {
                  setGenericConfirm({
                    isOpen: true,
                    title: '上传进行中',
                    message: '文件正在上传中，您可以选择取消上传或让上传在后台继续。',
                    confirmText: '取消上传',
                    cancelText: '后台继续',
                    confirmButtonClass: 'px-4 py-2 rounded-xl bg-gradient-to-br from-red-500 to-rose-500 text-white text-sm font-medium transition',
                    onConfirm: () => {
                      setGenericConfirm(null);
                      handleCancelUpload();
                      setShowUploadDialog(false);
                    },
                    onCancel: () => {
                      setGenericConfirm(null);
                      setShowUploadDialog(false);
                    }
                  });
                }
              }} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex gap-2 mb-4 bg-white/5 p-1 rounded-2xl">
              <button
                onClick={() => setUploadTab('file')}
                className={`flex-1 py-2 text-sm rounded-xl transition ${uploadTab === 'file' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                <Upload className="w-4 h-4 inline mr-1.5" /> 选择文件
              </button>
              <button
                onClick={() => setUploadTab('url')}
                className={`flex-1 py-2 text-sm rounded-xl transition ${uploadTab === 'url' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                <Link2 className="w-4 h-4 inline mr-1.5" /> 网络 URL
              </button>
            </div>

            {uploadTab === 'file' ? (
              <div>
                <label className="block border-2 border-dashed border-white/15 hover:border-violet-400/40 rounded-2xl p-8 text-center cursor-pointer transition bg-white/[0.02]">
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(e) => { if (e.target.files) handleUploadFiles(e.target.files); e.target.value = ''; }}
                  />
                  <ImageIcon className="w-10 h-10 mx-auto mb-3 text-violet-300/60" />
                  <p className="text-sm font-medium mb-1">点击选择图片或视频</p>
                  <p className="text-xs text-slate-500">支持多选，非图片视频文件会被自动忽略</p>
                </label>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={urlInputValue}
                    onChange={(e) => setUrlInputValue(e.target.value)}
                    placeholder="https://example.com/image.jpg 或 https://example.com/video.mp4"
                    className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm transition"
                    onKeyDown={(e) => e.key === 'Enter' && handleUploadFromUrl()}
                  />
                  <button
                    onClick={handleUploadFromUrl}
                    disabled={!urlInputValue.trim()}
                    className="px-4 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 transition"
                  >转存</button>
                </div>
                <p className="text-xs text-slate-500 mt-2">URL 必须是公开可访问资源链接</p>
              </div>
            )}

            {/* 上传进度 */}
            {uploadingFiles.length > 0 && (
              <div className="mt-5 space-y-2">
                {uploadingFiles.map(f => (
                  <div key={f.id} className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/10">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-200 truncate">{f.name}</div>
                      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mt-2">
                        <div
                          className={`h-full rounded-full transition-all ${f.status === 'error' ? 'bg-red-400' : f.status === 'done' ? 'bg-green-400' : 'bg-gradient-to-r from-violet-500 to-fuchsia-500'}`}
                          style={{ width: `${f.progress}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-xs text-right">
                      {f.status === 'error' ? (
                        <span className="text-red-300">{f.message || '失败'}</span>
                      ) : (
                        <span className="text-slate-300">{f.message || `${f.progress}%`}</span>
                      )}
                    </div>
                  </div>
                ))}
                <div className="text-center pt-2">
                  <button
                    onClick={() => { setUploadingFiles([]); setShowUploadDialog(false); }}
                    className="px-4 py-2 rounded-full text-xs text-slate-400 hover:text-white hover:bg-white/5 transition"
                  >{uploadingFiles.every(f => f.status !== 'uploading') ? '关闭' : '完成后可点击关闭'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 场次管理面板（统一上下居中，内联多视图） */}
      {showSceneManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { setSceneManagerMode('list'); setShowSceneManager(false); }}>
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-4 shadow-2xl max-h-[75vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            {/* 列表视图 */}
            {sceneManagerMode === 'list' && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-semibold">场次管理</h2>
                  <button onClick={() => { setSceneManagerMode('list'); setShowSceneManager(false); }} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {/* 新建按钮 */}
                <button
                  onClick={() => { setNewSceneName(''); setSceneManagerMode('create'); }}
                  className="w-full mb-3 py-2.5 rounded-2xl border border-dashed border-violet-400/30 bg-violet-500/10 hover:bg-violet-500/20 text-sm font-medium text-violet-200 flex items-center justify-center gap-2 transition"
                >
                  <Plus className="w-4 h-4" /> 新建场次
                </button>
                {/* 场次列表 */}
                <div className="space-y-1.5">
                  {sortedScenes.length === 0 ? (
                    <div className="py-10 text-center">
                      <div className="text-4xl mb-3">🎬</div>
                      <p className="text-sm text-slate-400">还没有创建场次</p>
                      <p className="text-xs text-slate-500 mt-1">点击上方按钮创建第一个场次</p>
                    </div>
                  ) : (
                    sortedScenes.map((scene, sceneIdx) => (
                      <div key={scene.id} className={`flex items-center gap-2 px-3 py-2.5 rounded-2xl border transition ${currentSceneId === scene.id ? 'border-violet-400/40 bg-violet-500/10' : 'border-white/10 hover:bg-white/5'}`}>
                        <button
                          onClick={() => moveScene(scene.id, -1)}
                          disabled={sceneIdx <= 0}
                          className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 transition ${sceneIdx <= 0 ? 'border-white/10 text-slate-600 cursor-not-allowed' : 'border-white/20 text-white/60 hover:bg-violet-500/30 hover:border-violet-400/50'}`}
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => moveScene(scene.id, 1)}
                          disabled={sceneIdx >= sortedScenes.length - 1}
                          className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 transition ${sceneIdx >= sortedScenes.length - 1 ? 'border-white/10 text-slate-600 cursor-not-allowed' : 'border-white/20 text-white/60 hover:bg-violet-500/30 hover:border-violet-400/50'}`}
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setRenameSceneId(scene.id); setRenameSceneName(scene.name); setSceneManagerMode('edit'); }}
                          className="flex-1 text-left text-sm text-white/80 hover:text-white truncate transition"
                          title="点击重命名"
                        >
                          {currentSceneId === scene.id && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-2 align-middle" />}
                          {scene.name}
                        </button>
                        <button
                          onClick={() => {
                            const tip = stats.unclassified > 0
                              ? '该场次下的素材将移到未分类，不会删除。'
                              : '该场次下的素材将变为未分类状态，不会删除。';
                            setGenericConfirm({
                              isOpen: true,
                              title: '删除场次',
                              message: `确认删除场次「${scene.name}」？\n${tip}`,
                              confirmText: '删除',
                              onConfirm: () => {
                                setGenericConfirm(null);
                                deleteScene(scene.id);
                              }
                            });
                          }}
                          className="w-8 h-8 rounded-full border border-white/15 hover:border-red-400/50 hover:bg-red-500/20 flex items-center justify-center text-slate-400 hover:text-red-300 shrink-0 transition"
                          title="删除场次"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                {stats.unclassified > 0 && (
                  <p className="text-xs text-slate-500 mt-3 text-center">另有 {stats.unclassified} 个素材在「未分类」中</p>
                )}
              </>
            )}

            {/* 新建视图 */}
            {sceneManagerMode === 'create' && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <button onClick={() => setSceneManagerMode('list')} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <h2 className="text-base font-semibold">新建场次</h2>
                  <div className="w-8 h-8" />
                </div>
                <input
                  type="text"
                  value={newSceneName}
                  onChange={(e) => setNewSceneName(e.target.value)}
                  placeholder="例如：场景 1 - 客厅"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm transition"
                  onKeyDown={(e) => e.key === 'Enter' && createScene()}
                  autoFocus
                />
                <div className="flex items-center justify-end gap-2 mt-5">
                  <button onClick={() => setSceneManagerMode('list')} className="px-3 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition">取消</button>
                  <button
                    onClick={createScene}
                    disabled={!newSceneName.trim()}
                    className="px-4 py-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 transition"
                  >创建</button>
                </div>
              </>
            )}

            {/* 编辑视图 */}
            {sceneManagerMode === 'edit' && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <button onClick={() => setSceneManagerMode('list')} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <h2 className="text-base font-semibold">重命名场次</h2>
                  <div className="w-8 h-8" />
                </div>
                <input
                  type="text"
                  value={renameSceneName}
                  onChange={(e) => setRenameSceneName(e.target.value)}
                  placeholder="新的场次名称"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm transition"
                  onKeyDown={(e) => e.key === 'Enter' && renameScene()}
                  autoFocus
                />
                <div className="flex items-center justify-between mt-5">
                  <button
                    onClick={() => {
                      if (renameSceneId === null) return;
                      const tip = stats.unclassified > 0
                        ? '该场次下的素材将移到未分类，不会删除。'
                        : '该场次下的素材将变为未分类状态，不会删除。';
                      setGenericConfirm({
                        isOpen: true,
                        title: '删除场次',
                        message: `确认删除本场次？\n${tip}`,
                        confirmText: '删除',
                        onConfirm: () => {
                          setGenericConfirm(null);
                          if (renameSceneId !== null) deleteScene(renameSceneId);
                        }
                      });
                    }}
                    className="px-3 py-2 rounded-xl text-sm text-red-300 hover:text-red-200 hover:bg-red-500/10 transition"
                  >
                    删除本场次
                  </button>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setSceneManagerMode('list')} className="px-3 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition">取消</button>
                    <button
                      onClick={renameScene}
                      disabled={!renameSceneName.trim()}
                      className="px-4 py-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 transition"
                    >保存</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ============ 新增对话框 ============ */}

      {/* 增加分镜 */}
      <AddShotDialog
        isOpen={showAddShotDialog}
        onClose={() => setShowAddShotDialog(false)}
        projectId={projectId}
        sceneId={currentSceneId}
        onAdd={async (shot) => {
          await loadShots();
          await loadStats();
          showToast('分镜已添加');
        }}
      />

      {/* AI 生成分镜 */}
      <AIScriptDialog
        isOpen={showAIScriptDialog}
        onClose={() => setShowAIScriptDialog(false)}
        projectId={projectId}
        sceneId={currentSceneId}
        onSuccess={async (shots) => {
          await loadShots();
          await loadStats();
          const sceneList = await loadScenes();
          if (currentSceneId === null && sceneList.length > 0) {
            setCurrentSceneId(sceneList[0].id);
          }
          showToast(`AI 生成了 ${shots?.length || 0} 个分镜`);
        }}
      />

      {/* AI 生图 */}
      {showAIImageGenDialog && selectedShotForAIGen && (
        <AIImageGenDialog
          isOpen={showAIImageGenDialog}
          onClose={() => { setShowAIImageGenDialog(false); setSelectedShotForAIGen(null); }}
          shot={selectedShotForAIGen}
          onGenerated={async (media) => {
            await loadShots();
            showToast('AI 生图成功');
          }}
        />
      )}

      {/* 视频分割 */}
      {/* 视频分割隐藏文件选择器 */}
      <input
        ref={videoSplitInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => handleSplitVideoUpload(e.target.files)}
      />

      <VideoSplitDialog
        isOpen={showVideoSplitDialog}
        onClose={() => setShowVideoSplitDialog(false)}
        videoUrl={selectedVideoForSplit || ''}
        projectId={projectId}
        sceneId={currentSceneId}
        onSplit={async (shots) => {
          await loadShots();
          await loadStats();
          showToast('视频分割完成');
        }}
      />

      <VideoCompressionDialog
        isOpen={pendingCompressionVideo !== null}
        onClose={() => { setPendingCompressionVideo(null); setPendingCompressionDecision(null); setPendingUploadIndex(-1); }}
        file={pendingCompressionVideo}
        decision={pendingCompressionDecision}
        aliyunConfigured={aliyunConfigured}
        onSelect={handleCompressionSelect}
      />

      {/* 设置 */}
      <SettingsDialog
        isOpen={showSettingsDialog}
        onClose={() => setShowSettingsDialog(false)}
      />

      {/* 费用统计 */}
      <AIUsagePanel
        isOpen={showAIUsagePanel}
        onClose={() => setShowAIUsagePanel(false)}
      />

      {/* 媒体管理 */}
      {selectedShotForMedia && (
        <MediaManagerDialog
          isOpen={showMediaManager}
          onClose={() => { setShowMediaManager(false); setSelectedShotForMedia(null); }}
          shot={selectedShotForMedia}
          onMediaChange={(updatedShot) => {
            setShots(prev => prev.map(item =>
              item.id === updatedShot.id ? { ...item, ...updatedShot } : item
            ));
            setSelectedShotForMedia(updatedShot);
          }}
        />
      )}

      {/* 全屏查看 */}
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
              <img src={getOssProxyUrl(fullscreenItem.url)} alt={fullscreenItem.filename || fullscreenItem.url} className="mx-auto max-w-full max-h-[80vh] object-contain rounded-2xl" />
            ) : (
              <video
                ref={fullscreenVideoRef}
                src={getOssProxyUrl(fullscreenItem.url)}
                poster={getPosterUrl(fullscreenItem.url)}
                controls
                autoPlay
                playsInline
                muted={false}
                className="mx-auto max-w-full max-h-[80vh] rounded-2xl bg-black"
              />
            )}
            <p className="text-center text-sm text-slate-300 mt-4">{fullscreenItem.filename || fullscreenItem.url}</p>
          </div>
        </div>
      )}

      {/* 微信分享提示 */}
      <ShareHint
        isVisible={shareHintVisible}
        onClose={() => setShareHintVisible(false)}
        mode={shareHintMode}
      />

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-[90] px-4 py-2.5 rounded-2xl bg-slate-800/95 border border-white/10 text-sm shadow-xl transition-all duration-300 ${
            toastVisible
              ? 'opacity-100 translate-y-0'
              : 'opacity-0 translate-y-4'
          }`}
        >
          {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 inline mr-2 text-green-400" />}
          {toast.type === 'error' && <XCircle className="w-4 h-4 inline mr-2 text-red-400" />}
          {toast.type === 'info' && <Info className="w-4 h-4 inline mr-2 text-blue-400" />}
          {toast.message}
        </div>
      )}
    </div>
    </div>
  );
}
