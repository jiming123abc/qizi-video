import { useState, useEffect, useRef } from 'react';
import { batchGetSignedUrls, getSignedUrlFromCache } from '../lib/ossUtils';

const pendingUrls = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBatch() {
  if (batchTimer) return;
  batchTimer = setTimeout(async () => {
    batchTimer = null;
    const urls = Array.from(pendingUrls);
    pendingUrls.clear();
    if (urls.length > 0) {
      await batchGetSignedUrls(urls);
    }
  }, 100);
}

function requestSignUrl(url: string) {
  if (!url) return;
  pendingUrls.add(url);
  scheduleBatch();
}

// 组件级别：为单个 URL 获取签名 URL
// 返回签名 URL（未就绪时返回原始 URL）
export function useSignedUrl(originalUrl: string | undefined | null): string {
  const [signedUrl, setSignedUrl] = useState<string>('');
  const urlRef = useRef(originalUrl);

  useEffect(() => {
    if (!originalUrl) {
      setSignedUrl('');
      return;
    }

    // 立即返回缓存中的值（同步）
    const cached = getSignedUrlFromCache(originalUrl);
    setSignedUrl(cached);

    // 如果缓存未命中，请求签名
    if (cached === originalUrl) {
      requestSignUrl(originalUrl);
    }
  }, [originalUrl]);

  // 当缓存更新时同步更新 state
  useEffect(() => {
    if (!originalUrl) return;
    const interval = setInterval(() => {
      const cached = getSignedUrlFromCache(originalUrl);
      if (cached !== signedUrl && cached !== originalUrl) {
        setSignedUrl(cached);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [originalUrl, signedUrl]);

  return signedUrl || originalUrl || '';
}
