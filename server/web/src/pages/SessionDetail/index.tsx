import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card, Descriptions, Table, Tabs, Space, Button, Spin,
  message, Tag, Alert, Progress, Tooltip,
} from 'antd';
import {
  FileTextOutlined, WarningOutlined,
  ArrowLeftOutlined, SafetyCertificateOutlined, ReloadOutlined,
  CheckCircleOutlined, ToolOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  getSession, getSessionMD, getSnapshots, getLogs,
  validateSession, getLessons, getImprovements,
  getAnalysisTrace, getDesignBrief, completeSession,
  getOpenSpecInfo, repairSessionDocs, generateReview,
} from '@/services/api';
import type { ValidationResult, OpenSpecInfo } from '@/services/api';
import { usePipelineEvents } from '@/services/websocket';
import { SessionStatusTag, TaskStatusTag } from '@/components/StatusTag';
import MarkdownViewer from '@/components/MarkdownViewer';
import DAGGraph from '@/components/DAGGraph';
import QualityPanel from '@/components/QualityPanel';
import type { SessionState, Task, SnapshotEntry, LogEntry } from '@/types/session';

const scaleLabels: Record<string, string> = { small: '小', medium: '中', large: '大' };

const WS_DETAIL_REFRESH = new Set(['task_start', 'task_done', 'task_fail', 'session_update']);

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionState | null>(null);
  const [sessionMd, setSessionMd] = useState('');
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [lessonsMd, setLessonsMd] = useState('');
  const [improvementsMd, setImprovementsMd] = useState('');
  const [analysisTrace, setAnalysisTrace] = useState('');
  const [designBrief, setDesignBrief] = useState('');
  const [openspecInfo, setOpenspecInfo] = useState<OpenSpecInfo | null>(null);
  const [activeTab, setActiveTab] = useState('tasks');
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [generatingReview, setGeneratingReview] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [s, md, snaps, logList, v, lessons, improvements, trace, brief, osInfo] = await Promise.all([
        getSession(id),
        getSessionMD(id),
        getSnapshots(id),
        getLogs(id),
        validateSession(id),
        getLessons(id).catch(() => ''),
        getImprovements(id).catch(() => ''),
        getAnalysisTrace(id).catch(() => ''),
        getDesignBrief(id).catch(() => ''),
        getOpenSpecInfo(id).catch(() => null),
      ]);
      setSession(s);
      setSessionMd(md);
      setSnapshots(snaps || []);
      setLogs(logList || []);
      setValidation(v);
      setLessonsMd(lessons || '');
      setImprovementsMd(improvements || '');
      setAnalysisTrace(trace || '');
      setDesignBrief(brief || '');
      setOpenspecInfo(osInfo);
    } catch {
      message.error('加载会话详情失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchRef = useRef(fetchData);
  fetchRef.current = fetchData;
  const idRef = useRef(id);
  idRef.current = id;
  usePipelineEvents((e) => {
    const cur = idRef.current;
    if (!cur || e.sessionId !== cur || !WS_DETAIL_REFRESH.has(e.eventType)) return;
    void fetchRef.current();
  });

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  if (!session) return <div>会话不存在</div>;

  const completed = session.tasks?.filter(t => t.status === 'COMPLETED' || t.status === 'SKIPPED').length || 0;
  const failed = session.tasks?.filter(t => t.status === 'FAILED').length || 0;
  const running = session.tasks?.filter(t => t.status === 'RUNNING').length || 0;
  const pending = session.tasks?.filter(t => t.status === 'PENDING').length || 0;
  const total = session.tasks?.length || 0;
  const pct = total > 0 ? Math.round(completed / total * 100) : 0;
  const canComplete = session.status !== 'COMPLETED' && pending === 0 && running === 0;

  const handleComplete = async () => {
    if (!id || completing) return;
    setCompleting(true);
    try {
      const res = await completeSession(id);
      if (res.ok) {
        message.success('会话已标记为完成');
        fetchData();
      } else {
        message.error(res.message);
      }
    } catch {
      message.error('操作失败');
    } finally {
      setCompleting(false);
    }
  };

  const handleGenerateReview = async () => {
    if (!id || generatingReview) return;
    setGeneratingReview(true);
    try {
      await generateReview(id);
      message.info('正在生成回顾分析，请稍候...');
      let retries = 0;
      const poll = setInterval(async () => {
        retries++;
        try {
          const [lessons, improvements] = await Promise.all([
            getLessons(id).catch(() => ''),
            getImprovements(id).catch(() => ''),
          ]);
          if ((lessons && lessons.length > 10) || (improvements && improvements.length > 10)) {
            clearInterval(poll);
            pollRef.current = null;
            setLessonsMd(lessons || '');
            setImprovementsMd(improvements || '');
            setGeneratingReview(false);
            message.success('回顾分析已生成');
          } else if (retries >= 20) {
            clearInterval(poll);
            pollRef.current = null;
            setGeneratingReview(false);
            message.warning('生成超时，请手动刷新查看');
          }
        } catch {
          if (retries >= 20) {
            clearInterval(poll);
            pollRef.current = null;
            setGeneratingReview(false);
          }
        }
      }, 3000);
      pollRef.current = poll;
    } catch (e) {
      setGeneratingReview(false);
      message.error('生成回顾失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const needsRepair = !analysisTrace || !designBrief;
  const handleRepair = async () => {
    if (!id || repairing) return;
    setRepairing(true);
    try {
      const res = await repairSessionDocs(id);
      if (res.repaired.length > 0) {
        message.success(res.message);
        fetchData();
      } else {
        message.info(res.message);
      }
    } catch {
      message.error('补全失败');
    } finally {
      setRepairing(false);
    }
  };

  const taskColumns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (s: Task['status']) => <TaskStatusTag status={s} />,
    },
    { title: 'Tier', dataIndex: 'tier', key: 'tier', width: 70 },
    {
      title: '技能', dataIndex: 'skill', key: 'skill', width: 140,
      render: (v: string | null) => v ? <Tag color="blue">{v}</Tag> : <span style={{ color: '#ccc' }}>-</span>,
    },
    {
      title: '执行器', dataIndex: 'agentType', key: 'agentType', width: 100,
      render: (v: string) => {
        const labels: Record<string, string> = {
          generalPurpose: '通用', fast: '快速', explore: '探索',
          evaluator: '评审', shell: '命令行',
        };
        const label = labels[v] || v;
        return label ? <Tag>{label}</Tag> : <span style={{ color: '#ccc' }}>-</span>;
      },
    },
    {
      title: '纠偏', dataIndex: 'corrections', key: 'corrections', width: 50,
      render: (v: number) => v > 0 ? <Tag color="orange">{v}</Tag> : 0,
    },
    {
      title: '错误', dataIndex: 'error', key: 'error',
      ellipsis: true,
      render: (v: string) => v ? (
        <Tooltip title={v}>
          <Tag color="error" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', whiteSpace: 'nowrap' }}>
            {v}
          </Tag>
        </Tooltip>
      ) : '-',
    },
    {
      title: '快照', dataIndex: 'snapshotRef', key: 'snapshotRef', width: 60,
      render: (v: string) => v ? <Tooltip title={v}><Tag color="green">✓</Tag></Tooltip> : <span style={{ color: '#ccc' }}>-</span>,
    },
    {
      title: '日志', dataIndex: 'logFile', key: 'logFile', width: 70,
      render: (v: string) => v ? (
        <Button type="link" size="small" onClick={() => navigate(`/sessions/${id}/logs?file=${encodeURIComponent(v)}`)}>查看</Button>
      ) : <span style={{ color: '#ccc' }}>-</span>,
    },
    {
      title: '耗时', key: 'duration', width: 90,
      render: (_: unknown, record: Task) => {
        if (!record.startedAt || !record.completedAt) return <span style={{ color: '#ccc' }}>-</span>;
        const sec = dayjs(record.completedAt).diff(dayjs(record.startedAt), 'second');
        return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
      },
    },
  ];

  const snapshotColumns = [
    { title: '名称', dataIndex: 'name', key: 'name',
      render: (v: string) => {
        const tid = v.replace(/^after-/, '');
        const task = session?.tasks?.find(t => t.id === tid);
        return task ? <Tooltip title={`Task: ${task.name}`}><Tag color="blue">{v}</Tag></Tooltip> : v;
      },
    },
    { title: 'Git Ref', dataIndex: 'ref', key: 'ref', render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: '时间', dataIndex: 'modTime', key: 'modTime', width: 170 },
  ];

  const logColumns = [
    {
      title: '文件名', dataIndex: 'name', key: 'name',
      render: (v: string) => (
        <a onClick={() => navigate(`/sessions/${id}/logs?file=${encodeURIComponent(v)}`)}>{v}</a>
      ),
    },
    { title: '大小', dataIndex: 'size', key: 'size', width: 80, render: (v: number) => v < 1024 ? `${v}B` : `${(v / 1024).toFixed(1)}KB` },
    { title: '修改时间', dataIndex: 'modTime', key: 'modTime', width: 170 },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: unknown, record: LogEntry) => (
        <Button type="link" size="small" onClick={() => navigate(`/sessions/${id}/logs?file=${encodeURIComponent(record.name)}`)}>
          查看
        </Button>
      ),
    },
  ];

  const tabItems = [
    {
      key: 'tasks',
      label: `任务 (${completed}/${total})`,
      children: (
        <Table
          rowKey="id"
          dataSource={session.tasks}
          columns={taskColumns}
          pagination={false}
          size="small"
          expandable={{
            expandedRowRender: (record: Task) => record.description ? (
              <div style={{ padding: '8px 16px', fontSize: 13, color: '#555' }}>
                <b>描述：</b>{record.description}
              </div>
            ) : null,
            rowExpandable: (record: Task) => !!record.description,
          }}
        />
      ),
    },
    {
      key: 'dag',
      label: 'DAG 视图',
      children: <DAGGraph tasks={session.tasks} />,
    },
    {
      key: 'quality',
      label: `质量数据 (${(session.testResults?.length || 0) + (session.consistencyChecks?.length || 0) + (session.ragQueries?.length || 0)})`,
      children: (
        <QualityPanel
          ragQueries={session.ragQueries}
          consistencyChecks={session.consistencyChecks}
          testResults={session.testResults}
        />
      ),
    },
    {
      key: 'logs',
      label: `日志 (${logs.length})`,
      children: logs.length > 0 ? (
        <Table rowKey="name" dataSource={logs} columns={logColumns} pagination={false} size="small" />
      ) : (
        <Alert type="warning" message="暂无执行日志" showIcon />
      ),
    },
    {
      key: 'analysis-trace',
      label: '需求追踪',
      children: analysisTrace ? <MarkdownViewer content={analysisTrace} /> : (
        <Alert
          type="info"
          message="无需求分析追踪"
          description={<Button size="small" icon={<ToolOutlined />} onClick={handleRepair} loading={repairing}>从 OpenSpec / 会话上下文补全</Button>}
          showIcon
        />
      ),
    },
    {
      key: 'design-brief',
      label: '设计简报',
      children: designBrief ? <MarkdownViewer content={designBrief} /> : (
        <Alert
          type="info"
          message="无设计简报"
          description={<Button size="small" icon={<ToolOutlined />} onClick={handleRepair} loading={repairing}>从 OpenSpec 补全</Button>}
          showIcon
        />
      ),
    },
    {
      key: 'context',
      label: 'Session 上下文',
      children: sessionMd ? <MarkdownViewer content={sessionMd} /> : (
        <Alert type="info" message="无 session.md" showIcon />
      ),
    },
    {
      key: 'snapshots',
      label: `快照 (${snapshots.length})`,
      children: snapshots.length > 0 ? (
        <Table rowKey="name" dataSource={snapshots} columns={snapshotColumns} pagination={false} size="small" />
      ) : (
        <Alert type="info" message="暂无快照" showIcon />
      ),
    },
    {
      key: 'lessons',
      label: '经验教训',
      children: lessonsMd ? <MarkdownViewer content={lessonsMd} /> : (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Alert type="info" message="暂无经验教训" showIcon style={{ marginBottom: 16 }} />
          <Button type="primary" loading={generatingReview} onClick={handleGenerateReview}>
            生成回顾分析
          </Button>
        </div>
      ),
    },
    {
      key: 'improvements',
      label: '改进建议',
      children: improvementsMd ? <MarkdownViewer content={improvementsMd} /> : (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Alert type="info" message="暂无改进建议" showIcon style={{ marginBottom: 16 }} />
          {!lessonsMd && (
            <Button type="primary" loading={generatingReview} onClick={handleGenerateReview}>
              生成回顾分析
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
        <Button icon={<FileTextOutlined />} onClick={() => navigate(`/sessions/${id}/logs`)}>执行日志</Button>
        <Button icon={<WarningOutlined />} onClick={() => navigate(`/sessions/${id}/pending`)}>待确认项</Button>
        <Button icon={<ReloadOutlined />} onClick={fetchData}>刷新</Button>
        {needsRepair && (
          <Button icon={<ToolOutlined />} onClick={handleRepair} loading={repairing}>文档补全</Button>
        )}
        {canComplete && (
          <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleComplete} loading={completing}>完成会话</Button>
        )}
      </Space>

      {validation && !validation.ok && (
        <Alert
          type="error"
          icon={<SafetyCertificateOutlined />}
          message="数据完整性检查未通过"
          description={
            <div>
              {validation.errors?.map((e, i) => <div key={i} style={{ color: '#ff4d4f' }}>✗ {e}</div>)}
              {validation.warnings?.map((w, i) => <div key={i} style={{ color: '#faad14' }}>⚠ {w}</div>)}
            </div>
          }
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, sm: 2, md: 3, lg: 4 }} size="small">
          <Descriptions.Item label="会话名称">{session.name}</Descriptions.Item>
          <Descriptions.Item label="状态"><SessionStatusTag status={session.status} /></Descriptions.Item>
          <Descriptions.Item label="规模">
            {session.scale ? <Tag color={session.scale === 'large' ? 'purple' : session.scale === 'medium' ? 'blue' : 'green'}>
              {scaleLabels[session.scale] || session.scale}
            </Tag> : <span style={{ color: '#ccc' }}>-</span>}
          </Descriptions.Item>
          <Descriptions.Item label="模式">{session.mode || '标准'}</Descriptions.Item>
          <Descriptions.Item label="OpenSpec">
            {openspecInfo ? (
              <Space size={4}>
                <a onClick={() => setActiveTab('analysis-trace')}>{openspecInfo.name}</a>
                <Tag color={openspecInfo.status === 'archived' ? 'default' : 'blue'}>
                  {openspecInfo.status === 'archived' ? '已归档' : '活跃'}
                </Tag>
              </Space>
            ) : (
              <span style={{ color: '#ccc' }}>增强编排</span>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="进度">
            <Space>
              <Progress percent={pct} size="small" style={{ width: 80 }} status={failed > 0 ? 'exception' : undefined} />
              <span style={{ fontSize: 12 }}>
                {completed}/{total}
                {failed > 0 && <span style={{ color: '#ff4d4f' }}> ({failed}失败)</span>}
                {running > 0 && <span style={{ color: '#1677ff' }}> ({running}执行中)</span>}
              </span>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="日志/快照">{logs.length} / {snapshots.length}</Descriptions.Item>
          <Descriptions.Item label="数据质量">
            {validation?.ok
              ? <Tag color="success">✓ 完整</Tag>
              : <Tag color="error">✗ 缺失 ({(validation?.errors?.length || 0) + (validation?.warnings?.length || 0)})</Tag>
            }
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {session.createdAt ? dayjs(session.createdAt).format('YYYY-MM-DD HH:mm:ss') : <span style={{ color: '#ccc' }}>-</span>}
          </Descriptions.Item>
          <Descriptions.Item label="更新时间">
            {session.updatedAt ? dayjs(session.updatedAt).format('YYYY-MM-DD HH:mm:ss') : <span style={{ color: '#ccc' }}>-</span>}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </Card>
    </div>
  );
}
