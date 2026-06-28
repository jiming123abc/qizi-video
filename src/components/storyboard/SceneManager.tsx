import React from 'react';
import { X, Plus, ChevronUp, ChevronDown, ArrowLeft, Trash2 } from 'lucide-react';
import type { Scene } from '../../lib/types';

interface SceneManagerProps {
  isOpen: boolean;
  onClose: () => void;
  scenes: Scene[];
  mode: 'list' | 'create' | 'edit';
  setMode: (mode: 'list' | 'create' | 'edit') => void;
  newSceneName: string;
  setNewSceneName: (name: string) => void;
  renameSceneId: number | null;
  setRenameSceneId: (id: number | null) => void;
  renameSceneName: string;
  setRenameSceneName: (name: string) => void;
  onCreateScene: () => void;
  onRenameScene: () => void;
  onDeleteScene: (id: number) => void;
  currentSceneId: number | null;
  onSelectScene: (id: number | null) => void;
  sceneStatsMap: Record<string, { done: number; total: number }>;
  currentTab: 'pending' | 'done' | 'trash';
  moveScene: (id: number, direction: -1 | 1) => void;
  unclassifiedCount: number;
  onRequestDeleteConfirm: (sceneId: number, sceneName: string, onConfirm: () => void) => void;
}

export function SceneManager({
  isOpen,
  onClose,
  scenes,
  mode,
  setMode,
  newSceneName,
  setNewSceneName,
  renameSceneId,
  setRenameSceneId,
  renameSceneName,
  setRenameSceneName,
  onCreateScene,
  onRenameScene,
  onDeleteScene,
  currentSceneId,
  onSelectScene,
  moveScene,
  unclassifiedCount,
  onRequestDeleteConfirm,
}: SceneManagerProps) {
  if (!isOpen) return null;

  const handleClose = () => {
    setMode('list');
    onClose();
  };

  const handleBackToList = () => {
    setMode('list');
  };

  const handleGoToCreate = () => {
    setNewSceneName('');
    setMode('create');
  };

  const handleGoToEdit = (scene: Scene) => {
    setRenameSceneId(scene.id);
    setRenameSceneName(scene.name);
    setMode('edit');
  };

  const handleDeleteScene = (sceneId: number, sceneName: string) => {
    onRequestDeleteConfirm(sceneId, sceneName, () => {
      onDeleteScene(sceneId);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-4 shadow-2xl max-h-[75vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === 'list' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">场次管理</h2>
              <button
                onClick={handleClose}
                className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={handleGoToCreate}
              className="w-full mb-3 py-2.5 rounded-2xl border border-dashed border-violet-400/30 bg-violet-500/10 hover:bg-violet-500/20 text-sm font-medium text-violet-200 flex items-center justify-center gap-2 transition"
            >
              <Plus className="w-4 h-4" /> 新建场次
            </button>
            <div className="space-y-1.5">
              {scenes.length === 0 ? (
                <div className="py-10 text-center">
                  <div className="text-4xl mb-3">🎬</div>
                  <p className="text-sm text-slate-400">还没有创建场次</p>
                  <p className="text-xs text-slate-500 mt-1">点击上方按钮创建第一个场次</p>
                </div>
              ) : (
                scenes.map((scene, sceneIdx) => (
                  <div
                    key={scene.id}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-2xl border transition ${
                      currentSceneId === scene.id
                        ? 'border-violet-400/40 bg-violet-500/10'
                        : 'border-white/10 hover:bg-white/5'
                    }`}
                  >
                    <button
                      onClick={() => moveScene(scene.id, -1)}
                      disabled={sceneIdx <= 0}
                      className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 transition ${
                        sceneIdx <= 0
                          ? 'border-white/10 text-slate-600 cursor-not-allowed'
                          : 'border-white/20 text-white/60 hover:bg-violet-500/30 hover:border-violet-400/50'
                      }`}
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => moveScene(scene.id, 1)}
                      disabled={sceneIdx >= scenes.length - 1}
                      className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 transition ${
                        sceneIdx >= scenes.length - 1
                          ? 'border-white/10 text-slate-600 cursor-not-allowed'
                          : 'border-white/20 text-white/60 hover:bg-violet-500/30 hover:border-violet-400/50'
                      }`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleGoToEdit(scene)}
                      className="flex-1 text-left text-sm text-white/80 hover:text-white truncate transition"
                      title="点击重命名"
                    >
                      {currentSceneId === scene.id && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-2 align-middle" />
                      )}
                      {scene.name}
                    </button>
                    <button
                      onClick={() => handleDeleteScene(scene.id, scene.name)}
                      className="w-8 h-8 rounded-full border border-white/15 hover:border-red-400/50 hover:bg-red-500/20 flex items-center justify-center text-slate-400 hover:text-red-300 shrink-0 transition"
                      title="删除场次"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
            {unclassifiedCount > 0 && (
              <p className="text-xs text-slate-500 mt-3 text-center">
                另有 {unclassifiedCount} 个素材在「未分类」中
              </p>
            )}
          </>
        )}

        {mode === 'create' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <button
                onClick={handleBackToList}
                className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center"
              >
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
              onKeyDown={(e) => e.key === 'Enter' && onCreateScene()}
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={handleBackToList}
                className="px-3 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition"
              >
                取消
              </button>
              <button
                onClick={onCreateScene}
                disabled={!newSceneName.trim()}
                className="px-4 py-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 transition"
              >
                创建
              </button>
            </div>
          </>
        )}

        {mode === 'edit' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <button
                onClick={handleBackToList}
                className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center"
              >
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
              onKeyDown={(e) => e.key === 'Enter' && onRenameScene()}
              autoFocus
            />
            <div className="flex items-center justify-between mt-5">
              <button
                onClick={() => {
                  if (renameSceneId === null) return;
                  handleDeleteScene(renameSceneId, renameSceneName);
                }}
                className="px-3 py-2 rounded-xl text-sm text-red-300 hover:text-red-200 hover:bg-red-500/10 transition"
              >
                删除本场次
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBackToList}
                  className="px-3 py-2 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/5 transition"
                >
                  取消
                </button>
                <button
                  onClick={onRenameScene}
                  disabled={!renameSceneName.trim()}
                  className="px-4 py-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 transition"
                >
                  保存
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
