import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Tooltip } from 'antd';
import {
  CheckCircleFilled, CloseCircleFilled, LoadingOutlined,
  ClockCircleOutlined, MinusCircleFilled,
} from '@ant-design/icons';
import type { TaskStatus } from '@/types/session';

const iconMap: Record<TaskStatus, React.ReactNode> = {
  PENDING:   <ClockCircleOutlined style={{ fontSize: 14, color: '#999' }} />,
  RUNNING:   <LoadingOutlined spin style={{ fontSize: 14, color: '#1677ff' }} />,
  COMPLETED: <CheckCircleFilled style={{ fontSize: 14, color: '#52c41a' }} />,
  FAILED:    <CloseCircleFilled style={{ fontSize: 14, color: '#ff4d4f' }} />,
  SKIPPED:   <MinusCircleFilled style={{ fontSize: 14, color: '#faad14' }} />,
};

interface TaskNodeData {
  name: string;
  status: TaskStatus;
  statusColor: string;
  statusLabel: string;
  skill: string | null;
  duration: string;
  error: string | null;
  tooltip: string;
  tier: string;
}

function TaskNodeInner({ data }: { data: TaskNodeData }) {
  const { name, status, statusColor, skill, duration, error, tooltip } = data;
  const isRunning = status === 'RUNNING';

  return (
    <Tooltip
      title={<pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{tooltip}</pre>}
      placement="top"
    >
      <div style={{
        background: '#fff',
        borderRadius: 10,
        border: `1.5px solid ${statusColor}`,
        overflow: 'hidden',
        minWidth: 200,
        boxShadow: isRunning
          ? `0 0 12px ${statusColor}40, 0 2px 8px rgba(0,0,0,0.06)`
          : '0 2px 8px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.3s, border-color 0.3s',
      }}>
        {/* 顶部状态色条 */}
        <div style={{
          height: 3,
          background: statusColor,
          transition: 'background 0.3s',
        }} />

        <div style={{ padding: '8px 12px' }}>
          {/* 主标题行 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
          }}>
            {iconMap[status]}
            <span style={{
              fontWeight: 600,
              fontSize: 13,
              color: '#1a1a1a',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {name}
            </span>
          </div>

          {/* 副信息行 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: '#999',
            lineHeight: 1.4,
          }}>
            {skill && (
              <span style={{
                background: '#f0f5ff',
                color: '#4096ff',
                padding: '0 5px',
                borderRadius: 3,
                fontSize: 10,
                fontWeight: 500,
              }}>
                {skill}
              </span>
            )}
            {duration && <span>{duration}</span>}
          </div>

          {/* 错误信息 */}
          {error && (
            <div style={{
              fontSize: 11,
              color: '#ff4d4f',
              marginTop: 4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 200,
            }}>
              {error}
            </div>
          )}
        </div>
      </div>

      <Handle type="target" position={Position.Left} style={{ background: statusColor, width: 6, height: 6, border: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ background: statusColor, width: 6, height: 6, border: 'none' }} />
    </Tooltip>
  );
}

export default memo(TaskNodeInner);
