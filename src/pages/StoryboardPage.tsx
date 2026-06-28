import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Play, CheckCircle2, Trash2, X, FileVideo, Maximize2, Share2, Plus, ArrowLeft, RotateCcw, Image as ImageIcon, Link2, Check, GripVertical, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Settings as SettingsIcon, Sparkles, Scissors, BarChart3, Search, XCircle, Info, MoreHorizontal, Merge } from 'lucide-react';
import { setupShareMetadata, copyToClipboard, isWeChat as checkIsWeChat } from '../lib/shareUtils';
import { uploadVideo2Video, detectFileType } from '../lib/ossUtils';
import { useSignedUrl } from '../hooks/useSignedUrl';
import { ShareHint } from '../components/WeChatShareHint';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { useToast } from '../hooks/useToast';
import { useScenes } from '../hooks/useScenes';
import { useShots } from '../hooks/useShots';
import { useUpload } from '../hooks/useUpload';
import type { UploadingFile } from '../hooks/useUpload';

// 分镜组件
import { ShotCard } from '../components/storyboard/ShotCard';
import { ShotSearchBar } from '../components/storyboard/ShotSearchBar';
import { ShotSkeleton } from '../components/storyboard/ShotSkeleton';
import { EmptyState } from '../components/storyboard/EmptyState';
import { BottomTabBar } from '../components/storyboard/BottomTabBar';
import MediaManagerDialog from '../components/storyboard/MediaManagerDialog';
import AddShotDialog from '../components/storyboard/AddShotDialog';
import VideoSplitDialog from '../components/storyboard/VideoSplitDialog';
import { SceneTabs } from '../components/storyboard/SceneTabs';
import { SceneManager } from '../components/storyboard/SceneManager';
import { UploadDialog } from '../components/storyboard/UploadDialog';
import { MediaFullscreen } from '../components/storyboard/MediaFullscreen';

// AI 组件
import AIScriptDialog from '../components/ai/AIScriptDialog';
import AIImageGenDialog from '../components/ai/AIImageGenDialog';
import AIUsagePanel from '../components/ai/AIUsagePanel';

// 设置组件
import SettingsDialog from '../components/settings/SettingsDialog';

// 类型
import type { Shot, ShotMedia, Project, Scene } from '../lib/types';

interface StoryboardPageProps {
  projectId: number;
  onBack?: () => void;
}

// 视频 poster（OSS 截图）
function getPosterUrl(videoUrl: string): string {
  if (videoUrl && (videoUrl.includes('aliyuncs.com') || videoUrl.includes('qiziwenhua.top'))) {
    return videoUrl + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
  }
  return '';
}

