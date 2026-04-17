import { Card, Table, Tag, Space, Alert, Descriptions, Tooltip } from 'antd';
import {
  CheckCircleFilled, CloseCircleFilled,
  SearchOutlined, SafetyCertificateOutlined, ExperimentOutlined,
} from '@ant-design/icons';
import type { RagQuery, ConsistencyCheck, TestResult } from '@/types/session';

interface Props {
  ragQueries?: RagQuery[];
  consistencyChecks?: ConsistencyCheck[];
  testResults?: TestResult[];
}

const testTypeLabels: Record<string, { text: string; color: string }> = {
  compile: { text: '编译检查', color: 'cyan' },
  unit: { text: '单元测试', color: 'blue' },
  integration: { text: '集成测试', color: 'purple' },
  e2e: { text: 'E2E 测试', color: 'geekblue' },
};

export default function QualityPanel({ ragQueries, consistencyChecks, testResults }: Props) {
  const hasRag = ragQueries && ragQueries.length > 0;
  const hasCCC = consistencyChecks && consistencyChecks.length > 0;
  const hasTest = testResults && testResults.length > 0;
  const hasAny = hasRag || hasCCC || hasTest;

  if (!hasAny) {
    return (
      <Alert
        type="info"
        message="暂无质量数据"
        description="RAG 搜索、CCC 校验、测试门的数据将在编排执行过程中自动记录到 state.json。"
        showIcon
      />
    );
  }

  const testStats = hasTest ? {
    total: testResults!.length,
    passed: testResults!.filter(t => t.result?.passed === true || t.result?.ok === true).length,
  } : null;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      {testStats && (
        <Card size="small" style={{ background: testStats.passed === testStats.total ? '#f6ffed' : '#fff2f0' }}>
          <Descriptions size="small" column={4}>
            <Descriptions.Item label="测试总数">{testStats.total}</Descriptions.Item>
            <Descriptions.Item label="通过">
              <span style={{ color: '#52c41a', fontWeight: 600 }}>{testStats.passed}</span>
            </Descriptions.Item>
            <Descriptions.Item label="失败">
              <span style={{ color: testStats.total - testStats.passed > 0 ? '#ff4d4f' : '#999', fontWeight: 600 }}>
                {testStats.total - testStats.passed}
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="通过率">
              <span style={{ fontWeight: 600 }}>
                {testStats.total > 0 ? Math.round(testStats.passed / testStats.total * 100) : 0}%
              </span>
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {hasTest && (
        <Card title={<><ExperimentOutlined /> 测试质量门 ({testResults!.length})</>} size="small">
          <Table
            rowKey={(_, i) => `test-${i}`}
            size="small"
            pagination={false}
            dataSource={testResults}
            columns={[
              {
                title: '类型', dataIndex: 'type', key: 'type', width: 120,
                render: (v: string) => {
                  const cfg = testTypeLabels[v] || { text: v, color: 'default' };
                  return <Tag color={cfg.color}>{cfg.text}</Tag>;
                },
              },
              {
                title: '结果', dataIndex: 'result', key: 'passed', width: 80,
                render: (v: { passed?: boolean; ok?: boolean }) => {
                  const passed = v?.passed === true || v?.ok === true;
                  return passed
                    ? <Tag color="success" icon={<CheckCircleFilled />}>PASS</Tag>
                    : <Tag color="error" icon={<CloseCircleFilled />}>FAIL</Tag>;
                },
              },
              {
                title: '详情', dataIndex: 'result', key: 'detail',
                render: (v: Record<string, unknown>) => {
                  const output = v?.output || v?.details || v?.error;
                  if (!output) return <span style={{ color: '#ccc' }}>-</span>;
                  const text = String(output);
                  return (
                    <Tooltip title={<pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{text}</pre>}>
                      <code style={{ fontSize: 11, maxWidth: 400, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {text.substring(0, 80)}{text.length > 80 ? '...' : ''}
                      </code>
                    </Tooltip>
                  );
                },
              },
              {
                title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 170,
              },
            ]}
          />
        </Card>
      )}

      {hasCCC && (
        <Card title={<><SafetyCertificateOutlined /> 上下文一致性校验 ({consistencyChecks!.length})</>} size="small">
          <Table
            rowKey={(_, i) => `ccc-${i}`}
            size="small"
            pagination={false}
            dataSource={consistencyChecks}
            columns={[
              {
                title: '类型', dataIndex: 'type', key: 'type', width: 100,
                render: (v: string) => <Tag color={v === 'proposal' ? 'blue' : 'green'}>{v === 'proposal' ? '提案校验' : 'Task校验'}</Tag>,
              },
              {
                title: 'Task', dataIndex: 'tid', key: 'tid', width: 60,
                render: (v: string) => v || '-',
              },
              {
                title: '对齐', dataIndex: 'result', key: 'aligned', width: 80,
                render: (v: Record<string, unknown>) => {
                  if (v?.aligned === true) return <Tag color="success">对齐</Tag>;
                  if (v?.aligned === false) return <Tag color="error">偏离</Tag>;
                  if (v?.coverage_pct !== undefined) {
                    const pct = Number(v.coverage_pct);
                    return <Tag color={pct >= 90 ? 'success' : 'warning'}>{pct}%</Tag>;
                  }
                  return <Tag>未知</Tag>;
                },
              },
              {
                title: '详情', dataIndex: 'result', key: 'detail',
                render: (v: Record<string, unknown>) => {
                  const issues = v?.issues as string[] || v?.deviations as string[] || v?.omissions as string[];
                  if (!issues?.length) return <span style={{ color: '#52c41a' }}>无问题</span>;
                  return (
                    <Tooltip title={issues.join('\n')}>
                      <Tag color="warning">{issues.length} 个问题</Tag>
                    </Tooltip>
                  );
                },
              },
              { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 170 },
            ]}
          />
        </Card>
      )}

      {hasRag && (
        <Card title={<><SearchOutlined /> RAG 搜索记录 ({ragQueries!.length})</>} size="small">
          <Table
            rowKey={(_, i) => `rag-${i}`}
            size="small"
            pagination={false}
            dataSource={ragQueries}
            columns={[
              { title: '查询关键词', dataIndex: 'query', key: 'query' },
              {
                title: '结果数', dataIndex: 'resultsCount', key: 'resultsCount', width: 80,
                render: (v: number) => <Tag>{v}</Tag>,
              },
              { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 170 },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}
