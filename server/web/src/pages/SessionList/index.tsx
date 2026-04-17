import { useEffect, useRef, useState } from 'react';
import { Table, Card, Input, Select, Button, Space, Popconfirm, message, Progress, Tag, Tooltip } from 'antd';
import { ReloadOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { getSessions, deleteSession } from '@/services/api';
import { usePipelineEvents } from '@/services/websocket';
import { SessionStatusTag } from '@/components/StatusTag';
import type { SessionSummary, SessionStatus } from '@/types/session';

const statusOptions: { label: string; value: SessionStatus | '' }[] = [
  { label: '全部', value: '' },
  { label: 'PLANNING', value: 'PLANNING' },
  { label: 'PROPOSING', value: 'PROPOSING' },
  { label: 'APPLYING', value: 'APPLYING' },
  { label: 'VERIFYING', value: 'VERIFYING' },
  { label: 'ARCHIVING', value: 'ARCHIVING' },
  { label: 'COMPLETED', value: 'COMPLETED' },
  { label: 'PAUSED', value: 'PAUSED' },
  { label: 'FAILED', value: 'FAILED' },
  { label: 'ARCHIVED', value: 'ARCHIVED' },
];

const scaleLabels: Record<string, { text: string; color: string }> = {
  small: { text: '小', color: 'green' },
  medium: { text: '中', color: 'blue' },
  large: { text: '大', color: 'purple' },
};

const WS_LIST_REFRESH = new Set(['task_start', 'task_done', 'task_fail', 'session_update']);

export default function SessionList() {
  const [data, setData] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SessionStatus | ''>('');
  const navigate = useNavigate();

  const fetchData = async () => {
    setLoading(true);
    try {
      const sessions = await getSessions();
      setData(sessions || []);
    } catch {
      message.error('加载会话列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchRef = useRef(fetchData);
  fetchRef.current = fetchData;
  usePipelineEvents((e) => {
    if (!WS_LIST_REFRESH.has(e.eventType)) return;
    void fetchRef.current();
  });

  useEffect(() => { fetchData(); }, []);

  const filtered = data.filter((s) => {
    if (statusFilter && s.status !== statusFilter) return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.id.includes(search)) {
      return false;
    }
    return true;
  });

  const handleDelete = async (id: string) => {
    try {
      await deleteSession(id);
      message.success('已删除');
      fetchData();
    } catch {
      message.error('删除失败');
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: SessionSummary) => (
        <a onClick={() => navigate(`/sessions/${record.id}`)}>{name || record.id}</a>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: SessionStatus) => <SessionStatusTag status={status} />,
    },
    {
      title: '规模',
      dataIndex: 'scale',
      key: 'scale',
      width: 60,
      render: (scale: string) => {
        const cfg = scaleLabels[scale];
        return cfg ? <Tag color={cfg.color}>{cfg.text}</Tag> : <span style={{ color: '#ccc' }}>-</span>;
      },
    },
    {
      title: '进度',
      key: 'progress',
      width: 200,
      render: (_: unknown, record: SessionSummary) => {
        const { taskCount, completedCount = 0, failedCount = 0, runningCount = 0 } = record;
        const pct = Math.round(record.progress);
        const hasFailure = failedCount > 0;
        return (
          <Space size={4}>
            <Progress
              percent={pct}
              size="small"
              style={{ width: 100 }}
              status={hasFailure ? 'exception' : undefined}
            />
            <Tooltip title={`完成:${completedCount} 失败:${failedCount} 执行中:${runningCount} 待执行:${taskCount - completedCount - failedCount - runningCount}`}>
              <span style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>
                {completedCount}/{taskCount}
                {failedCount > 0 && <span style={{ color: '#ff4d4f' }}> ✗{failedCount}</span>}
                {runningCount > 0 && <span style={{ color: '#1677ff' }}> ▶{runningCount}</span>}
              </span>
            </Tooltip>
          </Space>
        );
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      sorter: (a: SessionSummary, b: SessionSummary) =>
        dayjs(a.createdAt ?? 0).valueOf() - dayjs(b.createdAt ?? 0).valueOf(),
      render: (t: string | null) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 170,
      defaultSortOrder: 'descend' as const,
      sorter: (a: SessionSummary, b: SessionSummary) =>
        dayjs(a.updatedAt ?? 0).valueOf() - dayjs(b.updatedAt ?? 0).valueOf(),
      render: (t: string | null) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: unknown, record: SessionSummary) => (
        <Space>
          <Button type="link" size="small" icon={<EyeOutlined />}
            onClick={() => navigate(`/sessions/${record.id}`)}>
            详情
          </Button>
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="编排会话列表"
      extra={
        <Space>
          <Input.Search placeholder="搜索名称/ID" allowClear style={{ width: 220 }}
            onSearch={setSearch} onChange={(e) => !e.target.value && setSearch('')} />
          <Select style={{ width: 140 }} value={statusFilter} onChange={setStatusFilter}
            options={statusOptions} />
          <Button icon={<ReloadOutlined />} onClick={fetchData}>刷新</Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={filtered}
        columns={columns}
        pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      />
    </Card>
  );
}
