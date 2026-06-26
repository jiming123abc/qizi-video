import React, { useState, useEffect } from 'react';
import { Video2ProjectList } from './components/Video2ProjectList';
import { Video2Page } from './components/Video2Page';

type Video2Route = { page: 'list' } | { page: 'project'; projectId: number };

export default function Video2App() {
  const [route, setRoute] = useState<Video2Route>({ page: 'list' });

  useEffect(() => {
    const parseRoute = () => {
      const path = window.location.pathname;
      const projectMatch = path.match(/^\/project\/(\d+)$/);
      if (projectMatch) {
        setRoute({ page: 'project', projectId: parseInt(projectMatch[1]) });
        return;
      }
      setRoute({ page: 'list' });
    };

    parseRoute();

    const handlePopState = () => {
      parseRoute();
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateToProject = (projectId: number) => {
    const newUrl = `/project/${projectId}`;
    window.history.pushState({}, '', newUrl);
    setRoute({ page: 'project', projectId });
  };

  const navigateToList = () => {
    window.history.pushState({}, '', '/');
    setRoute({ page: 'list' });
  };

  if (route.page === 'project') {
    return <Video2Page projectId={route.projectId} onBack={navigateToList} />;
  }

  return <Video2ProjectList onSelectProject={navigateToProject} />;
}
