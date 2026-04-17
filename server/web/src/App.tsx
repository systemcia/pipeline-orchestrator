import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppLayout from '@/components/Layout';
import SessionList from '@/pages/SessionList';
import SessionDetail from '@/pages/SessionDetail';
import LogViewer from '@/pages/LogViewer';
import Pending from '@/pages/Pending';
import Settings from '@/pages/Settings';
import Analytics from '@/pages/Analytics';
import Knowledge from '@/pages/Knowledge';
import SessionSearch from '@/pages/SessionSearch';

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<SessionList />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/search" element={<SessionSearch />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/sessions/:id/logs" element={<LogViewer />} />
            <Route path="/sessions/:id/pending" element={<Pending />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}
