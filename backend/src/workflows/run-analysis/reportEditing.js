import { runDefinedAgent } from '../../agents/runDefinedAgent.js';
import {
  assertDirectExecutionScopeBinding,
  beginDirectAgentCommand,
} from '../../core/contracts/AgentExecutionScope.js';
import { ProjectSpace as ProjectFS } from '../../project-space/index.js';
import { latestVerifiedRunAnalysisReportPackage } from '../../project-space/runApiProjection.js';
import { emitRunAnalysisEvent } from './runAnalysis.workflow.js';

function reportEditingError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// 项目内对话式修改（M2：agent 用 ws_read_file + ws_edit_file 做局部编辑，不再整报告重写——
// 根治长报告重写丢内容问题）。修改前先把当前报告复制为新的时间戳版本，agent 在新版本上编辑，历史保留。
export async function chatModify(id, userMsg, { backend, executionScope } = {}) {
  const meta = ProjectFS.meta(id);
  if (!meta) throw new Error('project not found');
  const reportPackage = latestVerifiedRunAnalysisReportPackage(id);
  if (!reportPackage) {
    throw reportEditingError(
      'report feedback requires a verified current report publication',
      'REPORT_FEEDBACK_NOT_READY',
    );
  }
  const report = ProjectFS.fileContent(id, reportPackage.reportPath);
  if (typeof report !== 'string' || !report) {
    throw reportEditingError(
      'verified report content is unavailable',
      'REPORT_FEEDBACK_NOT_READY',
    );
  }
  const scope = assertDirectExecutionScopeBinding(executionScope === undefined
    ? beginDirectAgentCommand({
      workflowId: 'report-edit.v1',
      nodeId: 'edit-report',
      projectId: id,
      asOf: new Date().toISOString(),
      workspaceMode: 'project',
    })
    : executionScope, {
    workflowId: 'report-edit.v1',
    nodeId: 'edit-report',
    projectId: id,
    workspaceMode: 'project',
  });
  ProjectFS.appendChat(id, { role: 'user', content: userMsg });
  emitRunAnalysisEvent(id, 'think', { text: `收到用户修改意图：${userMsg.slice(0, 60)}` });
  // 新时间戳版本作为编辑目标（UI 读 meta.latestReport，历史版本保留）
  const rec = ProjectFS.setTimestampedReport(id, report, { language: meta.reportLanguage || 'en' });
  const r = await runDefinedAgent('report-editor', {
    projectTheme: meta.title,
    conclusionSummary: meta.conclusion?.summary || meta.conclusion || {},
    reportPath: rec.path,
    reportLength: report.length,
    userMessage: userMsg,
  }, {
    scope,
    callId: 'edit-report',
    ...(backend === undefined ? {} : { backend }),
    stage: 'chat',
    artifact: rec.path,
    kind: 'chat',
    temperature: 0.4,
  });
  const edited = (r.trace?.toolCalls || []).some((t) => t.tool === 'ws_edit_file' && t.ok);
  if (edited) emitRunAnalysisEvent(id, 'done', { text: '依据对话局部更新了报告（历史版本保留）。' });
  else {
    // 未做任何编辑：把刚创建的冗余时间戳版本回收（指回原 latest 不可行，保留亦无害；这里简单保留并注明）
    emitRunAnalysisEvent(id, 'done', { text: '本次对话未修改报告。' });
  }
  const reply = (r.text || '').trim() || '（无回复内容）';
  ProjectFS.appendChat(id, { role: 'assistant', content: reply, provider: r.provider });
  return { reply, provider: r.provider, live: r.live, edited };
}