export function StoryboardPage({ projectId, onBack }: StoryboardPageProps) {
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

  const {
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
  } = useUpload({
    projectId,
    currentSceneId,
    showToast,
    loadShots,
    loadStats,
    loadProject,
  });

  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<{ pending: number; done: number; trash: number; unclassified: number }>({ pending: 0, done: 0, trash: 0, unclassified: 0 });
  const [sceneStatsMap, setSceneStatsMap] = useState<Record<string, { done: number; total: number }>>({});
  const [loading, setLoading] = useState(true);

  const [currentTab, setCurrentTab] = useState<'pending' | 'done' | 'trash'>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchDialog, setShowSearchDialog] = useState(false);
  const [showDesktopSearch, setShowDesktopSearch] = useState(false);
  const [highlightedShotId, setHighlightedShotId] = useState<number | null>(null);

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
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  // 视频互斥播放
  const [playingVideoKey, setPlayingVideoKey] = useState<string | null>(null);

  const handleVideoRefReady = useCallback((key: string, ref: HTMLVideoElement | null) => {
    if (ref) {
      videoRefs.current.set(key, ref);
    } else {
      videoRefs.current.delete(key);
    }
  }, []);



  const handleVideoPlay = useCallback((shotId: number, mediaId: number) => {
    const key = `${shotId}-${mediaId}`;
    videoRefs.current.forEach((v, k) => {
      if (k !== key) {
        try { v.pause(); } catch (_) {}
      }
    });
    setPlayingVideoKey(key);
  }, []);

  const handleVideoPause = useCallback((shotId: number, mediaId: number) => {
    const key = `${shotId}-${mediaId}`;
    if (playingVideoKey === key) {
      setPlayingVideoKey(null);
    }
  }, [playingVideoKey]);

  const [fullscreenItem, setFullscreenItem] = useState<ShotMedia | null>(null);
  const fullscreenVideoRef = useRef<HTMLVideoElement>(null);
  const signedFullscreenUrl = useSignedUrl(fullscreenItem?.url);
  const signedFullscreenPoster = useSignedUrl(fullscreenItem?.url ? getPosterUrl(fullscreenItem.url) : undefined);

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

  // 互斥播放：打开弹窗/切换时暂停所有视频
  const [playingItemId, setPlayingItemId] = useState<number | null>(null);

  useEffect(() => {
    if (playingItemId === null) {
      videoRefs.current.forEach((v) => {
        try { v.pause(); } catch (_) {}
      });
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

  const loadSceneStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/video2/scene-stats?projectId=${projectId}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        const map: Record<string, { done: number; total: number }> = {};
        data.data.forEach((s: any) => {
          const key = s.id === null ? 'null' : String(s.id);
          map[key] = { done: s.done, total: s.total };
        });
        setSceneStatsMap(map);
      }
    } catch (e) {
      console.error('加载场次统计失败:', e);
    }
  }, [projectId]);

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
    await Promise.all([loadProject(), loadScenes(), loadShots(), loadStats(), loadSceneStats()]);
  }, [loadProject, loadScenes, loadShots, loadStats, loadSceneStats]);

  useEffect(() => {
    setLoading(true);
    refreshAll().then(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SEO / 分享元数据
  useEffect(() => {
    if (!project) return;
    document.title = project.name + ' · 柒子文化AI拍摄辅助系统';
    setupShareMetadata({
      title: project.name,
      desc: project.description || '柒子文化AI拍摄辅助系统 - 专业项目管理',
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
      loadSceneStats();
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

  // ============ 上传对话框关闭逻辑 ============
  const handleCloseUploadDialog = () => {
    const isUploading = uploadingFiles.some(f => f.status === 'uploading');
    if (!isUploading) {
      setShowUploadDialog(false);
      clearUploadingFiles();
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
          cancelUpload();
          setShowUploadDialog(false);
        },
        onCancel: () => {
          setGenericConfirm(null);
          setShowUploadDialog(false);
        }
      });
    }
  };

  const handleUrlInputChange = (val: string) => {
    setUrlInputValue(val);
    if (val.trim()) {
      try {
        const u = new URL(val);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          setUrlError('仅支持 HTTP/HTTPS 链接');
        } else {
          setUrlError('');
        }
      } catch {
        setUrlError('请输入有效的 URL 地址');
      }
    } else {
      setUrlError('');
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
          highlighted={highlightedShotId === shot.id}
          onSelect={(s) => toggleSelect(s.id)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
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
          onVideoRefReady={handleVideoRefReady}
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
          shot.narration?.toLowerCase().includes(query) ||
          shot.shotNo?.toLowerCase().includes(query)
        );
      });

  // # 编号快速定位
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed.startsWith('#')) {
      setHighlightedShotId(null);
      return;
    }
    const shotNoQuery = trimmed.slice(1).toLowerCase();
    if (!shotNoQuery) return;
    const target = sortedShots.find(s => s.shotNo?.toLowerCase().includes(shotNoQuery));
    if (target) {
      setHighlightedShotId(target.id);
      const timer = setTimeout(() => {
        const el = document.getElementById(`shot-card-${target.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 50);
      const clearTimer = setTimeout(() => setHighlightedShotId(null), 2500);
      return () => { clearTimeout(timer); clearTimeout(clearTimer); };
    } else {
      setHighlightedShotId(null);
    }
  }, [searchQuery, sortedShots]);

  // 上传按钮是否可用
  const uploadAvailable = currentTab === 'pending';

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-slate-900 via-violet-950 to-pink-950 text-white pb-28"
    >
      {/* 顶部栏 */}
      <div className="sticky top-0 z-30 backdrop-blur-xl bg-slate-900/80 border-b border-white/10">
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

            {/* 搜索（垃圾桶模式下隐藏） */}
            {currentTab !== 'trash' && (
              <ShotSearchBar
                value={searchQuery}
                onChange={(v) => {
                  setSearchQuery(v);
                  setSelectedIds(new Set());
                  setPlayingVideoKey(null);
                }}
                variant="icon"
                isOpen={showDesktopSearch}
                onOpenChange={setShowDesktopSearch}
              />
            )}

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

          {/* 移动端：搜索 + 更多菜单 + 上传（垃圾桶模式下隐藏搜索） */}
          <div className="flex sm:hidden items-center gap-1 relative">
            {currentTab !== 'trash' && (
              <button
                onClick={() => setShowSearchDialog(true)}
                className="w-8 h-8 rounded-full border border-violet-400/40 bg-white/5 hover:bg-violet-500/30 flex items-center justify-center transition"
                title="搜索"
              >
                <Search className="w-4 h-4 text-white/80" />
              </button>
            )}
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
                      onClick={() => { setShowMobileMoreMenu(false); setPlayingItemId(null); setShowAIScriptDialog(true); }}
                      className="w-full px-4 py-2.5 text-left text-sm hover:bg-white/5 flex items-center gap-2 transition"
                    >
                      <Sparkles className="w-4 h-4 text-violet-300" />
                      AI 生成分镜
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

        {/* 场次 Tab 栏（sticky 常驻顶部） */}
        <div className="sticky top-0 z-20 bg-gradient-to-br from-slate-900 via-violet-950/50 to-pink-950/30 pt-2 pb-1">
          <SceneTabs
            scenes={scenes}
            sortedScenes={sortedScenes}
            currentSceneId={currentSceneId}
            onSelectScene={(sceneId) => { setCurrentSceneId(sceneId); setSelectedIds(new Set()); }}
            onOpenSceneManager={() => { setPlayingItemId(null); setSceneManagerMode('list'); setShowSceneManager(true); }}
            onRenameScene={(scene) => {
              setPlayingItemId(null);
              setRenameSceneId(scene.id);
              setRenameSceneName(scene.name);
              setSceneManagerMode('edit');
              setShowSceneManager(true);
            }}
            dragSceneId={dragSceneId}
            setDragSceneId={setDragSceneId}
            dragOverSceneId={dragOverSceneId}
            setDragOverSceneId={setDragOverSceneId}
            handleSceneDragStart={handleSceneDragStart}
            handleSceneDragOver={handleSceneDragOver}
            handleSceneDrop={handleSceneDrop}
            canScrollLeft={canScrollLeft}
            canScrollRight={canScrollRight}
            sceneTabRef={sceneTabRef}
            updateSceneScrollState={updateSceneScrollState}
            scrollSceneTabs={scrollSceneTabs}
            sceneStatsMap={sceneStatsMap}
            unclassifiedCount={stats.unclassified}
            isMobile={isMobile}
            onSelectUnclassified={() => {
              userManualSelectedUnclassifiedRef.current = true;
              setCurrentSceneId(null);
              setSelectedIds(new Set());
            }}
          />
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
      <UploadDialog
        isOpen={showUploadDialog}
        onClose={handleCloseUploadDialog}
        uploadTab={uploadTab}
        setUploadTab={setUploadTab}
        uploadingFiles={uploadingFiles}
        urlInputValue={urlInputValue}
        setUrlInputValue={handleUrlInputChange}
        urlError={urlError}
        onUploadFiles={handleUploadFiles}
        onUploadFromUrl={handleUploadFromUrl}
        onCancelUpload={cancelUpload}
        pendingCompressionVideo={pendingCompressionVideo}
        pendingCompressionDecision={pendingCompressionDecision}
        onCompressionDecision={handleCompressionDecision}
        aliyunConfigured={aliyunConfigured}
        currentSceneName={currentSceneId === null ? '未分类' : (scenes.find(s => s.id === currentSceneId)?.name || '')}
      />

      {/* 场次管理面板 */}
      <SceneManager
        isOpen={showSceneManager}
        onClose={() => setShowSceneManager(false)}
        scenes={sortedScenes}
        mode={sceneManagerMode}
        setMode={setSceneManagerMode}
        newSceneName={newSceneName}
        setNewSceneName={setNewSceneName}
        renameSceneId={renameSceneId}
        setRenameSceneId={setRenameSceneId}
        renameSceneName={renameSceneName}
        setRenameSceneName={setRenameSceneName}
        onCreateScene={createScene}
        onRenameScene={renameScene}
        onDeleteScene={deleteScene}
        currentSceneId={currentSceneId}
        onSelectScene={(id) => { setCurrentSceneId(id); setSelectedIds(new Set()); }}
        sceneStatsMap={sceneStatsMap}
        currentTab={currentTab}
        moveScene={moveScene}
        unclassifiedCount={stats.unclassified}
        onRequestDeleteConfirm={(sceneId, sceneName, onConfirm) => {
          const tip = stats.unclassified > 0
            ? '该场次下的素材将移到未分类，不会删除。'
            : '该场次下的素材将变为未分类状态，不会删除。';
          setGenericConfirm({
            isOpen: true,
            title: '删除场次',
            message: `确认删除场次「${sceneName}」？\n${tip}`,
            confirmText: '删除',
            onConfirm: () => {
              setGenericConfirm(null);
              onConfirm();
            }
          });
        }}
      />

      {/* ============ 新增对话框 ============ */}

      {/* 移动端搜索对话框 */}
      <ShotSearchBar
        value={searchQuery}
        onChange={(v) => {
          setSearchQuery(v);
          setSelectedIds(new Set());
          setPlayingVideoKey(null);
        }}
        variant="dialog"
        isOpen={showSearchDialog}
        onOpenChange={setShowSearchDialog}
      />

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



      {/* 设置 */}
      <SettingsDialog
        isOpen={showSettingsDialog}
        onClose={() => setShowSettingsDialog(false)}
        projectId={projectId}
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
      <MediaFullscreen
        isOpen={fullscreenItem !== null}
        onClose={() => setFullscreenItem(null)}
        mediaType={fullscreenItem?.type || 'image'}
        mediaUrl={fullscreenItem?.url || ''}
        filename={fullscreenItem?.filename}
        videoRefCallback={(ref) => {
          if (ref) {
            fullscreenVideoRef.current = ref;
          }
        }}
      />

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
