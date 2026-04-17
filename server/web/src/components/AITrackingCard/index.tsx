import { Card, Row, Col, Statistic, Tag, Tooltip, Spin } from 'antd';
import { CodeOutlined, RocketOutlined, FireOutlined } from '@ant-design/icons';
import type { AITrackingSummary } from '@/services/api';

interface Props {
  data: AITrackingSummary | null;
  loading: boolean;
}

export default function AITrackingCard({ data, loading }: Props) {
  if (loading) return <Card title="AI 代码生成统计" size="small"><Spin /></Card>;
  if (!data) return null;

  const maxVal = Math.max(...(data.daily_total?.map((d) => d.sessions) || [1]));

  return (
    <Card title="AI 代码生成统计" size="small" style={{ marginBottom: 16 }}>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Statistic title="总代码片段" value={data.total_code_hashes} prefix={<CodeOutlined />} />
        </Col>
        <Col span={6}>
          <Statistic title="日均生成" value={Math.round(data.avg_daily)} prefix={<RocketOutlined />} />
        </Col>
        <Col span={6}>
          <Statistic
            title="峰值日"
            value={data.peak_count}
            prefix={<FireOutlined />}
            suffix={<span style={{ fontSize: 12, color: '#999' }}>{data.peak_day}</span>}
          />
        </Col>
        <Col span={6}>
          <div style={{ marginBottom: 4, fontSize: 14, color: '#666' }}>模型分布</div>
          {data.model_distribution?.map((m) => (
            <Tag key={m.model} color={m.model.includes('opus') ? 'purple' : 'default'}>
              {m.model}: {m.count}
            </Tag>
          ))}
        </Col>
      </Row>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>每日 AI 代码生成量</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 80, padding: '0 4px' }}>
        {data.daily_total?.map((d) => (
          <Tooltip key={d.date} title={`${d.date}: ${d.sessions} 片段`}>
            <div
              style={{
                flex: 1,
                height: `${(d.sessions / maxVal) * 100}%`,
                minHeight: 2,
                background: d.sessions > data.avg_daily * 1.5
                  ? '#722ed1' : d.sessions > data.avg_daily ? '#b37feb' : '#d3adf7',
                borderRadius: '2px 2px 0 0',
              }}
            />
          </Tooltip>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#999', marginTop: 2, padding: '0 4px' }}>
        <span>{data.daily_total?.[0]?.date}</span>
        <span>{data.daily_total?.[data.daily_total.length - 1]?.date}</span>
      </div>
    </Card>
  );
}
