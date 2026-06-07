import { useMemo, useCallback } from 'react';
import ReactFlow, {
  Node, Edge, Position, MarkerType, ReactFlowProvider,
  Background, Controls, MiniMap, BackgroundVariant,
} from 'reactflow';
import { Tooltip, Tag } from 'antd';
import {
  CheckCircleFilled, CloseCircleFilled, LoadingOutlined,
  ClockCircleOutlined, MinusCircleFilled,
} from '@ant-design/icons';
import dagre from 'dagre';
import 'reactflow/dist/style.css';
import type { Task, TaskStatus } from '@/types/session';
import dayjs from 'dayjs';
import TaskNode from './TaskNode';

const nodeTypes = { taskNode: TaskNode };

const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;

const statusMeta: Record<TaskStatus, { color: string; label: string }> = {
  PENDING:   { color: '#d9d9d9', label: '等待中' },
  RUNNING:   { color: '#1677ff', label: '执行中' },
  COMPLETED: { color: '#52c41a', label: '已完成' },
  FAILED:    { color: '#ff4d4f', label: '失败' },
  SKIPPED:   { color: '#faad14', label: '已跳过' },
};

function buildDagreLayout(tasks: Task[]) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 60, marginx: 20, marginy: 20 });

  const taskMap = new Map(tasks.map(t => [t.id, t]));

  for (const task of tasks) {
    g.setNode(task.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn || []) {
      if (taskMap.has(dep)) {
        g.setEdge(dep, task.id);
      }
    }
  }

  dagre.layout(g);

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  for (const task of tasks) {
    const pos = g.node(task.id);
    const meta = statusMeta[task.status];

    let durationText = '';
    if (task.startedAt && task.completedAt) {
      const sec = dayjs(task.completedAt).diff(dayjs(task.startedAt), 'second');
      durationText = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
    }

    const tooltipLines = [
      `状态: ${meta.label}`,
      task.description ? `描述: ${task.description}` : null,
      task.startedAt ? `开始: ${task.startedAt}` : null,
      task.completedAt ? `完成: ${task.completedAt}` : null,
      durationText ? `耗时: ${durationText}` : null,
      task.error ? `错误: ${task.error}` : null,
      task.logFile ? `日志: ${task.logFile}` : null,
      task.corrections > 0 ? `纠偏: ${task.corrections} 次` : null,
    ].filter(Boolean).join('\n');

    nodes.push({
      id: task.id,
      type: 'taskNode',
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: {
        name: task.name,
        status: task.status,
        statusColor: meta.color,
        statusLabel: meta.label,
        skill: task.skill,
        duration: durationText,
        error: task.error,
        tooltip: tooltipLines,
        tier: task.tier,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    for (const dep of task.dependsOn || []) {
      if (!taskMap.has(dep)) continue;
      const depTask = taskMap.get(dep)!;
      const edgeColor = task.status === 'COMPLETED' ? '#52c41a'
        : task.status === 'RUNNING' ? '#1677ff'
        : task.status === 'FAILED' ? '#ff4d4f'
        : '#d9d9d9';
      edges.push({
        id: `${dep}->${task.id}`,
        source: dep,
        target: task.id,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor, width: 16, height: 12 },
        style: { stroke: edgeColor, strokeWidth: depTask.status === 'COMPLETED' ? 2 : 1 },
        animated: task.status === 'RUNNING',
      });
    }
  }

  return { nodes, edges };
}

function DAGFlowInner({ tasks }: { tasks: Task[] }) {
  const { nodes, edges } = useMemo(() => {
    if (!tasks?.length) return { nodes: [], edges: [] };
    return buildDagreLayout(tasks);
  }, [tasks]);

  const completed = tasks.filter(t => t.status === 'COMPLETED' || t.status === 'SKIPPED').length;
  const failed = tasks.filter(t => t.status === 'FAILED').length;
  const running = tasks.filter(t => t.status === 'RUNNING').length;
  const pct = tasks.length > 0 ? Math.round(completed / tasks.length * 100) : 0;

  const minimapColor = useCallback((node: Node) => {
    return node.data?.statusColor || '#d9d9d9';
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 13, color: '#666', flexWrap: 'wrap', alignItems: 'center' }}>
        <span>进度: <b>{pct}%</b> ({completed}/{tasks.length})</span>
        {running > 0 && <Tag color="processing">执行中: {running}</Tag>}
        {failed > 0 && <Tag color="error">失败: {failed}</Tag>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#bbb' }}>滚轮缩放 · 拖拽平移</span>
      </div>
      <div style={{
        width: '100%',
        height: 520,
        background: '#f8f9fb',
        borderRadius: 10,
        border: '1px solid #e8ecf1',
        overflow: 'hidden',
      }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={0.15}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#dde1e8" />
          <Controls showInteractive={false} style={{ borderRadius: 8 }} />
          <MiniMap
            nodeColor={minimapColor}
            maskColor="rgba(0,0,0,0.08)"
            style={{ borderRadius: 8, border: '1px solid #e8ecf1' }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function DAGGraph({ tasks }: { tasks: Task[] }) {
  if (!tasks?.length) {
    return <div style={{ padding: 32, textAlign: 'center', color: '#999' }}>暂无任务</div>;
  }

  return (
    <div style={{ width: '100%' }}>
      <ReactFlowProvider>
        <DAGFlowInner tasks={tasks} />
      </ReactFlowProvider>
    </div>
  );
}
