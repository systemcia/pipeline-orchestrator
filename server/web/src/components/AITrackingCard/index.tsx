import { Card, Row, Col, Statistic, Tag, Tooltip, Spin } from 'antd';
import { CodeOutlined, RocketOutlined, FireOutlined, FileTextOutlined } from '@ant-design/icons';
import type { AITrackingSummary } from '@/services/api';

interface Props {
  data: AITrackingSummary | null;
  loading: boolean;
}

function formatNum(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function AITrackingCard({ data, loading }: Props) {
  if (loading) return <Card title="AI 代码生成统计" size="small"><Spin /></Card>;
  if (!data || data.daily.length === 0) return null;

  const maxVal = Math.max(...data.daily.map((d) => d.lines_added), 1);

  return (
    <Card
      title="AI 代码生成统计"
      size="small"
      style={{ marginBottom: 16 }}
      extra={
        <span style={{ fontSize: 11, color: '#999' }}>
          {data.actual_range?.start} ~ {data.actual_range?.end}
        </span>
      }
    >
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={5}>
          <Statistic
            title="总新增行数"
            value={data.total_lines_added}
            prefix={<CodeOutlined />}
            formatter={(v) => formatNum(Number(v))}
          />
        </Col>
        <Col span={5}>
          <Statistic
            title="日均新增"
            value={data.avg_daily_added}
            prefix={<RocketOutlined />}
            suffix="行"
          />
        </Col>
        <Col span={4}>
          <Statistic
            title="峰值日"
            value={data.peak_added}
            prefix={<FireOutlined />}
            suffix={<span style={{ fontSize: 11, color: '#999' }}>{data.peak_day?.slice(5)}</span>}
          />
        </Col>
        <Col span={4}>
          <Statistic title="文件变更" value={data.total_files} prefix={<FileTextOutlined />} />
        </Col>
        <Col span={6}>
          <div style={{ marginBottom: 4, fontSize: 14, color: '#666' }}>模式分布</div>
          {data.mode_distribution?.slice(0, 4).map((m) => (
            <Tag key={m.mode} color={m.mode === 'agent' ? 'purple' : m.mode === 'composer' ? 'blue' : 'default'}>
              {m.mode}: {m.count}
            </Tag>
          ))}
        </Col>
      </Row>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>每日代码新增行数</span>
        <span style={{ fontSize: 11, color: '#999' }}>
          {data.total_sessions} 个 session · 删除 {formatNum(data.total_lines_removed)} 行 · {formatNum(data.total_tokens)} tokens
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 80, padding: '0 4px' }}>
        {data.daily.map((d) => (
          <Tooltip key={d.date} title={`${d.date}: +${d.lines_added} -${d.lines_removed} | ${d.sessions} session · ${d.files} 文件`}>
            <div
              style={{
                flex: 1,
                height: `${(d.lines_added / maxVal) * 100}%`,
                minHeight: 2,
                background: d.lines_added > data.avg_daily_added * 1.5
                  ? '#722ed1' : d.lines_added > data.avg_daily_added ? '#b37feb' : '#d3adf7',
                borderRadius: '2px 2px 0 0',
              }}
            />
          </Tooltip>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#999', marginTop: 2, padding: '0 4px' }}>
        <span>{data.daily[0]?.date}</span>
        <span>{data.daily[data.daily.length - 1]?.date}</span>
      </div>
    </Card>
  );
}
