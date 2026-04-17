import { Card, Row, Col, Statistic, Tag, Tooltip, Spin } from 'antd';
import { DollarOutlined, FireOutlined, FundOutlined } from '@ant-design/icons';
import type { TokenStats } from '@/services/api';

interface Props {
  data: TokenStats | null;
  loading: boolean;
}

export default function TokenStatsCard({ data, loading }: Props) {
  if (loading) return <Card title="Token 使用统计" size="small"><Spin /></Card>;
  if (!data) return null;

  const maxVal = Math.max(...(data.daily_trend?.map((d) => d.tokens) || [1]));

  return (
    <Card title="Token 使用统计" size="small" style={{ marginBottom: 16 }}>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Statistic
            title="总 Token"
            value={Math.round(data.total_tokens / 1000)}
            prefix={<DollarOutlined />}
            suffix="K"
          />
        </Col>
        <Col span={6}>
          <Statistic title="会话数" value={data.total_sessions} prefix={<FundOutlined />} />
        </Col>
        <Col span={6}>
          <Statistic
            title="均值/会话"
            value={Math.round(data.avg_per_session / 1000)}
            suffix="K"
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="峰值会话"
            value={Math.round(data.max_tokens / 1000)}
            prefix={<FireOutlined />}
            suffix="K"
          />
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={14}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>每日 Token 消耗</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60 }}>
            {data.daily_trend?.map((d) => (
              <Tooltip key={d.date} title={`${d.date}: ${(d.tokens / 1000).toFixed(0)}K (${d.sessions}会话)`}>
                <div
                  style={{
                    flex: 1,
                    height: `${(d.tokens / maxVal) * 100}%`,
                    minHeight: 2,
                    background: d.tokens > data.avg_per_session * 3 ? '#ff4d4f' : '#faad14',
                    borderRadius: '2px 2px 0 0',
                  }}
                />
              </Tooltip>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#999', marginTop: 2 }}>
            <span>{data.daily_trend?.[0]?.date}</span>
            <span>{data.daily_trend?.[data.daily_trend.length - 1]?.date}</span>
          </div>
        </Col>
        <Col span={10}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>按项目分布</div>
          {data.project_distribution?.slice(0, 5).map((p) => (
            <div key={p.project} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
              <Tag style={{ fontSize: 11 }}>{p.project}</Tag>
              <span>{(p.tokens / 1000).toFixed(0)}K</span>
            </div>
          ))}
        </Col>
      </Row>
    </Card>
  );
}
