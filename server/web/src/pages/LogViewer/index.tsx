import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Card, List, Button, Spin, Space, message, Empty } from 'antd';
import { ArrowLeftOutlined, FileTextOutlined } from '@ant-design/icons';
import { getLogs, getLog } from '@/services/api';
import MarkdownViewer from '@/components/MarkdownViewer';
import type { LogEntry } from '@/types/session';

export default function LogViewer() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);

  const handleSelect = async (name: string) => {
    if (!id) return;
    setSelected(name);
    setContentLoading(true);
    try {
      const text = await getLog(id, name);
      setContent(text);
    } catch {
      message.error('加载日志内容失败');
    } finally {
      setContentLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getLogs(id)
      .then((data) => {
        const list = data || [];
        setLogs(list);
        const fileParam = searchParams.get('file');
        if (fileParam && list.some(l => l.name === fileParam)) {
          handleSelect(fileParam);
        } else if (list.length > 0 && !selected) {
          handleSelect(list[0].name);
        }
      })
      .catch(() => message.error('加载日志列表失败'))
      .finally(() => setLoading(false));
  }, [id]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/sessions/${id}`)}>
          返回详情
        </Button>
      </Space>

      <div style={{ display: 'flex', gap: 16 }}>
        <Card title={`日志文件 (${logs.length})`} style={{ width: 320, flexShrink: 0 }} loading={loading}>
          {logs.length === 0 ? (
            <Empty description="暂无日志" />
          ) : (
            <List
              size="small"
              dataSource={logs}
              renderItem={(item) => (
                <List.Item
                  style={{
                    cursor: 'pointer',
                    background: selected === item.name ? '#e6f4ff' : undefined,
                    padding: '8px 12px',
                    borderRadius: 4,
                  }}
                  onClick={() => handleSelect(item.name)}
                >
                  <List.Item.Meta
                    avatar={<FileTextOutlined />}
                    title={<span style={{ fontSize: 13 }}>{item.name}</span>}
                    description={
                      <span style={{ fontSize: 11 }}>
                        {formatSize(item.size)} | {item.modTime}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>

        <Card title={selected || '选择日志查看'} style={{ flex: 1, overflow: 'auto' }}>
          {contentLoading ? (
            <Spin style={{ display: 'block', margin: '40px auto' }} />
          ) : selected ? (
            <MarkdownViewer content={content} />
          ) : (
            <Empty description="请在左侧选择日志文件" />
          )}
        </Card>
      </div>
    </div>
  );
}
