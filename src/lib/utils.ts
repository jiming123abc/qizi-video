export function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  let date: Date;
  if (dateStr.includes('T') || dateStr.endsWith('Z')) {
    date = new Date(dateStr);
  } else {
    date = new Date(dateStr + 'Z');
  }
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * any-audit：统一的错误消息提取工具
 * 用于 catch (err: unknown) 块中安全提取错误消息，替代 catch (err: any) + err.message 模式
 *
 * 用法：
 *   try { ... } catch (err: unknown) {
 *     showToast(getErrorMessage(err), 'error');
 *   }
 */
export function getErrorMessage(err: unknown, fallback: string = '未知错误'): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return fallback;
}
