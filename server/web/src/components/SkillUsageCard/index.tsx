import { Card, Table, Tag, Empty } from 'antd';
import { ToolOutlined } from '@ant-design/icons';

interface SkillStat {
  name: string;
  count: number;
}

interface Props {
  data: SkillStat[];
}

const skillColors: Record<string, string> = {
  'optimization-master': 'purple',
  'openspec-proposal': 'blue',
  'integration-test-generator': 'green',
  'e2e-test-validator': 'cyan',
  'troubleshooting': 'red',
  'cloud-logging': 'orange',
  'openspec-apply': 'geekblue',
};

export default function SkillUsageCard({ data }: Props) {
  if (!data?.length) {
    return (
      <Card title={<><ToolOutlined /> Skill 使用统计</>} size="small">
        <Empty description="暂无 Skill 使用数据" />
      </Card>
    );
  }

  const total = data.reduce((a, b) => a + b.count, 0);

  const columns = [
    {
      title: 'Skill',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Tag color={skillColors[name] || 'default'} icon={<ToolOutlined />}>
          /{name}
        </Tag>
      ),
    },
    {
      title: '使用次数',
      dataIndex: 'count',
      key: 'count',
      width: 100,
      sorter: (a: SkillStat, b: SkillStat) => a.count - b.count,
    },
    {
      title: '占比',
      key: 'percent',
      width: 80,
      render: (_: unknown, r: SkillStat) =>
        `${((r.count / total) * 100).toFixed(0)}%`,
    },
  ];

  return (
    <Card title={<><ToolOutlined /> Skill 使用统计 ({total} 次)</>} size="small">
      <Table
        rowKey="name"
        dataSource={data}
        columns={columns}
        pagination={false}
        size="small"
      />
    </Card>
  );
}
