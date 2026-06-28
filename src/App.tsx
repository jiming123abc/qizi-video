import React, { useState, useEffect } from 'react';
import { ProjectListPage } from './pages/ProjectListPage';
import { StoryboardPage } from './pages/StoryboardPage';

type Route = { page: 'list' } | { page: 'project'; projectId: number };

export default function App() {
  const [route, setRoute] = useState<Route>({ page: 'list' });

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
    return <StoryboardPage projectId={route.projectId} onBack={navigateToList} />;
  }

  return <ProjectListPage onSelectProject={navigateToProject} />;
}
