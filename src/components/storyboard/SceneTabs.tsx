import React from 'react';
import { Plus, GripVertical, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Scene } from '../../lib/types';

interface SceneTabsProps {
  scenes: Scene[];
  sortedScenes: Scene[];
  currentSceneId: number | null;
  onSelectScene: (sceneId: number | null) => void;
  onOpenSceneManager: () => void;
  onRenameScene: (scene: Scene) => void;
  dragSceneId: number | null;
  setDragSceneId: (id: number | null) => void;
  dragOverSceneId: number | null;
  setDragOverSceneId: (id: number | null) => void;
  handleSceneDragStart: (id: number) => void;
  handleSceneDragOver: (e: React.DragEvent, id: number) => void;
  handleSceneDrop: (targetId: number) => void;
  canScrollLeft: boolean;
  canScrollRight: boolean;
  sceneTabRef: React.RefObject<HTMLDivElement>;
  updateSceneScrollState: () => void;
  scrollSceneTabs: (direction: 'left' | 'right') => void;
  sceneStatsMap: Record<string, { done: number; total: number }>;
  unclassifiedCount: number;
  isMobile: boolean;
  onSelectUnclassified: () => void;
  dragShotId: number | null;
  dragOverSceneForShot: number | null | undefined;
  onShotDragOverScene: (e: React.DragEvent, sceneId: number | null) => void;
  onShotDropOnScene: (sceneId: number | null) => void;
  onShotDragLeaveScene: () => void;
}

