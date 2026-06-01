import { useEffect, useState, useCallback } from 'react';
import {
  Card, Row, Col, Statistic, Input, Table, Tag, Spin, message, Collapse, Select, Space, Tooltip,
  Button, Modal, Form, Popconfirm, Switch,
} from 'antd';
import {
  BookOutlined, StarOutlined, StarFilled, SearchOutlined, CodeOutlined,
  PlusOutlined, EditOutlined, DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  getKnowledgeStats, getKnowledgeChunks, searchKnowledge, getGems,
  createKnowledgeChunk, updateKnowledgeChunk, deleteKnowledgeChunk, toggleKnowledgeStar,
} from '@/services/api';
import type { KnowledgeStats, KnowledgeChunk, PromptGem } from '@/services/api';

const categoryColors: Record<string, string> = {
  debug: 'red', refactor: 'purple', analysis: 'blue', feature: 'green',
};

const sourceColors: Record<string, string> = {
  chat: 'blue', review: 'green', manual: 'orange',
};

type ChunkFormValues = {
  user_query: string;
  ai_response_core?: string;
  main_topic?: string;
  tags?: string;
  project_name?: string;
};

export default function Knowledge() {
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [gems, setGems] = useState<PromptGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingChunk, setEditingChunk] = useState<KnowledgeChunk | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<ChunkFormValues>();

  const reloadChunks = useCallback(async (
    proj = projectFilter,
    q = searchQuery,
    source = sourceFilter,
    starred = starredOnly,
  ) => {
    if (q.trim()) {
      const c = await searchKnowledge(q, 30, proj || undefined);
      let filtered = c || [];
      if (source) filtered = filtered.filter((ch) => (ch.source || 'chat') === source);
      if (starred) filtered = filtered.filter((ch) => ch.is_starred);
      setChunks(filtered);
    } else {
      const c = await getKnowledgeChunks(proj, 30, source, starred);
      setChunks(c || []);
    }
  }, [projectFilter, searchQuery, sourceFilter, starredOnly]);

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
    setLoading(true);
    try {
      await reloadChunks(projectFilter, q, sourceFilter, starredOnly);
    } catch { message.error('搜索失败'); }
    finally { setLoading(false); }
  };

  const handleProjectChange = async (proj: string) => {
    setProjectFilter(proj);
    setLoading(true);
    try {
      await reloadChunks(proj, searchQuery, sourceFilter, starredOnly);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  const handleSourceChange = async (source: string) => {
    setSourceFilter(source);
    setLoading(true);
    try {
      await reloadChunks(projectFilter, searchQuery, source, starredOnly);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  const handleStarredChange = async (checked: boolean) => {
    setStarredOnly(checked);
    setLoading(true);
    try {
      await reloadChunks(projectFilter, searchQuery, sourceFilter, checked);
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  const openCreateModal = () => {
    setEditingChunk(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEditModal = (chunk: KnowledgeChunk) => {
    setEditingChunk(chunk);
    form.setFieldsValue({
      user_query: chunk.user_query,
      ai_response_core: chunk.ai_response_core,
      main_topic: chunk.main_topic,
      tags: chunk.tags,
      project_name: chunk.project_name,
    });
    setModalOpen(true);
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (editingChunk) {
        await updateKnowledgeChunk(editingChunk.id, {
          user_query: values.user_query,
          ai_response_core: values.ai_response_core,
          main_topic: values.main_topic,
          tags: values.tags,
        });
        message.success('更新成功');
      } else {
        await createKnowledgeChunk(values);
        message.success('创建成功');
      }
      setModalOpen(false);
      await reloadChunks();
      const s = await getKnowledgeStats();
      setStats(s);
    } catch (e) {
      if (e && typeof e === 'object' && 'errorFields' in e) return;
      message.error(editingChunk ? '更新失败' : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStarToggle = async (id: string) => {
    try {
      const res = await toggleKnowledgeStar(id);
      setChunks((prev) => prev.map((c) => (c.id === id ? { ...c, is_starred: res.is_starred } : c)));
    } catch { message.error('星标操作失败'); }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteKnowledgeChunk(id);
      message.success('删除成功');
      setChunks((prev) => prev.filter((c) => c.id !== id));
      const s = await getKnowledgeStats();
      setStats(s);
    } catch { message.error('删除失败'); }
  };

  if (loading && !stats) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;

  const chunkColumns = [
    {
      title: '项目', dataIndex: 'project_name', key: 'project', width: 100,
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : '-',
    },
    {
      title: '来源', dataIndex: 'source', key: 'source', width: 80,
      render: (v: string) => {
        const src = v || 'chat';
        return <Tag color={sourceColors[src] || 'default'}>{src}</Tag>;
      },
    },
    {
      title: '用户问题', dataIndex: 'user_query', key: 'query',
      ellipsis: true,
      render: (v: string) => <Tooltip title={v}><span>{v}</span></Tooltip>,
    },
    {
      title: '标签', key: 'meta', width: 140,
      render: (_: unknown, r: KnowledgeChunk) => (
        <Space size={2} wrap>
          {r.tags && r.tags.split(',').filter(Boolean).map((t) => (
            <Tag key={t} style={{ fontSize: 11 }}>{t.trim()}</Tag>
          ))}
          {r.has_code && <Tag color="geekblue"><CodeOutlined /> 代码</Tag>}
          {r.code_languages && <Tag>{r.code_languages}</Tag>}
        </Space>
      ),
    },
    {
      title: '星标', key: 'star', width: 50, align: 'center' as const,
      render: (_: unknown, r: KnowledgeChunk) => (
        <Button
          type="text" size="small"
          icon={r.is_starred ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
          onClick={() => handleStarToggle(r.id)}
        />
      ),
    },
    {
      title: '时间', dataIndex: 'timestamp', key: 'time', width: 100,
      render: (v: number) => v ? dayjs(v).format('MM-DD HH:mm') : '-',
    },
    {
      title: '操作', key: 'actions', width: 90,
      render: (_: unknown, r: KnowledgeChunk) => (
        <Space size={0}>
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditModal(r)} />
          <Popconfirm title="确认删除此知识片段？" onConfirm={() => handleDelete(r.id)} okText="删除" cancelText="取消">
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
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
                <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateModal}>
                  新建
                </Button>
                <Select
                  placeholder="按项目筛选" allowClear style={{ width: 150 }} size="small"
                  value={projectFilter || undefined}
                  onChange={(v) => handleProjectChange(v || '')}
                  options={stats?.project_distribution?.map((p) => ({ label: p.project, value: p.project })) || []}
                />
                <Select
                  placeholder="来源" allowClear style={{ width: 100 }} size="small"
                  value={sourceFilter || undefined}
                  onChange={(v) => handleSourceChange(v || '')}
                  options={[
                    { label: '聊天', value: 'chat' },
                    { label: '回顾', value: 'review' },
                    { label: '手动', value: 'manual' },
                  ]}
                />
                <Switch
                  checked={starredOnly}
                  onChange={handleStarredChange}
                  checkedChildren="星标"
                  unCheckedChildren="全部"
                  size="small"
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

      <Modal
        title={editingChunk ? '编辑知识片段' : '新建知识片段'}
        open={modalOpen}
        onOk={handleModalOk}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="user_query" label="用户问题" rules={[{ required: true, message: '请输入用户问题' }]}>
            <Input.TextArea rows={3} placeholder="输入用户问题" />
          </Form.Item>
          <Form.Item name="ai_response_core" label="AI 回复核心">
            <Input.TextArea rows={4} placeholder="输入 AI 回复核心内容（选填）" />
          </Form.Item>
          <Form.Item name="main_topic" label="主题">
            <Input placeholder="主题（选填）" />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Input placeholder="标签，逗号分隔（选填）" />
          </Form.Item>
          {!editingChunk && (
            <Form.Item name="project_name" label="项目">
              <Input placeholder="项目名称（选填）" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
