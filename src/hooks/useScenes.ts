import { useState, useCallback, useRef, type Dispatch, type SetStateAction, type RefObject, type DragEvent } from 'react';
import type { Scene } from '../lib/types';

interface UseScenesOptions {
  projectId: number;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

interface UseScenesReturn {
  scenes: Scene[];
  setScenes: Dispatch<SetStateAction<Scene[]>>;
  currentSceneId: number | null;
  setCurrentSceneId: Dispatch<SetStateAction<number | null>>;
  dragSceneId: number | null;
  setDragSceneId: Dispatch<SetStateAction<number | null>>;
  dragOverSceneId: number | null;
  setDragOverSceneId: Dispatch<SetStateAction<number | null>>;
  canScrollLeft: boolean;
  canScrollRight: boolean;
  sceneTabRef: RefObject<HTMLDivElement>;
  sortedScenes: Scene[];
  loadScenes: () => Promise<Scene[]>;
  createScene: (name: string) => Promise<void>;
  renameScene: (id: number, name: string) => Promise<void>;
  deleteScene: (id: number) => Promise<void>;
  handleSceneDragStart: (id: number) => void;
  handleSceneDragOver: (e: DragEvent, id: number) => void;
  handleSceneDrop: (targetId: number) => Promise<void>;
  moveScene: (sceneId: number, dir: -1 | 1) => Promise<void>;
  updateSceneScrollState: () => void;
  scrollSceneTabs: (direction: 'left' | 'right') => void;
}

export function useScenes({ projectId, showToast }: UseScenesOptions): UseScenesReturn {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [currentSceneId, setCurrentSceneId] = useState<number | null>(null);
  const [dragSceneId, setDragSceneId] = useState<number | null>(null);
  const [dragOverSceneId, setDragOverSceneId] = useState<number | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const sceneTabRef = useRef<HTMLDivElement>(null);

  const sortedScenes = [...scenes].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const loadScenes = useCallback(async (): Promise<Scene[]> => {
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/scenes`);
      const data = await res.json();
      if (data.success) {
        const list: Scene[] = data.data || [];
        list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        setScenes(list);
        return list;
      }
    } catch (e) {
      console.error('加载场次失败:', e);
    }
    return [];
  }, [projectId]);

  const createScene = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const res = await fetch(`/api/video2/projects/${projectId}/scenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed })
      });
      const data = await res.json();
      if (data.success) {
        await loadScenes();
        showToast('已创建场次');
      }
    } catch (e) {
      console.error('创建场次失败:', e);
    }
  }, [projectId, loadScenes, showToast]);

  const renameScene = useCallback(async (id: number, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await fetch(`/api/video2/scenes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed })
      });
      await loadScenes();
      showToast('场次已重命名');
    } catch (e) {
      console.error('重命名失败:', e);
    }
  }, [loadScenes, showToast]);

  const deleteScene = useCallback(async (id: number) => {
    try {
      await fetch(`/api/video2/scenes/${id}`, { method: 'DELETE' });
      if (currentSceneId === id) setCurrentSceneId(null);
      await loadScenes();
      showToast('场次已删除');
    } catch (e) {
      console.error('删除场次失败:', e);
    }
  }, [currentSceneId, loadScenes, showToast]);

  const reorderScenes = useCallback(async (dragId: number, targetId: number) => {
    const sorted = [...scenes].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const dragIdx = sorted.findIndex(s => s.id === dragId);
    const targetIdx = sorted.findIndex(s => s.id === targetId);
    if (dragIdx < 0 || targetIdx < 0) return;

    const next = [...sorted];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(targetIdx, 0, moved);
    const orders = next.map((s, idx) => ({ id: s.id, sortOrder: idx }));
    setScenes(next.map((s, idx) => ({ ...s, sortOrder: idx })));

    try {
      await fetch('/api/video2/scenes/sort', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders })
      });
    } catch (e) {
      console.error('更新场次排序失败:', e);
    }
  }, [scenes]);

  const handleSceneDragStart = useCallback((id: number) => {
    setDragSceneId(id);
  }, []);

  const handleSceneDragOver = useCallback((e: DragEvent, id: number) => {
    e.preventDefault();
    if (dragSceneId === null || dragSceneId === id) return;
    setDragOverSceneId(id);
  }, [dragSceneId]);

  const handleSceneDrop = useCallback(async (targetId: number) => {
    if (dragSceneId === null || dragSceneId === targetId) {
      setDragSceneId(null);
      setDragOverSceneId(null);
      return;
    }
    await reorderScenes(dragSceneId, targetId);
    setDragSceneId(null);
    setDragOverSceneId(null);
  }, [dragSceneId, reorderScenes]);

  const moveScene = useCallback(async (sceneId: number, dir: -1 | 1) => {
    const sorted = [...scenes].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const idx = sorted.findIndex(s => s.id === sceneId);
    if (idx < 0) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= sorted.length) return;

    const next = [...sorted];
    [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
    const orders = next.map((s, i) => ({ id: s.id, sortOrder: i }));
    setScenes(next.map((s, i) => ({ ...s, sortOrder: i })));

    try {
      await fetch('/api/video2/scenes/sort', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders })
      });
    } catch (e) {
      console.error('更新场次排序失败:', e);
    }
  }, [scenes]);

  const updateSceneScrollState = useCallback(() => {
    const el = sceneTabRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 5);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 5);
  }, []);

  const scrollSceneTabs = useCallback((direction: 'left' | 'right') => {
    const el = sceneTabRef.current;
    if (!el) return;
    const scrollAmount = el.clientWidth * 0.6;
    el.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    });
  }, []);

  return {
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
    createScene,
    renameScene,
    deleteScene,
    handleSceneDragStart,
    handleSceneDragOver,
    handleSceneDrop,
    moveScene,
    updateSceneScrollState,
    scrollSceneTabs,
  };
}
