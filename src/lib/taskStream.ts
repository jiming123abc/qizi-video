export interface AiTaskUpdate {
  id: string;
  type: string;
  status: string;
  progress: number;
  error?: string;
  output?: any;
  createdAt: string;
  updatedAt: string;
}

export function subscribeToTask(
  taskId: string,
  onUpdate: (task: AiTaskUpdate) => void,
  onError?: (error: string) => void
): () => void {
  const eventSource = new EventSource(`/api/video2/ai/task/${taskId}/stream`);

  eventSource.addEventListener('update', (event) => {
    try {
      const data = JSON.parse(event.data);
      onUpdate(data);
      if (data.status === 'completed' || data.status === 'failed' || data.status === 'error') {
        eventSource.close();
      }
    } catch (e) {
      console.error('解析 SSE 消息失败:', e);
    }
  });

  eventSource.addEventListener('error', (event) => {
    try {
      const data = JSON.parse((event as any).data);
      onError?.(data.message || '连接错误');
    } catch {
      onError?.('连接错误');
    }
    eventSource.close();
  });

  eventSource.onerror = () => {
    console.warn('SSE 连接断开，将使用轮询作为后备');
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
}