export function SceneTabs({
  sortedScenes,
  currentSceneId,
  onSelectScene,
  onOpenSceneManager,
  onRenameScene,
  dragSceneId,
  setDragSceneId,
  dragOverSceneId,
  setDragOverSceneId,
  handleSceneDragStart,
  handleSceneDragOver,
  handleSceneDrop,
  canScrollLeft,
  canScrollRight,
  sceneTabRef,
  updateSceneScrollState,
  scrollSceneTabs,
  sceneStatsMap,
  unclassifiedCount,
  isMobile,
  onSelectUnclassified,
  scenes,
  dragShotId,
  dragOverSceneForShot,
  onShotDragOverScene,
  onShotDropOnScene,
  onShotDragLeaveScene,
}: SceneTabsProps) {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-1">
      <div className="relative">
        {canScrollLeft && (
          <>
            <div className="absolute left-0 top-0 bottom-0 w-10 bg-gradient-to-r from-slate-900 via-slate-900/80 to-transparent z-10 pointer-events-none" />
            <button
              onClick={() => scrollSceneTabs('left')}
              className="touch-target-36-lg absolute left-2 top-1/2 -translate-y-1/2 z-20 w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition"
              title="向左滚动"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </>
        )}
        {canScrollRight && (
          <>
            <div className="absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-slate-900 via-slate-900/80 to-transparent z-10 pointer-events-none" />
            <button
              onClick={() => scrollSceneTabs('right')}
              className="touch-target-36-lg absolute right-2 top-1/2 -translate-y-1/2 z-20 w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur border border-white/15 text-slate-300 hover:text-white flex items-center justify-center transition"
              title="向右滚动"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </>
        )}
        <div
          ref={sceneTabRef}
          onScroll={updateSceneScrollState}
          className="overflow-x-auto overflow-y-hidden scrollbar-hide"
        >
          <div className="flex items-center gap-2 min-w-max px-1 h-8">
          {sortedScenes.map((scene) => {
            const isActive = currentSceneId === scene.id;
            const isDragOverScene = dragOverSceneId === scene.id && dragSceneId !== scene.id;
            const isDraggingScene = dragSceneId === scene.id;
            const isShotDragOver = dragOverSceneForShot === scene.id;
            return (
              <button
                key={scene.id}
                onClick={() => onSelectScene(scene.id)}
                draggable={!isMobile}
                onDragOver={(e) => {
                  if (dragShotId !== null) {
                    onShotDragOverScene(e, scene.id);
                  } else {
                    handleSceneDragOver(e, scene.id);
                  }
                }}
                onDragLeave={() => {
                  if (dragShotId !== null) {
                    onShotDragLeaveScene();
                  } else {
                    setDragOverSceneId(null);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragShotId !== null) {
                    onShotDropOnScene(scene.id);
                  } else {
                    handleSceneDrop(scene.id);
                  }
                }}
                onDragStart={(e) => { if (!isMobile) { handleSceneDragStart(scene.id); try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {} } }}
                onDragEnd={() => { setDragSceneId(null); setDragOverSceneId(null); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onRenameScene(scene);
                }}
                className={`inline-flex items-center justify-center gap-1.5 h-8 shrink-0 rounded-full text-xs sm:text-sm font-medium whitespace-nowrap border transition-all duration-200 leading-tight ${
                  isDraggingScene ? 'opacity-50 scale-95' : ''
                } ${
                  isActive
                    ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 border-transparent text-white shadow-lg shadow-violet-500/25 pl-2 pr-3 sm:pr-4'
                    : 'border-white/15 bg-white/5 text-slate-300 hover:bg-white/10 px-3 sm:px-4 text-center'
                } ${(isDragOverScene || (isShotDragOver && dragShotId !== null)) ? 'ring-2 ring-violet-400/70 scale-105' : ''}`}
                title={isActive ? '点击切换 · 右键重命名' : '点击切换场次 · 右键重命名'}
              >
                {isActive && !isMobile && (
                  <GripVertical className="w-3.5 h-3.5 text-white/90 shrink-0 cursor-grab active:cursor-grabbing" />
                )}
                <span className={`${isActive ? '' : 'text-center'} flex-1 min-w-0`}>{scene.name}</span>
                {(() => {
                  const s = sceneStatsMap[String(scene.id)];
                  if (s && s.total > 0) {
                    return (
                      <span className={`text-[10px] px-1.5 py-0 rounded-full leading-4 ${
                        isActive ? 'bg-white/20 text-white/90' : 'bg-white/10 text-slate-400'
                      }`}>
                        {s.done}/{s.total}
                      </span>
                    );
                  }
                  return null;
                })()}
              </button>
            );
          })}

          {unclassifiedCount > 0 && (
            <button
              onClick={onSelectUnclassified}
              onDragOver={(e) => {
                if (dragShotId !== null) {
                  onShotDragOverScene(e, null);
                }
              }}
              onDragLeave={() => {
                if (dragShotId !== null) {
                  onShotDragLeaveScene();
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragShotId !== null) {
                  onShotDropOnScene(null);
                }
              }}
              className={`inline-flex items-center justify-center gap-1.5 h-8 shrink-0 rounded-full text-xs sm:text-sm font-medium whitespace-nowrap border transition-all duration-200 leading-tight ${
                currentSceneId === null
                  ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 border-transparent text-white shadow-lg shadow-violet-500/25 pl-2 pr-3 sm:pr-4'
                  : 'border-white/15 bg-white/5 text-slate-300 hover:bg-white/10 px-3 sm:px-4 text-center'
              } ${dragOverSceneForShot === null && dragShotId !== null ? 'ring-2 ring-violet-400/70 scale-105' : ''}`}
              title="未分类"
            >
              {currentSceneId === null && !isMobile && (
                <span className="w-3.5 h-3.5 shrink-0" />
              )}
              <span className={`${currentSceneId === null ? '' : 'text-center'} flex-1 min-w-0`}>未分类</span>
              {(() => {
                  const s = sceneStatsMap['null'];
                  if (s && s.total > 0) {
                    return (
                      <span className={`text-[10px] px-1.5 py-0 rounded-full leading-4 ${
                        currentSceneId === null ? 'bg-white/20 text-white/90' : 'bg-white/10 text-slate-400'
                      }`}>
                        {s.done}/{s.total}
                      </span>
                    );
                  }
                  return null;
                })()}
            </button>
          )}

          {scenes.length === 0 && unclassifiedCount === 0 && (
            <span className="px-2 text-xs text-slate-500">
              无场次
            </span>
          )}

          <button
            onClick={onOpenSceneManager}
            className="touch-target-36 flex items-center gap-1.5 px-2 sm:px-3 h-8 rounded-full border border-dashed border-white/25 hover:border-violet-400/50 hover:bg-violet-500/10 text-slate-400 hover:text-violet-200 transition shrink-0"
            title="场次管理"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span className="text-xs font-medium hidden sm:inline">管理场次</span>
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
