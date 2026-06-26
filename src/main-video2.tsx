import React from 'react';
import ReactDOM from 'react-dom/client';
import Video2App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

console.log('[App] 开始挂载应用...');
console.log('[App] root 元素:', document.getElementById('root'));

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <Video2App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  console.log('[App] 应用挂载成功');
} catch (err) {
  console.error('[App] 应用挂载失败:', err);
}
