import React, { useState, useEffect, useRef } from 'react';
import { X, Upload, Sparkles } from 'lucide-react';
import type { Shot } from '../../lib/types';

interface AddShotDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: number;
  sceneId?: number | null;
  onAdd?: (shot: Shot) => void;
  onUploadMedia?: () => void;
  onAiGenerate?: () => void;
}

const SHOT_TYPES = ['远景', '全景', '中景', '近景', '特写', '大特写'];
const SHOT_ANGLES = ['平拍', '俯拍', '仰拍', '主观视角', '客观视角'];
const CAMERA_MOVEMENTS = ['固定', '推', '拉', '摇', '移', '跟', '升降', '手持', '甩'];

export default function AddShotDialog({
  isOpen,
  onClose,
  projectId,
  sceneId,
  onAdd,
  onUploadMedia,
  onAiGenerate
}: AddShotDialogProps) {
  const [formData, setFormData] = useState({
    sceneContent: '',
    actors: '',
    props: '',
    location: '',
    focalLength: '',
    shotType: '',
    shotAngle: '',
    cameraMovement: '',
    lighting: '',
    narration: '',
    estimatedDuration: '',
    notes: ''
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setFormData({
        sceneContent: '',
        actors: '',
        props: '',
        location: '',
        focalLength: '',
        shotType: '',
        shotAngle: '',
        cameraMovement: '',
        lighting: '',
        narration: '',
        estimatedDuration: '',
        notes: ''
      });
      setError(null);
      setIsSubmitting(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const payload: Record<string, any> = {
        ...formData,
        projectId,
        sceneId: sceneId ?? undefined
      };

      Object.keys(payload).forEach(key => {
        if (payload[key] === '' || payload[key] === undefined) {
          delete payload[key];
        }
      });

      const res = await fetch('/api/video2/shots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || '创建分镜失败');
      }

      if (onAdd && data.data) {
        onAdd(data.data);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建分镜失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'TEXTAREA' && target.tagName !== 'BUTTON') {
        e.preventDefault();
        handleSubmit(e as unknown as React.FormEvent);
      }
    }
  };

  const handleMediaButtonClick = () => {
    if (onUploadMedia) {
      onUploadMedia();
    } else {
      fileInputRef.current?.click();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[85vh] rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold">新增分镜</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* 错误提示 */}
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* 画面内容 */}
          <div>
            <label className="block text-sm font-medium text-slate-200 mb-2">
              画面内容
            </label>
            <textarea
              ref={inputRef as any}
              name="sceneContent"
              value={formData.sceneContent}
              onChange={handleChange}
              placeholder="描述画面内容"
              rows={3}
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 focus:bg-white/10 transition resize-none"
            />
          </div>

          {/* 其他字段（可选） */}
          <div className="text-sm text-slate-400 -mb-3">其他字段（可选）：</div>

          <div className="grid grid-cols-2 gap-4">
            {/* 演员 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">演员</label>
              <input
                type="text"
                name="actors"
                value={formData.actors}
                onChange={handleChange}
                placeholder="演员"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 transition"
              />
            </div>

            {/* 道具 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">道具</label>
              <input
                type="text"
                name="props"
                value={formData.props}
                onChange={handleChange}
                placeholder="道具"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 transition"
              />
            </div>

            {/* 地点 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">地点</label>
              <input
                type="text"
                name="location"
                value={formData.location}
                onChange={handleChange}
                placeholder="地点"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 transition"
              />
            </div>

            {/* 焦段 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">焦段</label>
              <input
                type="text"
                name="focalLength"
                value={formData.focalLength}
                onChange={handleChange}
                placeholder="如 35mm"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 transition"
              />
            </div>

            {/* 景别 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">景别</label>
              <select
                name="shotType"
                value={formData.shotType}
                onChange={handleChange}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm appearance-none cursor-pointer hover:bg-white/10 transition focus:outline-none focus:border-violet-500/50"
              >
                <option value="" className="bg-slate-800">远景</option>
                {SHOT_TYPES.map(type => (
                  <option key={type} value={type} className="bg-slate-800">{type}</option>
                ))}
              </select>
            </div>

            {/* 角度 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">角度</label>
              <select
                name="shotAngle"
                value={formData.shotAngle}
                onChange={handleChange}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm appearance-none cursor-pointer hover:bg-white/10 transition focus:outline-none focus:border-violet-500/50"
              >
                <option value="" className="bg-slate-800">平拍</option>
                {SHOT_ANGLES.map(angle => (
                  <option key={angle} value={angle} className="bg-slate-800">{angle}</option>
                ))}
              </select>
            </div>

            {/* 镜头运动 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">镜头运动</label>
              <select
                name="cameraMovement"
                value={formData.cameraMovement}
                onChange={handleChange}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm appearance-none cursor-pointer hover:bg-white/10 transition focus:outline-none focus:border-violet-500/50"
              >
                <option value="" className="bg-slate-800">固定</option>
                {CAMERA_MOVEMENTS.map(move => (
                  <option key={move} value={move} className="bg-slate-800">{move}</option>
                ))}
              </select>
            </div>

            {/* 灯光 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">灯光</label>
              <input
                type="text"
                name="lighting"
                value={formData.lighting}
                onChange={handleChange}
                placeholder="灯光"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 transition"
              />
            </div>

            {/* 旁白 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">旁白</label>
              <input
                type="text"
                name="narration"
                value={formData.narration}
                onChange={handleChange}
                placeholder="旁白"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 transition"
              />
            </div>

            {/* 预估时长 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">预估时长</label>
              <input
                type="number"
                name="estimatedDuration"
                value={formData.estimatedDuration}
                onChange={handleChange}
                placeholder="秒"
                min="0"
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 transition"
              />
            </div>
          </div>

          {/* 备注 */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">备注</label>
            <input
              type="text"
              name="notes"
              value={formData.notes}
              onChange={handleChange}
              placeholder="备注"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm placeholder-slate-500 focus:outline-none focus:border-violet-500/50 transition"
            />
          </div>

          {/* 分隔线 */}
          <div className="border-t border-dashed border-white/10" />

          {/* 上传或AI生成参考画面 */}
          <div className="rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] p-5 text-center">
            <button
              type="button"
              onClick={handleMediaButtonClick}
              className="flex flex-col items-center gap-2 w-full"
            >
              <div className="w-12 h-12 rounded-full bg-violet-500/10 flex items-center justify-center">
                <Upload className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-200">上传或AI生成参考画面</p>
                <p className="text-xs text-slate-500 mt-0.5">可选，不上传则创建空白分镜</p>
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={() => {}}
            />
          </div>

          {/* AI生成按钮（如果提供回调） */}
          {onAiGenerate && (
            <button
              type="button"
              onClick={onAiGenerate}
              className="w-full py-3 rounded-2xl border border-dashed border-yellow-400/30 bg-yellow-500/10 hover:bg-yellow-500/20 transition flex items-center justify-center gap-2 text-yellow-200"
            >
              <Sparkles className="w-5 h-5" />
              <span className="font-medium">AI 生成参考画面</span>
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/10 text-sm transition"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? '创建中...' : '创建分镜'}
          </button>
        </div>
      </div>
    </div>
  );
}
