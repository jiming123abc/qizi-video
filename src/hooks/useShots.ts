import { useState, useCallback, useRef, type Dispatch, type SetStateAction, type MutableRefObject, type DragEvent } from 'react';
import type { Shot } from '../lib/types';

interface UseShotsOptions {
  projectId: number;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

interface UseShotsReturn {
  shots: Shot[];
  setShots: Dispatch<SetStateAction<Shot[]>>;
  shotsLoading: boolean;
  setShotsLoading: Dispatch<SetStateAction<boolean>>;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
  dragItemId: number | null;
  setDragItemId: Dispatch<SetStateAction<number | null>>;
  dragOverItemId: number | null;
  setDragOverItemId: Dispatch<SetStateAction<number | null>>;
  dragHandlePressedRef: MutableRefObject<boolean>;
  loadShots: (sceneId: number | null, tab: 'pending' | 'done' | 'trash') => Promise<void>;
  toggleSelect: (id: number) => void;
  selectAll: () => void;
  updateShot: (id: number, fields: Partial<Shot>) => Promise<void>;
  updateShotStatus: (shotId: number, status: 'pending' | 'done', shotNo?: string) => Promise<void>;
  updateShotNo: (shot: Shot, shotNo: string) => Promise<void>;
  softDelete: (id: number) => Promise<void>;
  restoreItem: (id: number) => Promise<void>;
  hardDelete: (id: number, onConfirm: (fn: () => Promise<void>) => void) => void;
  batchSoftDelete: () => Promise<void>;
  batchRestore: () => Promise<void>;
  batchHardDelete: (onConfirm: (fn: () => Promise<void>) => void) => void;
  batchMoveToScene: (sceneId: number | null) => Promise<void>;
  batchMergeShots: (onReload: () => Promise<void>) => Promise<void>;
  handleItemDragStart: (id: number, e: DragEvent) => void;
  handleDragHandleMouseDown: () => void;
  handleItemDragOver: (e: DragEvent, id: number) => void;
  handleItemDrop: (targetId: number, isMobile: boolean, scrollIntoView: (id: number) => void) => Promise<void>;
  moveItem: (itemId: number, dir: -1 | 1, scrollIntoView: (id: number) => void) => Promise<void>;
  cloneShot: (id: number, onReload: () => Promise<void>) => Promise<void>;
}

export function useShots({ projectId, showToast }: UseShotsOptions): UseShotsReturn {
  const [shots, setShots] = useState<Shot[]>([]);
  const [shotsLoading, setShotsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [dragItemId, setDragItemId] = useState<number | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<number | null>(null);
  const dragHandlePressedRef = useRef(false);

  const loadShots = useCallback(async (sceneId: number | null, tab: 'pending' | 'done' | 'trash') => {
    setShotsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('projectId', String(projectId));
      if (tab !== 'trash') {
        if (sceneId === null) {
          params.set('sceneId', 'null');
        } else {
          params.set('sceneId', String(sceneId));
        }
      }
      if (tab === 'trash') params.set('deleted', '1');
      else params.set('status', tab);
      const res = await fetch(`/api/video2/list?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        const list: Shot[] = (data.data || []).slice();
        list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        setShots(list);
      }
    } catch (e) {
      console.error('加载列表失败:', e);
    } finally {
      setShotsLoading(false);
    }
  }, [projectId]);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(prev => {
      let allSelected = true;
      shots.forEach(s => { if (!prev.has(s.id)) allSelected = false; });
      if (allSelected) return new Set();
      return new Set(shots.map(s => s.id));
    });
  }, [shots]);

  const updateShot = useCallback(async (id: number, fields: Partial<Shot>) => {
    try {
      const res = await fetch(`/api/video2/shots/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
      });
      const data = await res.json();
      if (data.success !== false) {
        setShots(prev => prev.map(it => it.id === id ? { ...it, ...fields } : it));
      }
    } catch (e) {
      console.error('更新分镜失败:', e);
    }
  }, []);

