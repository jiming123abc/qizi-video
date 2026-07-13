import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Play, CheckCircle2, Trash2, X, FileVideo, Maximize2, Share2, Plus, ArrowLeft, RotateCcw, Image as ImageIcon, Check, GripVertical, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Settings as SettingsIcon, Sparkles, Scissors, BarChart3, Search, XCircle, Info, MoreHorizontal, Merge, Archive } from 'lucide-react';
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
import AIImageGenerateDialog from '../components/ai/AIImageGenerateDialog';
import AIUsagePanel from '../components/ai/AIUsagePanel';

// 设置组件
import SettingsDialog from '../components/settings/SettingsDialog';

// 数字资产组件
import DigitalAssetDialog from '../components/assets/DigitalAssetDialog';

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
    batchUpdateStatus,
    moveShotToScene,
    batchMergeShots,
    handleItemDragStart,
    handleDragHandleMouseDown,
    handleItemDragOver,
    handleItemDrop: handleItemDropApi,
    moveItem: moveItemApi,
  } = useShots({ projectId, showToast });

  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<{ pending: number; done: number; trash: number; unclassified: number }>({ pending: 0, done: 0, trash: 0, unclassified: 0 });
  const [sceneStatsMap, setSceneStatsMap] = useState<Record<string, { done: number; total: number }>>({});
  const [loading, setLoading] = useState(true);
  const [fieldSuggestions, setFieldSuggestions] = useState<{
    location: string[];
    actors: string[];
    costume: string[];
    props: string[];
    shotType: string[];
    focalLength: string[];
    shotAngle: string[];
    lighting: string[];
    cameraMovement: string[];
  } | null>(null);

  // P3-13：从 URL 恢复 tab/scene 状态，刷新后保持上下文
  const initialTab = (() => {
    if (typeof window === 'undefined') return 'pending' as const;
    const params = new URLSearchParams(window.location.search);
    const t = params.get('tab');
    return t === 'done' || t === 'trash' ? t : 'pending';
  })();
  // P3-13：scene 状态从 URL 恢复
  // undefined = URL 中没有 scene 参数（让自动跳转逻辑处理）
  // null = URL 中显式 scene=null（用户上次选择了"未分类"）
  // number = URL 中 scene=<id>（需在 scenes 加载后验证是否存在）
  const initialSceneFromUrl = (() => {
    if (typeof window === 'undefined') return undefined as undefined | null | number;
    const params = new URLSearchParams(window.location.search);
    const s = params.get('scene');
    if (s === null) return undefined;
    if (s === 'null') return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : undefined;
  })();
  const [currentTab, setCurrentTab] = useState<'pending' | 'done' | 'trash'>(initialTab);
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
  const [dragShotId, setDragShotId] = useState<number | null>(null);
  const [dragOverSceneForShot, setDragOverSceneForShot] = useState<number | null | undefined>(undefined);
  const [isCreatingScene, setIsCreatingScene] = useState(false);
  const [isRenamingScene, setIsRenamingScene] = useState(false);

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
  const [mediaRefreshTrigger, setMediaRefreshTrigger] = useState(0);
  const [selectedShotForAIGen, setSelectedShotForAIGen] = useState<Shot | null>(null);
  const [selectedVideoForSplit, setSelectedVideoForSplit] = useState<string | null>(null);
  const [showDigitalAssetDialog, setShowDigitalAssetDialog] = useState(false);
  const [aiSuggestedAssets, setAiSuggestedAssets] = useState<{
    mainActors: Array<{ name: string; imagePrompt: string }>;
    keyProps: Array<{ name: string; imagePrompt: string }>;
    mainScenes: Array<{ name: string; imagePrompt: string }>;
  } | null>(null);

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
  const refreshSuggestionsTimerRef = useRef<NodeJS.Timeout | null>(null);
  // P3-13：URL scene 恢复标记，true 表示已完成恢复（或无需恢复）
  // 初始值：URL 没有 scene 参数时为 true（让自动跳转逻辑正常工作）
  const urlSceneRestoredRef = useRef(initialSceneFromUrl === undefined);

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

  const loadFieldSuggestions = useCallback(async () => {
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/field-suggestions`);
      const data = await res.json();
      if (data.success && data.data) {
        setFieldSuggestions(data.data);
      }
    } catch (e) {
      console.error('加载字段补全建议失败:', e);
    }
  }, [projectId]);

  const loadStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('projectId', String(projectId));
      if (currentSceneId === null) params.set('sceneId', 'null');
      else params.set('sceneId', String(currentSceneId));
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

  const {
    uploadingFiles,
    setUploadingFiles,
    pendingCompressionVideo,
    pendingCompressionDecision,
    pendingCompressionFiles,
    handleUploadFiles,
    cancelUpload,
    handleCompressionDecision,
    aliyunConfigured,
    clearUploadingFiles,
    retryFailedFiles,
  } = useUpload({
    projectId,
    currentSceneId,
    showToast,
    loadShots,
    loadStats,
    loadProject,
  });

  const refreshAll = useCallback(async () => {
    await Promise.all([loadProject(), loadScenes(), loadShots(), loadStats(), loadSceneStats(), loadFieldSuggestions()]);
  }, [loadProject, loadScenes, loadShots, loadStats, loadSceneStats, loadFieldSuggestions]);

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
    // P3-14：切换场次/tab 时清空选中，避免选中不可见分镜导致误操作
    setSelectedIds(new Set());
  }, [currentSceneId, currentTab, loadShots, loadStats, setSelectedIds]);

  // P3-13：从 URL 恢复 scene 状态（仅首次加载时执行一次）
  // - URL 无 scene 参数：立即标记为已恢复，让自动跳转逻辑处理
  // - URL scene=null：标记用户选择了"未分类"，阻止自动跳转
  // - URL scene=<id>：等 scenes 加载后验证，存在则恢复，不存在则让自动跳转处理
  useEffect(() => {
    if (urlSceneRestoredRef.current) return;
    if (initialSceneFromUrl === undefined) {
      urlSceneRestoredRef.current = true;
      return;
    }
    if (initialSceneFromUrl === null) {
      urlSceneRestoredRef.current = true;
      userManualSelectedUnclassifiedRef.current = true;
      // currentSceneId 已为 null，无需设置
      return;
    }
    // initialSceneFromUrl 为数字，需等 scenes 加载完成才能验证
    if (scenes.length === 0) return;
    urlSceneRestoredRef.current = true;
    const exists = scenes.find(s => s.id === initialSceneFromUrl);
    if (exists) {
      setCurrentSceneId(initialSceneFromUrl);
    }
    // 不存在则不设置，让下方自动跳转逻辑处理
  }, [scenes, initialSceneFromUrl, setCurrentSceneId]);

  // 自动跳转场次逻辑：当 currentSceneId === null 且存在场次时，自动跳转到第一个场次
  // 例外：用户手动选择了"未分类"时不强制跳转
  // P3-13：URL 恢复未完成时跳过，避免覆盖 URL 中的 scene 状态
  useEffect(() => {
    if (!urlSceneRestoredRef.current) return;
    if (userManualSelectedUnclassifiedRef.current) return;
    if (currentSceneId === null && scenes.length > 0) {
      setCurrentSceneId(scenes[0].id);
      setSelectedIds(new Set());
    }
  }, [scenes, currentSceneId]);

  // P3-13：tab/scene 变化时同步到 URL（使用 replaceState 避免污染历史记录）
  // URL 恢复完成前不同步，避免覆盖 URL 中已有的状态
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!urlSceneRestoredRef.current) return;
    const params = new URLSearchParams(window.location.search);
    params.set('tab', currentTab);
    params.set('scene', currentSceneId === null ? 'null' : String(currentSceneId));
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  }, [currentTab, currentSceneId]);

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
  const softDeleteWithConfirm = (id: number) => {
    setGenericConfirm({
      isOpen: true,
      title: '删除分镜',
      message: '确定将此分镜移到垃圾桶吗？',
      confirmText: '移到垃圾桶',
      onConfirm: async () => {
        setGenericConfirm(null);
        await softDelete(id);
        await loadStats();
      }
    });
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
  const batchSoftDeleteWithConfirm = () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    setGenericConfirm({
      isOpen: true,
      title: '批量删除',
      message: `确定将所选 ${count} 项移到垃圾桶吗？`,
      confirmText: '移到垃圾桶',
      onConfirm: async () => {
        setGenericConfirm(null);
        await batchSoftDelete();
        await loadStats();
      }
    });
  };

  const batchRestoreWithStats = async () => {
    await batchRestore();
    await loadStats();
  };

  const batchUpdateStatusWithStats = async (status: 'pending' | 'done') => {
    await batchUpdateStatus(status);
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
    if (isCreatingScene) return;
    setIsCreatingScene(true);
    try {
      await createSceneApi(name);
      setNewSceneName('');
      setSceneManagerMode('list');
      setShowSceneManager(false);
      userManualSelectedUnclassifiedRef.current = false;
      await loadStats();
    } finally {
      setIsCreatingScene(false);
    }
  };

  const renameScene = async () => {
    if (renameSceneId === null) return;
    const name = renameSceneName.trim();
    if (!name) return;
    if (isRenamingScene) return;
    setIsRenamingScene(true);
    try {
      await renameSceneApi(renameSceneId, name);
      setRenameSceneId(null);
      setRenameSceneName('');
      setSceneManagerMode('list');
      setShowSceneManager(false);
      await loadStats();
    } finally {
      setIsRenamingScene(false);
    }
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
    setDragShotId(id);
    handleItemDragStart(id, e);
  };

  const handleItemDrop = async (targetId: number) => {
    await handleItemDropApi(targetId, isMobile, scrollItemIntoView);
  };

  const moveItem = async (itemId: number, dir: -1 | 1) => {
    await moveItemApi(itemId, dir, scrollItemIntoView);
  };

  // 分镜拖拽到场景标签移动场次
  const handleShotDragOverScene = (e: React.DragEvent, sceneId: number | null) => {
    if (dragShotId === null) return;
    e.preventDefault();
    setDragOverSceneForShot(sceneId);
  };

  const handleShotDropOnScene = async (sceneId: number | null) => {
    if (dragShotId === null) return;
    if (sceneId === currentSceneId) {
      setDragShotId(null);
      setDragOverSceneForShot(undefined);
      return;
    }
    await moveShotToScene(dragShotId, sceneId);
    await loadStats();
    setDragShotId(null);
    setDragOverSceneForShot(undefined);
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
    const uploadId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
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

  const handleAiGenerate = (s: Shot) => {
    setSelectedShotForAIGen(s);
    setShowAIImageGenDialog(true);
  };

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

      // 如果编辑了补全相关字段，防抖刷新建议列表
      const autocompleteFields = ['location', 'actors', 'costume', 'props', 'shotType', 'focalLength', 'shotAngle', 'lighting', 'cameraMovement'];
      const hasAutocompleteField = autocompleteFields.some(f => f in fields);
      if (hasAutocompleteField) {
        if (refreshSuggestionsTimerRef.current) {
          clearTimeout(refreshSuggestionsTimerRef.current);
        }
        refreshSuggestionsTimerRef.current = setTimeout(() => {
          loadFieldSuggestions();
        }, 800);
      }
    };

    const handleDelete = (id: number) => {
      softDeleteWithConfirm(id);
    };

    const handleDeleteMedia = async (shotId: number, mediaId: number) => {
      try {
        await fetch(`/api/video2/shots/${shotId}/media/${mediaId}`, {
          method: 'DELETE'
        });
        setShots(prev => prev.map(shot => {
          if (shot.id !== shotId) return shot;
          return {
            ...shot,
            media: (shot.media || []).filter(m => m.id !== mediaId)
          };
        }));
        showToast('素材已删除');
      } catch (e) {
        console.error('删除素材失败:', e);
        showToast('删除失败', 'error');
      }
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

    const handleSplitVideo = (s: Shot) => {
      const videoUrl = s.media?.find(m => m.type === 'video')?.url || '';
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
        draggable={currentTab !== 'trash' && !searchQuery.trim()}
        onDragStart={(e) => {
          handleItemDragStartWrap(shot.id, e);
          try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
        }}
        onDragEnd={() => { setDragItemId(null); setDragOverItemId(null); setDragShotId(null); setDragOverSceneForShot(null); }}
        className={`relative transition-all duration-200 ${
          dragItemId === shot.id ? 'opacity-60 scale-[0.98]' : ''
        } ${dragOverItemId === shot.id && dragItemId !== shot.id ? 'ring-2 ring-violet-400/70 ring-offset-2 ring-offset-slate-900 rounded-2xl' : ''}`}
      >
        {dragOverItemId === shot.id && dragItemId !== shot.id && dragItemId !== null && (
          <div className="absolute -top-1 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-500 to-fuchsia-500 rounded-full z-10 pointer-events-none" />
        )}
        <ShotCard
          shot={shot}
          projectId={projectId}
          fieldSuggestions={fieldSuggestions}
          isSelected={isSelected}
          highlighted={highlightedShotId === shot.id}
          onSelect={(s) => toggleSelect(s.id)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onHardDelete={hardDeleteWithConfirm}
          onRestore={restoreItemWithStats}
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
          dragDisabled={searchQuery.trim() !== ''}
          onStatusClick={(s) => toggleStatus(s)}
          onShotNoClick={handleShotNoClick}
          onDragHandleMouseDown={handleDragHandleMouseDown}
          onVideoPlay={handleVideoPlay}
          onVideoPause={handleVideoPause}
          playingVideoKey={playingVideoKey}
          onVideoRefReady={handleVideoRefReady}
          onDeleteMedia={handleDeleteMedia}
          onOpenSettings={() => setShowSettingsDialog(true)}
          onShowToast={showToast}
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

  // ============ 渲染 ============
  return (
    <div
      className="min-h-[100dvh] bg-gradient-to-br from-slate-900 via-violet-950 to-pink-950 text-white pb-28"
    >
      {loading ? (
        <div className="min-h-[100dvh] flex flex-col items-center justify-center">
          <div className="relative">
            <div className="w-16 h-16 rounded-full border-4 border-violet-500/20 border-t-violet-500 animate-spin" />
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 blur-xl -z-10" />
          </div>
          <div className="mt-6 text-slate-300 text-sm">加载中...</div>
          {project && (
            <div className="mt-2 text-slate-500 text-xs">{project.name}</div>
          )}
        </div>
      ) : (
        <>
          {/* 顶部栏 */}
      <div className="sticky top-0 z-30 backdrop-blur-xl bg-slate-900/80 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 sm:py-3 flex items-center gap-3">
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
              className="w-full text-lg sm:text-2xl font-bold bg-transparent border-b border-transparent hover:border-white/20 focus:border-violet-400/60 outline-none transition truncate whitespace-nowrap overflow-hidden"
              title={project?.name || '点击编辑项目名称'}
            />
            {project?.description && (
              <p className="text-xs sm:text-sm text-slate-400 hidden sm:block truncate mt-0.5">{project.description}</p>
            )}
          </div>
          {/* 工具按钮组（桌面端图标，移动端文字） */}
          <div className="hidden sm:flex items-center gap-1">
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
              onClick={() => { setPlayingItemId(null); setShowVideoSplitDialog(true); }}
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

            {/* 数字资产管理 */}
            <button
              onClick={() => { setPlayingItemId(null); setShowDigitalAssetDialog(true); }}
              className="w-9 h-9 rounded-full border border-violet-400/40 bg-white/5 hover:bg-gradient-to-br hover:from-violet-500 hover:to-fuchsia-500 hover:border-transparent flex items-center justify-center transition"
              title="数字资产管理"
            >
              <Archive className="w-4 h-4 text-white/90" />
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
                      onClick={() => { setShowMobileMoreMenu(false); setPlayingItemId(null); setShowVideoSplitDialog(true); }}
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
                    <button
                      onClick={() => { setShowMobileMoreMenu(false); setPlayingItemId(null); setShowDigitalAssetDialog(true); }}
                      className="w-full px-4 py-2.5 text-left text-sm hover:bg-white/5 flex items-center gap-2 transition"
                    >
                      <Archive className="w-4 h-4 text-violet-300" />
                      数字资产管理
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
        <div className="sticky top-0 z-20 bg-gradient-to-br from-slate-900 via-violet-950/50 to-pink-950/30 pt-1 pb-0">
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
            dragShotId={dragShotId}
            dragOverSceneForShot={dragOverSceneForShot}
            onShotDragOverScene={handleShotDragOverScene}
            onShotDropOnScene={handleShotDropOnScene}
            onShotDragLeaveScene={() => setDragOverSceneForShot(undefined)}
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
                {currentTab === 'pending' && (
                  <button
                    onClick={() => batchUpdateStatusWithStats('done')}
                    className="px-3 py-1.5 rounded-full text-xs border border-white/20 bg-white/5 hover:bg-white/10 transition"
                  >
                    标记为已拍摄
                  </button>
                )}
                {currentTab === 'done' && (
                  <button
                    onClick={() => batchUpdateStatusWithStats('pending')}
                    className="px-3 py-1.5 rounded-full text-xs border border-white/20 bg-white/5 hover:bg-white/10 transition"
                  >
                    移动到未拍摄
                  </button>
                )}
                <button
                  onClick={batchSoftDeleteWithConfirm}
                  className="px-3 py-1.5 rounded-full text-xs border border-white/20 bg-white/5 hover:bg-white/10 transition"
                >
                  <Trash2 className="w-3.5 h-3.5 inline mr-1" /> 删除
                </button>
              </>
            )}
            </div>
          </div>
        )}
      </div>

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
          <div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredShots.map((shot, idx) => renderShotCard(shot, idx, filteredShots.length))}
            </div>
            {currentTab === 'pending' && (
              <button
                onClick={() => setShowAddShotDialog(true)}
                className="mt-4 w-full py-3 rounded-2xl border-2 border-dashed border-violet-400/30 bg-violet-500/5 hover:bg-violet-500/10 text-violet-300 text-sm font-medium transition flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                增加分镜
              </button>
            )}
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowMoveModal(false)}>
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowMergeConfirm(false)}>
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { setShowShotNoDialog(null); setShotNoInputValue(''); }}>
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
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowConfirmDialog(null)}>
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
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { genericConfirm.onCancel?.(); setGenericConfirm(null); }}>
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
        uploadingFiles={uploadingFiles}
        onUploadFiles={handleUploadFiles}
        onCancelUpload={cancelUpload}
        pendingCompressionVideo={pendingCompressionVideo}
        pendingCompressionDecision={pendingCompressionDecision}
        pendingCompressionFiles={pendingCompressionFiles}
        onCompressionDecision={handleCompressionDecision}
        aliyunConfigured={aliyunConfigured}
        currentSceneName={currentSceneId === null ? '未分类' : (scenes.find(s => s.id === currentSceneId)?.name || '')}
        onRetryFailed={retryFailedFiles}
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
        isCreating={isCreatingScene}
        isRenaming={isRenamingScene}
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
        fieldSuggestions={fieldSuggestions}
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
        onSuccess={async (result) => {
          const shots = result.shots || [];
          const assets = result.digitalAssets;
          if (assets && (assets.mainActors?.length || assets.keyProps?.length || assets.mainScenes?.length)) {
            setAiSuggestedAssets(assets);
          }
          await loadShots();
          await loadStats();
          await loadFieldSuggestions();
          const sceneList = await loadScenes();
          if (currentSceneId === null && sceneList.length > 0) {
            setCurrentSceneId(sceneList[0].id);
          }
          showToast(`AI 生成了 ${shots.length} 个分镜`);
        }}
        onOpenSettings={() => setShowSettingsDialog(true)}
      />

      {/* AI 生图（统一对话框：分镜模式） */}
      {showAIImageGenDialog && selectedShotForAIGen && (
        <AIImageGenerateDialog
          isOpen={showAIImageGenDialog}
          onClose={() => { setShowAIImageGenDialog(false); setSelectedShotForAIGen(null); }}
          shot={selectedShotForAIGen}
          ownerType="shot"
          projectId={projectId}
          sceneShots={shots.filter(s => s.sceneId === selectedShotForAIGen.sceneId)}
          onUseImage={async (imageUrl) => {
            const shotId = selectedShotForAIGen.id;
            await fetch(`/api/video2/shots/${shotId}/media`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: imageUrl, type: 'image', source: 'ai_generated' })
            });
            await loadShots();
            setMediaRefreshTrigger(prev => prev + 1);
            showToast('AI 生图成功');
          }}
          onOpenSettings={() => setShowSettingsDialog(true)}
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
        projectId={projectId}
        sceneId={currentSceneId}
        maxUploads={5}
        onSplit={async (shots, videoUrl) => {
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

      {/* 数字资产管理 */}
      <DigitalAssetDialog
        isOpen={showDigitalAssetDialog}
        onClose={() => setShowDigitalAssetDialog(false)}
        projectId={projectId}
        aiSuggestedAssets={aiSuggestedAssets}
        onAssetsImported={() => {
          loadFieldSuggestions();
        }}
      />

      {/* 媒体管理 */}
      {selectedShotForMedia && (
        <MediaManagerDialog
          isOpen={showMediaManager}
          onClose={() => { setShowMediaManager(false); setSelectedShotForMedia(null); }}
          shot={selectedShotForMedia}
          refreshTrigger={mediaRefreshTrigger}
          onAiGenerate={handleAiGenerate}
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
          className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[90] px-6 py-3 rounded-2xl bg-slate-800/95 border border-white/10 text-sm shadow-xl transition-all duration-300 ${
            toastVisible
              ? 'opacity-100 scale-100'
              : 'opacity-0 scale-95'
          }`}
        >
          {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 inline mr-2 text-green-400" />}
          {toast.type === 'error' && <XCircle className="w-4 h-4 inline mr-2 text-red-400" />}
          {toast.type === 'info' && <Info className="w-4 h-4 inline mr-2 text-blue-400" />}
          {toast.message}
        </div>
      )}
        </>
      )}
    </div>
  );
}
