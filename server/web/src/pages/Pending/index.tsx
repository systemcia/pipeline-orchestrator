import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Button, Space, Spin, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { getPending } from '@/services/api';
import MarkdownViewer from '@/components/MarkdownViewer';

export default function Pending() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getPending(id)
      .then(setContent)
      .catch(() => message.error('加载待确认项失败'))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/sessions/${id}`)}>
          返回详情
        </Button>
      </Space>
      <Card title="待确认事项">
        {loading ? (
          <Spin style={{ display: 'block', margin: '40px auto' }} />
        ) : (
          <MarkdownViewer content={content || '暂无待确认事项'} />
        )}
      </Card>
    </div>
  );
}
