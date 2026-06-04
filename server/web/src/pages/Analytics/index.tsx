import { useEffect, useState } from 'react';
import { Card, Statistic, Row, Col, Table, Spin, message, DatePicker, Space, Tag, Progress, Tooltip } from 'antd';
import {
  ClockCircleOutlined,
  ProjectOutlined,
  ThunderboltOutlined,
  CalendarOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { getAnalytics, getAITracking, getTokenStats, getPipelineTrend } from '@/services/api';
import type { AnalyticsOverview, AITrackingSummary, TokenStats, PipelineTrend, FailedTaskDetail } from '@/services/api';
import MarkdownViewer from '@/components/MarkdownViewer';
import AITrackingCard from '@/components/AITrackingCard';
import SkillUsageCard from '@/components/SkillUsageCard';
import TokenStatsCard from '@/components/TokenStatsCard';

const { RangePicker } = DatePicker;

const categoryLabels: Record<string, string> = {
  debug: '问题排查',
  feature: '功能开发',
  refactor: '重构优化',
  architecture: '架构设计',
  devops: '运维部署',
  documentation: '文档',
  testing: '测试',
  monitoring: '监控告警',
  data: '数据处理',
  ai_workflow: 'AI 编排',
  config: '配置管理',
  other: '其他',
};

const categoryColors: Record<string, string> = {
  feature: '#1677ff',
  debug: '#ff4d4f',
  refactor: '#722ed1',
  architecture: '#52c41a',
  devops: '#fa8c16',
  documentation: '#faad14',
  testing: '#eb2f96',
  monitoring: '#13c2c2',
  data: '#2f54eb',
  ai_workflow: '#9254de',
  config: '#87d068',
  other: '#8c8c8c',
};

export default function Analytics() {
  const navigate = useNavigate();
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [aiData, setAiData] = useState<AITrackingSummary | null>(null);
  const [tokenData, setTokenData] = useState<TokenStats | null>(null);
  const [trendData, setTrendData] = useState<PipelineTrend | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(true);
  const [showFailDetails, setShowFailDetails] = useState(false);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(30, 'day'),
    dayjs(),
  ]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const fetchData = async () => {
    const start = dateRange[0].format('YYYY-MM-DD');
    const end = dateRange[1].format('YYYY-MM-DD');
    setLoading(true);
    setAiLoading(true);
    try {
      const [overview, tracking, tokens, trend] = await Promise.all([
        getAnalytics(start, end),
        getAITracking(start, end).catch(() => null),
        getTokenStats(start, end).catch(() => null),
        getPipelineTrend().catch(() => null),
      ]);
      setData(overview);
      setAiData(tracking);
      setTokenData(tokens);
      setTrendData(trend);
    } catch {
      message.error('加载效能数据失败');
    } finally {
      setLoading(false);
      setAiLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [dateRange]);

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  if (!data) return <div>无数据</div>;

  const maxSessions = Math.max(...(data.daily_trend?.map((d) => d.sessions) || [1]));
  const totalCategories = Object.values(data.category_distribution || {}).reduce((a, b) => a + b, 0);

  const projectColumns = [
    { title: '项目', dataIndex: 'name', key: 'name', render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: '会话数', dataIndex: 'sessions', key: 'sessions', sorter: (a: { sessions: number }, b: { sessions: number }) => a.sessions - b.sessions },
    { title: '活跃天数', dataIndex: 'days', key: 'days' },
    {
      title: '日均', key: 'avg',
      render: (_: unknown, r: { sessions: number; days: number }) =>
        (r.sessions / Math.max(r.days, 1)).toFixed(1),
    },
  ];

  const dailyColumns = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 120 },
    { title: '会话', dataIndex: 'sessions', key: 'sessions', width: 70 },
    {
      title: '项目', dataIndex: 'projects', key: 'projects',
      render: (ps: string[]) => ps?.map((p) => <Tag key={p} style={{ fontSize: 11 }}>{p}</Tag>),
    },
    {
      title: '工作类型', dataIndex: 'categories', key: 'categories',
      render: (cats: Record<string, number>) => {
        const entries = Object.entries(cats || {}).filter(([, v]) => v > 0);
        return entries.map(([k, v]) => (
          <Tag key={k} color={categoryColors[k]} style={{ fontSize: 11 }}>
            {categoryLabels[k] || k}: {v}
          </Tag>
        ));
      },
    },
  ];

  const selectedSummary = data.daily_summaries?.find((d) => d.date === selectedDay);

  return (
    <div>
      <Card
        title="Cursor 使用效能分析"
        extra={
          <Space>
            <CalendarOutlined />
            <RangePicker
              value={dateRange}
              onChange={(dates) => {
                if (dates?.[0] && dates?.[1]) setDateRange([dates[0], dates[1]]);
              }}
            />
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Row gutter={16}>
          <Col span={6}>
            <Statistic title="统计天数" value={data.total_days} prefix={<CalendarOutlined />} suffix="天" />
          </Col>
          <Col span={6}>
            <Statistic title="总会话数" value={data.total_sessions} prefix={<ThunderboltOutlined />} />
          </Col>
          <Col span={6}>
            <Statistic title="日均会话" value={data.avg_daily_sessions} prefix={<ClockCircleOutlined />} precision={1} />
          </Col>
          <Col span={6}>
            <Statistic title="涉及项目" value={data.project_distribution?.length || 0} prefix={<ProjectOutlined />} />
          </Col>
        </Row>
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={14}>
          <Card title="每日会话趋势" size="small">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, padding: '0 4px' }}>
              {data.daily_trend?.map((d) => (
                <Tooltip key={d.date} title={`${d.date}: ${d.sessions} 会话`}>
                  <div
                    style={{
                      flex: 1,
                      height: `${(d.sessions / maxSessions) * 100}%`,
                      minHeight: 4,
                      background: d.sessions >= 5 ? '#1677ff' : d.sessions >= 3 ? '#69b1ff' : '#bae0ff',
                      borderRadius: '2px 2px 0 0',
                      cursor: 'pointer',
                      border: selectedDay === d.date ? '2px solid #ff4d4f' : 'none',
                    }}
                    onClick={() => setSelectedDay(d.date === selectedDay ? null : d.date)}
                  />
                </Tooltip>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#999', marginTop: 4, padding: '0 4px' }}>
              <span>{data.daily_trend?.[0]?.date}</span>
              <span>{data.daily_trend?.[data.daily_trend.length - 1]?.date}</span>
            </div>
          </Card>
        </Col>
        <Col span={10}>
          <Card title="工作类型分布" size="small">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {Object.entries(data.category_distribution || {})
                .filter(([, v]) => v > 0)
                .sort(([, a], [, b]) => b - a)
                .map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 70, fontSize: 12, textAlign: 'right' }}>
                      {categoryLabels[k] || k}
                    </span>
                    <Progress
                      percent={Math.round((v / totalCategories) * 100)}
                      size="small"
                      strokeColor={categoryColors[k]}
                      format={() => `${v}`}
                      style={{ flex: 1 }}
                    />
                  </div>
                ))}
            </div>
          </Card>
        </Col>
      </Row>

      <TokenStatsCard data={tokenData} loading={aiLoading} />

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={16}>
          <AITrackingCard data={aiData} loading={aiLoading} />
        </Col>
        <Col span={8}>
          <SkillUsageCard data={data?.skill_usage || []} />
        </Col>
      </Row>

      {selectedDay && selectedSummary && (
        <Card title={`${selectedDay} 工作详情`} size="small" style={{ marginBottom: 16 }}>
          <MarkdownViewer content={selectedSummary.summary} />
        </Card>
      )}

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={10}>
          <Card title="项目分布" size="small">
            <Table
              rowKey="name"
              dataSource={data.project_distribution}
              columns={projectColumns}
              pagination={false}
              size="small"
            />
          </Card>
        </Col>
        <Col span={14}>
          <Card title="每日明细" size="small">
            <Table
              rowKey="date"
              dataSource={[...(data.daily_summaries || [])].reverse()}
              columns={dailyColumns}
              pagination={{ pageSize: 10, size: 'small' }}
              size="small"
              onRow={(record) => ({
                style: { cursor: 'pointer', background: selectedDay === record.date ? '#e6f4ff' : undefined },
                onClick: () => setSelectedDay(record.date === selectedDay ? null : record.date),
              })}
            />
          </Card>
        </Col>
      </Row>

      {trendData && (trendData.total_sessions > 0) && (
        <Card title={<Space><DashboardOutlined />编排趋势统计</Space>} style={{ marginBottom: 16 }}>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={4}><Statistic title="编排总数" value={trendData.total_sessions} /></Col>
            <Col span={4}><Statistic title="已完成" value={trendData.completed_sessions} valueStyle={{ color: '#52c41a' }} /></Col>
            <Col span={4}><Statistic title="总任务" value={trendData.total_tasks} /></Col>
            <Col span={4}>
              <div
                style={{ cursor: trendData.failed_tasks > 0 ? 'pointer' : 'default' }}
                onClick={() => trendData.failed_tasks > 0 && setShowFailDetails(!showFailDetails)}
              >
                <Statistic
                  title={<span>{trendData.failed_tasks > 0 ? (showFailDetails ? '▼ ' : '▶ ') : ''}失败任务</span>}
                  value={trendData.failed_tasks}
                  valueStyle={{ color: trendData.failed_tasks > 0 ? '#ff4d4f' : undefined }}
                />
              </div>
            </Col>
            <Col span={4}><Statistic title="失败率" value={trendData.task_fail_rate} precision={1} suffix="%" /></Col>
            <Col span={4}><Statistic title="平均任务数" value={trendData.avg_tasks_per_session} precision={1} suffix="/session" /></Col>
          </Row>
          {showFailDetails && (trendData.failed_task_details?.length ?? 0) > 0 && (
            <Card title="失败任务明细" size="small" type="inner" style={{ marginBottom: 12 }}>
              <Table<FailedTaskDetail> rowKey={(r) => `${r.session_id}-${r.task_id}`} size="small" pagination={false}
                dataSource={trendData.failed_task_details}
                columns={[
                  { title: '日期', dataIndex: 'date', key: 'date', width: 110 },
                  { title: '编排', key: 'session', render: (_: unknown, r: FailedTaskDetail) => (
                    <a onClick={() => navigate(`/sessions/${r.session_id}`)}>{r.session_name || r.session_id}</a>
                  )},
                  { title: '任务', dataIndex: 'task_name', key: 'task_name' },
                  { title: '错误', dataIndex: 'error', key: 'error', render: (v: string) => v || <Tag color="warning">未记录</Tag> },
                ]}
              />
            </Card>
          )}
          {trendData.top_failures && trendData.top_failures.length > 0 && (
            <Card title="Top 失败原因" size="small" type="inner">
              <Table rowKey="error" size="small" pagination={false}
                dataSource={trendData.top_failures}
                columns={[
                  { title: '错误', dataIndex: 'error', key: 'error' },
                  { title: '次数', dataIndex: 'count', key: 'count', width: 80, render: (v: number) => <Tag color="error">{v}</Tag> },
                ]}
              />
            </Card>
          )}
        </Card>
      )}
    </div>
  );
}
