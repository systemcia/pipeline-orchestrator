import { useEffect, useState } from 'react';
import { Card, Descriptions, Spin, message } from 'antd';
import { getConfig } from '@/services/api';

export default function Settings() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch(() => message.error('加载配置失败'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spin style={{ display: 'block', margin: '100px auto' }} />;

  const configPath = config?.config_path as string || '未知';
  const configExists = config?.config_exists as boolean;

  return (
    <Card title="配置信息">
      <Descriptions column={1} bordered size="small">
        {config && Object.entries(config)
          .filter(([key]) => !['config_path', 'config_exists'].includes(key))
          .map(([key, value]) => (
            <Descriptions.Item key={key} label={key}>
              <code>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</code>
            </Descriptions.Item>
          ))}
      </Descriptions>
      <div style={{ marginTop: 16, color: '#999', fontSize: 12 }}>
        配置文件路径：{configPath}
        {!configExists && <span style={{ color: '#faad14', marginLeft: 8 }}>（文件不存在，使用默认配置）</span>}
      </div>
    </Card>
  );
}
