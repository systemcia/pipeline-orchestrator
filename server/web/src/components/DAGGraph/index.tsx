import { useMemo } from 'react';
import ReactFlow, { Node, Edge, Position, MarkerType, ReactFlowProvider } from 'reactflow';
import { Tooltip, Tag } from 'antd';
import {
  CheckCircleFilled, CloseCircleFilled, LoadingOutlined,
  ClockCircleOutlined, MinusCircleFilled,
} from '@ant-design/icons';
import 'reactflow/dist/style.css';
import type { Task, TaskStatus } from '@/types/session';
import dayjs from 'dayjs';

const statusConfig: Record<TaskStatus, { bg: string; border: string; icon: React.ReactNode; label: string }> = {
  PENDING:   { bg: '#fafafa',  border: '#d9d9d9', icon: <ClockCircleOutlined style={{ color: '#999' }} />,     label: '等待中' },
  RUNNING:   { bg: '#e6f4ff',  border: '#1677ff', icon: <LoadingOutlined spin style={{ color: '#1677ff' }} />, label: '执行中' },
  COMPLETED: { bg: '#f6ffed',  border: '#52c41a', icon: <CheckCircleFilled style={{ color: '#52c41a' }} />,    label: '已完成' },
  FAILED:    { bg: '#fff2f0',  border: '#ff4d4f', icon: <CloseCircleFilled style={{ color: '#ff4d4f' }} />,    label: '失败' },
  SKIPPED:   { bg: '#fffbe6',  border: '#faad14', icon: <MinusCircleFilled style={{ color: '#faad14' }} />,    label: '已跳过' },
};

interface Props {
  tasks: Task[];
}

function TaskNodeLabel({ task }: { task: Task }) {
  const cfg = statusConfig[task.status];

  const durationText = (() => {
    if (!task.startedAt || !task.completedAt) return '';
    const sec = dayjs(task.completedAt).diff(dayjs(task.startedAt), 'second');
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
  })();

  const content = (
    <div style={{ textAlign: 'center', padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 4 }}>
        {cfg.icon}
        <span style={{ fontWeight: 600, fontSize: 13 }}>{task.name}</span>
      </div>
      <div style={{ fontSize: 11, color: '#888' }}>
        {task.id}
        {task.skill ? ` · ${task.skill}` : ''}
        {durationText ? ` · ${durationText}` : ''}
      </div>
      {task.error && (
        <div style={{ fontSize: 11, color: '#ff4d4f', marginTop: 4, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.error}
        </div>
      )}
    </div>
  );

  const tooltipLines = [
    `状态: ${cfg.label}`,
    task.description ? `描述: ${task.description}` : null,
    task.startedAt ? `开始: ${task.startedAt}` : null,
    task.completedAt ? `完成: ${task.completedAt}` : null,
    durationText ? `耗时: ${durationText}` : null,
    task.error ? `错误: ${task.error}` : null,
    task.logFile ? `日志: ${task.logFile}` : null,
    task.corrections > 0 ? `纠偏: ${task.corrections} 次` : null,
  ].filter(Boolean).join('\n');

  return (
    <Tooltip title={<pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{tooltipLines}</pre>}>
      {content}
    </Tooltip>
  );
}

function DAGFlowInner({ tasks }: Props) {
  const { nodes, edges } = useMemo(() => {
    if (!tasks?.length) return { nodes: [], edges: [] };

    const tierMap = new Map<string, Task[]>();
    for (const t of tasks) {
      const tier = t.tier || 'default';
      if (!tierMap.has(tier)) tierMap.set(tier, []);
      tierMap.get(tier)!.push(t);
    }

    const tiers = Array.from(tierMap.keys()).sort();
    const maxTasksInTier = Math.max(...Array.from(tierMap.values()).map(arr => arr.length));
    const nodeWidth = 220;
    const nodeHeight = 90;
    const xGap = Math.max(nodeWidth + 40, 260);
    const yGap = Math.max(nodeHeight + 20, 100);

    const ns: Node[] = [];
    const es: Edge[] = [];

    tiers.forEach((tier, tierIdx) => {
      const tierTasks = tierMap.get(tier)!;
      const yOffset = (maxTasksInTier - tierTasks.length) * yGap / 2;
      tierTasks.forEach((task, taskIdx) => {
        const cfg = statusConfig[task.status];
        ns.push({
          id: task.id,
          position: { x: tierIdx * xGap, y: taskIdx * yGap + yOffset },
          data: { label: <TaskNodeLabel task={task} /> },
          style: {
            background: cfg.bg,
            border: `2px solid ${cfg.border}`,
            borderRadius: 8,
            padding: '6px 12px',
            minWidth: nodeWidth - 40,
            boxShadow: task.status === 'RUNNING' ? `0 0 8px ${cfg.border}60` : 'none',
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        });

        for (const dep of (task.dependsOn || [])) {
          const depTask = tasks.find(t => t.id === dep);
          const edgeColor = task.status === 'COMPLETED' ? '#52c41a'
            : task.status === 'RUNNING' ? '#1677ff'
            : task.status === 'FAILED' ? '#ff4d4f'
            : '#d9d9d9';
          es.push({
            id: `${dep}-${task.id}`,
            source: dep,
            target: task.id,
            markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor },
            style: { stroke: edgeColor, strokeWidth: depTask?.status === 'COMPLETED' ? 2 : 1 },
            animated: task.status === 'RUNNING',
          });
        }
      });
    });

    return { nodes: ns, edges: es };
  }, [tasks]);

  const completed = tasks.filter(t => t.status === 'COMPLETED' || t.status === 'SKIPPED').length;
  const failed = tasks.filter(t => t.status === 'FAILED').length;
  const running = tasks.filter(t => t.status === 'RUNNING').length;
  const pct = tasks.length > 0 ? Math.round(completed / tasks.length * 100) : 0;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 13, color: '#666', flexWrap: 'wrap' }}>
        <span>进度: <b>{pct}%</b> ({completed}/{tasks.length})</span>
        {running > 0 && <Tag color="processing">执行中: {running}</Tag>}
        {failed > 0 && <Tag color="error">失败: {failed}</Tag>}
      </div>
      <div style={{
        width: '100%',
        height: Math.max(350, tasks.length * 80 + 60),
        background: '#fafafa',
        borderRadius: 8,
        border: '1px solid #f0f0f0',
      }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={0.2}
          maxZoom={1.5}
        />
      </div>
    </div>
  );
}

export default function DAGGraph({ tasks }: Props) {
  if (!tasks?.length) {
    return <div style={{ padding: 32, textAlign: 'center', color: '#999' }}>暂无任务</div>;
  }

  return (
    <div style={{ width: '100%', height: Math.max(400, tasks.length * 80 + 100) }}>
      <ReactFlowProvider>
        <DAGFlowInner tasks={tasks} />
      </ReactFlowProvider>
    </div>
  );
}
