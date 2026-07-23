import { useContext } from 'react';
import { UploadContext } from '../components/common/UploadProvider';
import type { UploadOptions, UploadItemResult } from '../components/common/UploadProvider';

/**
 * 统一上传 hook
 *
 * 使用方式：
 * ```tsx
 * const { startUpload } = useUnifiedUpload();
 *
 * const handleUpload = async () => {
 *   const results = await startUpload({
 *     projectId: 1,
 *     usage: 'shot-reference',
 *     accept: 'video/*',
 *     multiple: true,
 *     maxFiles: 10,
 *   });
 *   if (results.length > 0) {
 *     // 处理上传结果
 *   }
 * };
 * ```
 */
export function useUnifiedUpload() {
  const context = useContext(UploadContext);
  return {
    startUpload: context.startUpload,
  };
}

export type { UploadOptions, UploadItemResult };
