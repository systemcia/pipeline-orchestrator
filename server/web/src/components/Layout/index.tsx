import { useState } from 'react';
import { Layout, Menu } from 'antd';
import {
  DashboardOutlined,
  SettingOutlined,
  BarChartOutlined,
  BookOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';

const { Sider, Content } = Layout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '编排会话' },
  { key: '/analytics', icon: <BarChartOutlined />, label: '效能分析' },
  { key: '/knowledge', icon: <BookOutlined />, label: '知识库' },
  { key: '/search', icon: <SearchOutlined />, label: '会话检索' },
  { key: '/settings', icon: <SettingOutlined />, label: '配置' },
];

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const getSelectedKey = () => {
    const path = location.pathname;
    if (path === '/settings') return '/settings';
    if (path === '/analytics') return '/analytics';
    if (path === '/knowledge') return '/knowledge';
    if (path === '/search') return '/search';
    return '/';
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed}>
        <div
          style={{
            height: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 700,
            fontSize: collapsed ? 14 : 15,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            letterSpacing: collapsed ? 0 : 0.5,
          }}
          onClick={() => navigate('/')}
        >
          {collapsed ? '⚡' : '⚡ Pipeline Orchestrator'}
        </div>
        <Menu
          theme="dark"
          selectedKeys={[getSelectedKey()]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Content style={{ margin: 16, minHeight: 'calc(100vh - 32px)' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