  const updateShotStatus = useCallback(async (shotId: number, status: 'pending' | 'done', shotNo?: string) => {
    try {
      const body: any = { status };
      if (shotNo !== undefined) body.shotNo = shotNo;
      await fetch(`/api/video2/shots/${shotId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      setShots(prev => prev.filter(it => it.id !== shotId));
      showToast(status === 'done' ? '已标记为已拍摄' : '已回到未拍摄');
    } catch (e) {
      console.error('更新状态失败:', e);
    }
  }, [showToast]);

  const updateShotNo = useCallback(async (shot: Shot, shotNo: string) => {
    try {
      await fetch(`/api/video2/shots/${shot.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotNo: shotNo.trim() })
      });
      setShots(prev => prev.map(it => it.id === shot.id ? { ...it, shotNo: shotNo.trim() || undefined } : it));
      showToast('镜头编号已更新');
    } catch (e) {
      console.error('更新镜头号失败:', e);
    }
  }, [showToast]);

  const softDelete = useCallback(async (id: number) => {
    try {
      await fetch(`/api/video2/shots/${id}`, { method: 'DELETE' });
      setShots(prev => prev.filter(it => it.id !== id));
      showToast('已移到垃圾桶');
    } catch (e) {
      console.error('删除失败:', e);
    }
  }, [showToast]);

  const restoreItem = useCallback(async (id: number) => {
    try {
      await fetch(`/api/video2/shots/${id}/restore`, { method: 'POST' });
      setShots(prev => prev.filter(it => it.id !== id));
      showToast('已恢复');
    } catch (e) {
      console.error('恢复失败:', e);
    }
  }, [showToast]);

  const hardDelete = useCallback((id: number, onConfirm: (fn: () => Promise<void>) => void) => {
    onConfirm(async () => {
      try {
        await fetch(`/api/video2/shots/${id}/hard`, { method: 'DELETE' });
        setShots(prev => prev.filter(it => it.id !== id));
        showToast('已彻底删除');
      } catch (e) {
        console.error('彻底删除失败:', e);
      }
    });
  }, [showToast]);

  const batchSoftDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    try {
      await fetch('/api/video2/shots/batch-update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'softDelete' })
      });
      setShots(prev => prev.filter(it => !ids.includes(it.id)));
      setSelectedIds(new Set());
      showToast(`已将 ${ids.length} 项移到垃圾桶`);
    } catch (e) {
      console.error('批量删除失败:', e);
    }
  }, [selectedIds, showToast]);

  const batchRestore = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    try {
      await fetch('/api/video2/shots/batch-update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'restore' })
      });
      setShots(prev => prev.filter(it => !ids.includes(it.id)));
      setSelectedIds(new Set());
      showToast(`已恢复 ${ids.length} 项`);
    } catch (e) {
      console.error('批量恢复失败:', e);
    }
  }, [selectedIds, showToast]);

  const batchHardDelete = useCallback((onConfirm: (fn: () => Promise<void>) => void) => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    const ids = Array.from(selectedIds);
    onConfirm(async () => {
      try {
        await fetch('/api/video2/shots/batch-update', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, action: 'hardDelete' })
        });
        setShots(prev => prev.filter(it => !ids.includes(it.id)));
        setSelectedIds(new Set());
        showToast(`已彻底删除 ${ids.length} 项`);
      } catch (e) {
        console.error('批量彻底删除失败:', e);
      }
    });
  }, [selectedIds, showToast]);

  const batchMoveToScene = useCallback(async (sceneId: number | null) => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    try {
      await fetch('/api/video2/shots/batch-update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'changeScene', sceneId })
      });
      setShots(prev => prev.filter(it => !ids.includes(it.id)));
      setSelectedIds(new Set());
      showToast(`已移动 ${ids.length} 项`);
    } catch (e) {
      console.error('批量移动失败:', e);
    }
  }, [selectedIds, showToast]);

  const batchMergeShots = useCallback(async (onReload: () => Promise<void>) => {
    if (selectedIds.size < 2) {
      showToast('请选择至少2个分镜进行合并', 'info');
      return;
    }
    const ids = Array.from(selectedIds);
    try {
      const res = await fetch('/api/video2/shots/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotIds: ids })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`已合并 ${ids.length} 个分镜为 1 个`);
        setSelectedIds(new Set());
        await onReload();
      }
    } catch (e) {
      console.error('合并分镜失败:', e);
    }
  }, [selectedIds, showToast]);

  const handleItemDragStart = useCallback((id: number, e: DragEvent) => {
    if (!dragHandlePressedRef.current) {
      e.preventDefault();
      return;
    }
    dragHandlePressedRef.current = false;
    setDragItemId(id);
  }, []);

  const handleDragHandleMouseDown = useCallback(() => {
    dragHandlePressedRef.current = true;
  }, []);

  const handleItemDragOver = useCallback((e: DragEvent, id: number) => {
    e.preventDefault();
    if (dragItemId === null || dragItemId === id) return;
    setDragOverItemId(id);
  }, [dragItemId]);

  const reorderShots = useCallback(async (dragId: number, targetId: number) => {
    const sorted = [...shots].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const dragIdx = sorted.findIndex(i => i.id === dragId);
    const targetIdx = sorted.findIndex(i => i.id === targetId);
    if (dragIdx < 0 || targetIdx < 0) return;

    const next = [...sorted];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(targetIdx, 0, moved);

    const orders = next.map((i, idx) => ({ id: i.id, sortOrder: idx }));
    setShots(next.map((i, idx) => ({ ...i, sortOrder: idx })));

    try {
      await fetch('/api/video2/shots/batch-update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', orders })
      });
    } catch (e) {
      console.error('更新排序失败:', e);
    }
  }, [shots]);

  const handleItemDrop = useCallback(async (targetId: number, isMobile: boolean, scrollIntoView: (id: number) => void) => {
    if (dragItemId === null || dragItemId === targetId) {
      setDragItemId(null);
      setDragOverItemId(null);
      return;
    }
    await reorderShots(dragItemId, targetId);
    setDragItemId(null);
    setDragOverItemId(null);
    window.requestAnimationFrame(() => scrollIntoView(targetId));
  }, [dragItemId, reorderShots]);

  const moveItem = useCallback(async (itemId: number, dir: -1 | 1, scrollIntoView: (id: number) => void) => {
    const sorted = [...shots].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const idx = sorted.findIndex(i => i.id === itemId);
    if (idx < 0) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= sorted.length) return;

    const next = [...sorted];
    [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
    const orders = next.map((i, iidx) => ({ id: i.id, sortOrder: iidx }));
    setShots(next.map((i, iidx) => ({ ...i, sortOrder: iidx })));

    try {
      await fetch('/api/video2/shots/batch-update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', orders })
      });
    } catch (e) {
      console.error('更新排序失败:', e);
    }
    window.requestAnimationFrame(() => scrollIntoView(itemId));
  }, [shots]);

  const cloneShot = useCallback(async (id: number, onReload: () => Promise<void>) => {
    try {
      const res = await fetch(`/api/video2/shots/${id}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.success) {
        showToast('已克隆分镜');
        await onReload();
      }
    } catch (e) {
      console.error('克隆分镜失败:', e);
    }
  }, [showToast]);

  return {
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
    loadShots,
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
    handleItemDrop,
    moveItem,
    cloneShot,
  };
}
