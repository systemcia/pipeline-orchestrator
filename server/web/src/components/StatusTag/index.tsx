import { Tag } from 'antd';
import type { SessionStatus, TaskStatus } from '@/types/session';

const sessionColors: Record<SessionStatus, string> = {
  PLANNING: 'blue',
  PROPOSING: 'cyan',
  APPLYING: 'geekblue',
  VERIFYING: 'purple',
  ARCHIVING: 'orange',
  COMPLETED: 'green',
  ARCHIVED: 'default',
  PAUSED: 'warning',
  FAILED: 'error',
};

const taskColors: Record<TaskStatus, string> = {
  PENDING: 'default',
  RUNNING: 'processing',
  COMPLETED: 'success',
  FAILED: 'error',
  SKIPPED: 'warning',
};

export function SessionStatusTag({ status }: { status: SessionStatus }) {
  return <Tag color={sessionColors[status]}>{status}</Tag>;
}

export function TaskStatusTag({ status }: { status: TaskStatus }) {
  return <Tag color={taskColors[status]}>{status}</Tag>;
}
