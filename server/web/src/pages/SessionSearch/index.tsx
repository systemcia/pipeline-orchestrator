import { useState } from 'react';
import { Card, Input, Table, Tag, Space, Button, Drawer, Spin, message, Empty, Descriptions, Collapse, Tooltip } from 'antd';
import { SearchOutlined, CopyOutlined, LinkOutlined, CodeOutlined, ClockCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  searchSessions, getSessionContext, getSessionTimeline, findRelatedSessions,
} from '@/services/api';
import type { SessionSearchResult, SessionContext, KnowledgeChunk } from '@/services/api';

export default function SessionSearch() {
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [context, setContext] = useState<SessionContext | null>(null);
  const [timeline, setTimeline] = useState<KnowledgeChunk[]>([]);
  const [related, setRelated] = useState<SessionSearchResult[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const handleSearch = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const r = await searchSessions(q, '', 30);
      setResults(r || []);
    } catch { message.error('搜索失败'); }
    finally { setLoading(false); }
  };

  const openDetail = async (sessionId: string) => {
    setDrawerOpen(true);
    setDetailLoading(true);
    try {
      const [ctx, tl, rel] = await Promise.all([
        getSessionContext(sessionId).catch(() => null),
        getSessionTimeline(sessionId).catch(() => []),
        findRelatedSessions(sessionId).catch(() => []),
      ]);
      setContext(ctx);
      setTimeline(tl || []);
      setRelated(rel || []);
    } catch { message.error('加载会话详情失败'); }
    finally { setDetailLoading(false); }
  };

  const copyContext = () => {
    if (!context) return;
    const text = timeline.map((c, i) =>
      `[${i + 1}] ${c.user_query}\n→ ${c.ai_response_core?.substring(0, 200) || '(无回复)'}`
    ).join('\n\n');
    const summary = `## 会话上下文: ${context.name || context.session_id}\n项目: ${context.project_name}\n\n${text}`;
    navigator.clipboard.writeText(summary);
    message.success('已复制到剪贴板，可粘贴到流水线上下文');
  };

  const columns = [
    {
      title: '会话', key: 'name', width: 250,
      render: (_: unknown, r: SessionSearchResult) => (
        <a onClick={() => openDetail(r.session_id)}>
          {r.name || r.session_id.substring(0, 12) + '...'}
        </a>
      ),
    },
    {
      title: '项目', dataIndex: 'project_name', key: 'project', width: 130,
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : '-',
    },
    {
      title: '匹配', dataIndex: 'match_field', key: 'match', width: 80,
      render: (v: string) => <Tag color={v === 'name' ? 'green' : 'orange'}>{v === 'name' ? '标题' : '内容'}</Tag>,
    },
    {
      title: '匹配内容', dataIndex: 'match_text', key: 'text',
      ellipsis: true,
      render: (v: string) => <Tooltip title={v}><span style={{ fontSize: 12 }}>{v}</span></Tooltip>,
    },
    {
      title: 'Tokens', dataIndex: 'token_count', key: 'tokens', width: 80,
      render: (v: number) => v ? (v / 1000).toFixed(0) + 'K' : '-',
    },
    {
      title: '时间', dataIndex: 'created_at', key: 'time', width: 110,
      render: (v: number) => v ? dayjs(v).format('MM-DD HH:mm') : '-',
    },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: unknown, r: SessionSearchResult) => (
        <Button type="link" size="small" icon={<LinkOutlined />} onClick={() => openDetail(r.session_id)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Card
        title="会话检索"
        extra={
          <Input.Search
            placeholder="输入关键词、代码片段、需求描述..." allowClear
            style={{ width: 400 }} size="large"
            value={query} onChange={(e) => setQuery(e.target.value)}
            onSearch={handleSearch} enterButton={<><SearchOutlined /> 搜索</>}
          />
        }
      >
        {results.length === 0 && !loading ? (
          <Empty description="输入关键词搜索历史会话" />
        ) : (
          <Table
            rowKey="session_id" dataSource={results} columns={columns}
            size="small" loading={loading}
            pagination={{ pageSize: 15, showTotal: (t) => `共 ${t} 条` }}
          />
        )}
      </Card>

      <Drawer
        title={context?.name || '会话详情'}
        open={drawerOpen} onClose={() => setDrawerOpen(false)}
        width={700}
        extra={
          <Button type="primary" icon={<CopyOutlined />} onClick={copyContext}>
            注入上下文
          </Button>
        }
      >
        {detailLoading ? <Spin style={{ display: 'block', margin: '40px auto' }} /> : (
          <div>
            {context && (
              <Descriptions size="small" column={2} style={{ marginBottom: 16 }}>
                <Descriptions.Item label="项目">{context.project_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="消息数">{context.total_messages}</Descriptions.Item>
                <Descriptions.Item label="会话ID" span={2}>
                  <code style={{ fontSize: 11 }}>{context.session_id}</code>
                </Descriptions.Item>
              </Descriptions>
            )}

            {timeline.length > 0 && (
              <Collapse
                defaultActiveKey={['timeline']}
                style={{ marginBottom: 16 }}
                items={[{
                  key: 'timeline',
                  label: `决策时间线 (${timeline.length} 步)`,
                  children: (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {timeline.map((c, i) => (
                        <Card key={c.id} size="small" style={{ borderLeft: '3px solid #1677ff' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <Tag color="blue">Step {i + 1}</Tag>
                            <Space size={4}>
                              {c.has_code && <Tag color="geekblue"><CodeOutlined /></Tag>}
                              {c.timestamp > 0 && (
                                <span style={{ fontSize: 11, color: '#999' }}>
                                  <ClockCircleOutlined /> {dayjs(c.timestamp).format('HH:mm')}
                                </span>
                              )}
                            </Space>
                          </div>
                          <div style={{ fontWeight: 500, marginBottom: 4 }}>{c.user_query}</div>
                          {c.ai_response_core && (
                            <div style={{ fontSize: 12, color: '#666', whiteSpace: 'pre-wrap' }}>
                              {c.ai_response_core.substring(0, 300)}
                              {c.ai_response_core.length > 300 && '...'}
                            </div>
                          )}
                        </Card>
                      ))}
                    </div>
                  ),
                }]}
              />
            )}

            {related.length > 0 && (
              <Card title="关联会话" size="small">
                {related.map((r) => (
                  <div key={r.session_id} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                    <a onClick={() => openDetail(r.session_id)}>
                      {r.name || r.session_id.substring(0, 12)}
                    </a>
                    <span style={{ marginLeft: 8, fontSize: 12, color: '#999' }}>
                      {r.token_count > 0 && `${(r.token_count / 1000).toFixed(0)}K tokens`}
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
