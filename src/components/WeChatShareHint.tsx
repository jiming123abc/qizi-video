import { motion, AnimatePresence } from 'motion/react';
import { CornerRightUp, CheckCircle2, Info, Share2 } from 'lucide-react';
import { useEffect } from 'react';

interface ShareHintProps {
  isVisible: boolean;
  onClose: () => void;
  mode: 'wechat' | 'default';
}

export function ShareHint({ isVisible, onClose, mode }: ShareHintProps) {
  // Auto-close default toast after 3 seconds
  useEffect(() => {
    if (isVisible && mode === 'default') {
      const timer = setTimeout(onClose, 3000);
      return () => clearTimeout(timer);
    }
  }, [isVisible, mode, onClose]);

  return (
    <AnimatePresence>
      {isVisible && (
        <div className="fixed inset-0 z-[100] pointer-events-none">
          {mode === 'wechat' ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={onClose}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto"
            >
              <div className="absolute top-4 right-4 flex flex-col items-end gap-2 text-white">
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  <CornerRightUp className="w-12 h-12 text-primary animate-bounce mb-2" />
                </motion.div>
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  onClick={(e) => e.stopPropagation()}
                  className="bg-surface-container-high/90 backdrop-blur-md p-6 rounded-2xl border border-white/20 shadow-2xl max-w-[300px] text-center"
                >
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <Share2 className="w-6 h-6 text-secondary" />
                    <p className="font-headline text-lg font-bold">分享给朋友</p>
                  </div>
                  <p className="font-body text-sm opacity-90 leading-relaxed mb-3">
                    该作品的网址已复制到剪贴板
                  </p>
                  <div className="bg-white/10 rounded-xl p-3 mb-3">
                    <p className="text-xs opacity-80 mb-1">💡 分享技巧</p>
                    <p className="font-body text-sm">
                      点击右上角的 <span className="text-secondary font-bold">...</span> 按钮，选择「发送给朋友」或「分享到朋友圈」
                    </p>
                  </div>
                  <div className="flex items-start gap-2 bg-primary/20 rounded-xl p-3 text-left">
                    <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <p className="text-xs opacity-80">
                      微信分享卡片的效果依赖于微信抓取，建议实际发送给好友测试
                    </p>
                  </div>
                </motion.div>
              </div>
              
              <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1 }}
                onClick={onClose}
                className="absolute bottom-12 left-1/2 -translate-x-1/2 px-8 py-3 rounded-full glass-panel border border-white/20 text-sm font-label tracking-widest uppercase hover:bg-white/10 transition-colors pointer-events-auto"
              >
                我知道了
              </motion.button>
            </motion.div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <motion.div
                initial={{ y: 20, opacity: 0, scale: 0.9 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                exit={{ y: -20, opacity: 0, scale: 0.9 }}
                className="bg-surface-container-high/90 backdrop-blur-xl px-6 py-4 rounded-2xl border border-white/20 shadow-2xl flex items-center gap-3 text-white pointer-events-auto"
              >
                <CheckCircle2 className="w-5 h-5 text-secondary" />
                <span className="font-headline font-medium">该作品的网址已复制</span>
              </motion.div>
            </div>
          )}
        </div>
      )}
    </AnimatePresence>
  );
}
