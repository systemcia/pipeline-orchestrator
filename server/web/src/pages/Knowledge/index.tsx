import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Input, Table, Tag, Spin, message, Collapse, Select, Space, Tooltip } from 'antd';
import { BookOutlined, StarOutlined, SearchOutlined, CodeOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  getKnowledgeStats, getKnowledgeChunks, searchKnowledge, getGems,
} from '@/services/api';
import type { KnowledgeStats, KnowledgeChunk, PromptGem } from '@/services/api';

const categoryColors: Record<string, string> = {
  debug: 'red', refactor: 'purple', analysis: 'blue', feature: 'green',
};

export default function Knowledge() {
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [gems, setGems] = useState<PromptGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');

  useEffect(() => {
    Promise.all([
      getKnowledgeStats(),
      getKnowledgeChunks('', 30),
      getGems('', 0, 30),
    ]).then(([s, c, g]) => {
      setStats(s);
      setChunks(c || []);
      setGems(g || []);
    }).catch(() => message.error('加载知识库失败')).finally(() => setLoading(false));
  }, []);

  const handleSearch = async (q: string) => {
    if (!q.trim()) {
      const c = await getKnowledgeChunks(projectFilter, 30);
      setChunks(c || []);
      return;
    }
    setLoading(true);
    try {
      const c = await searchKnowledge(q, 30);
      setChunks(c || []);
    } catch { message.error('搜索失败'); }
    finally { setLoading(false); }
  };

  const handleProjectChange = async (proj: string) => {
    setProjectFilter(proj);
    setLoading(true);
    try {
      const c = await getKnowledgeChunks(proj, 30);
      setChunks(c || []);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  if (loading && !stats) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;

  const chunkColumns = [
    {
      title: '项目', dataIndex: 'project_name', key: 'project', width: 120,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '用户问题', dataIndex: 'user_query', key: 'query',
      ellipsis: true,
      render: (v: string) => <Tooltip title={v}><span>{v}</span></Tooltip>,
    },
    {
      title: '标签', key: 'meta', width: 150,
      render: (_: unknown, r: KnowledgeChunk) => (
        <Space size={2} wrap>
          {r.has_code && <Tag color="geekblue"><CodeOutlined /> 代码</Tag>}
          {r.code_languages && <Tag>{r.code_languages}</Tag>}
        </Space>
      ),
    },
    {
      title: '时间', dataIndex: 'timestamp', key: 'time', width: 100,
      render: (v: number) => v ? dayjs(v).format('MM-DD HH:mm') : '-',
    },
  ];

  const gemColumns = [
    {
      title: '类别', dataIndex: 'category', key: 'category', width: 80,
      render: (v: string) => <Tag color={categoryColors[v] || 'default'}>{v}</Tag>,
    },
    {
      title: '提示词', dataIndex: 'user_prompt', key: 'prompt',
      ellipsis: true,
      render: (v: string) => <Tooltip title={v}><span>{v}</span></Tooltip>,
    },
    {
      title: '评分', dataIndex: 'quality_score', key: 'score', width: 70,
      render: (v: number) => <Tag color={v >= 70 ? 'green' : v >= 50 ? 'orange' : 'default'}>{v.toFixed(0)}</Tag>,
    },
    {
      title: '项目', dataIndex: 'project_name', key: 'project', width: 120,
      render: (v: string) => v ? <Tag>{v}</Tag> : '-',
    },
  ];

  return (
    <div>
      <Card title="知识库" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col span={6}><Statistic title="知识片段" value={stats?.total_chunks || 0} prefix={<BookOutlined />} /></Col>
          <Col span={6}><Statistic title="精选提示词" value={stats?.total_gems || 0} prefix={<StarOutlined />} /></Col>
          <Col span={6}><Statistic title="覆盖项目" value={stats?.project_distribution?.length || 0} /></Col>
          <Col span={6}><Statistic title="提示词类别" value={stats?.category_distribution?.length || 0} /></Col>
        </Row>
      </Card>

      <Collapse
        defaultActiveKey={['chunks', 'gems']}
        items={[
          {
            key: 'chunks',
            label: `知识片段 (${chunks.length})`,
            extra: (
              <Space onClick={(e) => e.stopPropagation()}>
                <Select
                  placeholder="按项目筛选" allowClear style={{ width: 150 }} size="small"
                  value={projectFilter || undefined}
                  onChange={(v) => handleProjectChange(v || '')}
                  options={stats?.project_distribution?.map((p) => ({ label: p.project, value: p.project })) || []}
                />
                <Input.Search
                  placeholder="搜索知识..." allowClear size="small" style={{ width: 200 }}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onSearch={handleSearch}
                  prefix={<SearchOutlined />}
                />
              </Space>
            ),
            children: (
              <Table
                rowKey="id" dataSource={chunks} columns={chunkColumns}
                size="small" pagination={{ pageSize: 10 }} loading={loading}
                expandable={{
                  expandedRowRender: (r) => (
                    <div style={{ padding: '8px 16px', fontSize: 13 }}>
                      <div style={{ fontWeight: 500, marginBottom: 4 }}>问题：</div>
                      <div style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{r.user_query}</div>
                      {r.ai_response_core && (
                        <>
                          <div style={{ fontWeight: 500, marginBottom: 4 }}>AI 回复核心：</div>
                          <div style={{ whiteSpace: 'pre-wrap', color: '#555' }}>
                            {r.ai_response_core.substring(0, 500)}
                            {r.ai_response_core.length > 500 && '...'}
                          </div>
                        </>
                      )}
                    </div>
                  ),
                }}
              />
            ),
          },
          {
            key: 'gems',
            label: `精选提示词 (${gems.length})`,
            children: (
              <Table
                rowKey="id" dataSource={gems} columns={gemColumns}
                size="small" pagination={{ pageSize: 10 }}
                expandable={{
                  expandedRowRender: (r) => (
                    <div style={{ padding: '8px 16px', fontSize: 13 }}>
                      <div style={{ fontWeight: 500, marginBottom: 4 }}>完整提示词：</div>
                      <div style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{r.user_prompt}</div>
                      {r.ai_summary && (
                        <>
                          <div style={{ fontWeight: 500, marginBottom: 4 }}>AI 总结：</div>
                          <div style={{ whiteSpace: 'pre-wrap', color: '#555' }}>
                            {r.ai_summary.substring(0, 300)}
                          </div>
                        </>
                      )}
                      {r.quality_tags && (
                        <div style={{ marginTop: 4 }}>
                          {r.quality_tags.replace(/[\[\]"]/g, '').split(',').map((t) => (
                            <Tag key={t} style={{ fontSize: 11 }}>{t.trim()}</Tag>
                          ))}
                        </div>
                      )}
                    </div>
                  ),
                }}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
