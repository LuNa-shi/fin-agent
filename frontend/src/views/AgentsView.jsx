import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Spinner } from '../components.jsx';
import { Icon } from '../icons.jsx';
import { Btn, PageHeader } from './Shell.jsx';

const VISIBILITY = [
  { value: 'visible', label: '工作台可见', desc: '在 Agent Catalog 中展示' },
  { value: 'internal', label: '内部可见', desc: '仅配置与调试界面可见' },
  { value: 'hidden', label: '隐藏', desc: '不在普通目录中出现' },
];

export default function AgentsView() {
  const [tab, setTab] = useState('agents');
  const [agents, setAgents] = useState([]);
  const [skills, setSkills] = useState([]);
  const [tools, setTools] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [agentDetail, setAgentDetail] = useState(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async ({ agentId, skillId } = {}) => {
    setLoading(true); setError('');
    try {
      const [agentResult, skillResult, toolResult] = await Promise.all([api.agents(), api.skills(), api.tools()]);
      const nextAgents = agentResult.agents || [];
      const nextSkills = skillResult.skills || [];
      const nextTools = toolResult.tools || [];
      setAgents(nextAgents);
      setSkills(nextSkills);
      setTools(nextTools);
      setSelectedAgentId((current) => agentId || (nextAgents.some((agent) => agent.id === current) ? current : nextAgents[0]?.id || ''));
      setSelectedSkillId((current) => skillId || (nextSkills.some((skill) => skill.id === current) ? current : nextSkills[0]?.id || ''));
      setCatalogRevision((value) => value + 1);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!selectedAgentId) { setAgentDetail(null); return; }
    let cancelled = false;
    setAgentDetail(null);
    api.agent(selectedAgentId).then((result) => {
      if (!cancelled) setAgentDetail(result.agent);
    }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [selectedAgentId, catalogRevision]);

  const applySavedAgent = (savedAgent) => {
    setAgentDetail(savedAgent);
    setAgents((current) => current.map((agent) => agent.id === savedAgent.id ? savedAgent : agent));
  };
  const applySkillChange = ({ skill, deletedId }) => {
    if (deletedId) {
      const remaining = skills.filter((item) => item.id !== deletedId);
      setSkills(remaining);
      setSelectedSkillId((current) => current === deletedId ? remaining[0]?.id || '' : current);
      return;
    }
    setSkills((current) => [...current.filter((item) => item.id !== skill.id), skill].sort((a, b) => a.id.localeCompare(b.id)));
    setSelectedSkillId(skill.id);
    setCatalogRevision((value) => value + 1);
  };
  const selectedAgent = agentDetail?.id === selectedAgentId ? agentDetail : null;
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
  const assignedSkillCount = agents.reduce((sum, agent) => sum + (agent.assignedSkillIds || []).length, 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PageHeader title="Agent Studio" subtitle="定义 Agent 的职责、System Prompt、Tool Use、可见性与 Skills 组合">
        <Btn variant="ghost" size="sm" onClick={load}><Icon.refresh size={13} />刷新</Btn>
      </PageHeader>

      <div className="px-7 pt-4 bg-white border-b border-line">
        <div className="grid grid-cols-3 gap-3 mb-4 max-w-3xl">
          <StudioMetric label="Agent Definitions" value={agents.length} hint={`${agents.filter((a) => catalogVisibility(a) !== 'hidden').length} 个可见`} />
          <StudioMetric label="Managed Skills" value={skills.length} hint="可按 Agent 绑定" />
          <StudioMetric label="Skill Assignments" value={assignedSkillCount} hint={`${tools.length} 个已注册工具`} />
        </div>
        <div className="flex gap-1">
          <StudioTab active={tab === 'agents'} onClick={() => setTab('agents')} icon="agent" label="Agent 定义" count={agents.length} />
          <StudioTab active={tab === 'skills'} onClick={() => setTab('skills')} icon="spark" label="Skills 管理" count={skills.length} />
        </div>
      </div>

      {error && <div className="mx-7 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
      {loading ? <div className="flex-1 grid place-items-center"><Spinner label="加载 Agent Catalog…" /></div> : tab === 'agents' ? (
        <AgentCatalog
          agents={agents}
          skills={skills}
          tools={tools}
          selectedId={selectedAgentId}
          onSelect={setSelectedAgentId}
          selected={selectedAgent}
          onSaved={applySavedAgent}
        />
      ) : (
        <SkillsCatalog
          skills={skills}
          tools={tools}
          agents={agents}
          selectedId={selectedSkillId}
          onSelect={setSelectedSkillId}
          selected={selectedSkill}
          onSaved={applySkillChange}
        />
      )}
    </div>
  );
}

function AgentCatalog({ agents, skills, tools, selectedId, onSelect, selected, onSaved }) {
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('all');
  const domains = [...new Set(agents.map((a) => a.domain).filter(Boolean))].sort();
  const filtered = agents.filter((agent) => {
    const haystack = `${agent.id} ${agent.displayName || ''} ${agent.purpose || agent.description || ''}`.toLowerCase();
    return (domain === 'all' || agent.domain === domain) && haystack.includes(query.toLowerCase());
  });
  return (
    <div className="flex-1 min-h-0 flex">
      <aside className="w-80 shrink-0 border-r border-line bg-slate-50/60 flex flex-col">
        <div className="p-3 border-b border-line space-y-2 bg-white">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 Agent…"
            className="studio-input text-xs py-2 bg-slate-50 focus:bg-white" />
          <select value={domain} onChange={(e) => setDomain(e.target.value)} className="w-full text-xs border border-line rounded-lg px-2 py-2 bg-white text-sub">
            <option value="all">全部 Domain</option>
            {domains.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {filtered.map((agent) => (
            <button key={agent.id} onClick={() => onSelect(agent.id)} className={`w-full p-3 rounded-xl border text-left transition ${selectedId === agent.id ? 'bg-white border-blue-200 shadow-sm' : 'border-transparent hover:bg-white hover:border-line'}`}>
              <div className="flex items-start gap-2.5">
                <div className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${selectedId === agent.id ? 'bg-blue-50 text-brand' : 'bg-slate-100 text-slate-500'}`}><Icon.agent size={17} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-ink truncate">{agent.displayName || agent.id}</span>
                    <VisibilityDot value={catalogVisibility(agent)} />
                  </div>
                  <div className="font-mono text-[9px] text-slate-400 truncate mt-0.5">{agent.id} · v{agent.version}</div>
                  <p className="text-[10px] text-sub mt-1 line-clamp-2 leading-relaxed">{agent.purpose || agent.description}</p>
                  <div className="mt-2 flex items-center gap-1.5 text-[9px] text-slate-400">
                    <span>{agent.domain}</span><span>·</span>
                    <span>{toolIds(agent).length} tools</span><span>·</span>
                    <span>{(agent.assignedSkillIds || []).length} skills</span>
                  </div>
                </div>
              </div>
            </button>
          ))}
          {!filtered.length && <div className="py-12 text-center text-xs text-sub">没有匹配的 Agent。</div>}
        </div>
      </aside>
      <div className="flex-1 min-w-0 overflow-auto p-6">
        {selected ? <AgentEditor key={selected.id} agent={selected} skills={skills} tools={tools} onSaved={onSaved} /> : selectedId ? <div className="h-full grid place-items-center"><Spinner label="加载 Agent 定义…" /></div> : <StudioEmpty icon="agent" text="选择左侧 Agent 查看定义。" />}
      </div>
    </div>
  );
}

function AgentEditor({ agent, skills, tools, onSaved }) {
  const baseAllowed = agent.contractToolAllow || [];
  const baseline = useMemo(() => agentForm(agent), [agent]);
  const [form, setForm] = useState(() => baseline);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const workflowNodes = agent.workflowNodeBindings || [];
  const baselineSerialized = useMemo(() => JSON.stringify(baseline), [baseline]);
  const dirty = JSON.stringify(form) !== baselineSerialized;

  const save = async () => {
    setSaving(true); setMessage('');
    try {
      const original = baseline;
      const patchBody = {};
      if (form.displayName.trim() !== original.displayName) patchBody.displayName = form.displayName.trim();
      if (form.description.trim() !== original.description) patchBody.description = form.description.trim();
      if (form.visibility !== original.visibility) patchBody.visibility = form.visibility;
      if (form.systemPrompt !== original.systemPrompt) patchBody.systemPrompt = form.systemPrompt;
      if (JSON.stringify(form.toolIds) !== JSON.stringify(original.toolIds)) patchBody.toolIds = form.toolIds;
      if (JSON.stringify(form.skillIds) !== JSON.stringify(original.skillIds)) patchBody.skillIds = form.skillIds;
      const result = await api.saveAgent(agent.id, patchBody);
      setMessage('已保存 Agent 配置');
      onSaved(result.agent);
    } catch (e) { setMessage(e.message); }
    finally { setSaving(false); }
  };

  const toggleTool = (id) => setForm((current) => {
    const nextTools = toggle(current.toolIds, id);
    const nextSkills = current.skillIds.filter((skillId) => {
      const skill = skills.find((item) => item.id === skillId);
      return !skill || (skill.toolIds || []).every((toolId) => nextTools.includes(toolId));
    });
    return { ...current, toolIds: nextTools, skillIds: nextSkills };
  });
  const toggleSkill = (id) => setForm((current) => ({ ...current, skillIds: toggle(current.skillIds, id) }));

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="bg-white border border-line rounded-xl p-5 flex items-start gap-4 shadow-sm">
        <div className="w-11 h-11 rounded-xl bg-blue-50 text-brand grid place-items-center shrink-0"><Icon.agent size={22} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-bold text-ink">{form.displayName || agent.id}</h2>
            <Badge color="blue">{agent.domain}</Badge>
            <Badge color="slate">{agent.executionMode}</Badge>
          </div>
          <div className="font-mono text-[10px] text-slate-400 mt-1">{agent.id} · definition v{agent.version} · {agent.source}</div>
        </div>
        <Btn onClick={save} disabled={saving || !dirty}>{saving ? '保存中…' : '保存配置'}</Btn>
      </div>

      {message && <div className={`rounded-lg border px-3 py-2 text-xs ${message.startsWith('已保存') ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-600'}`}>{message}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-5">
          <StudioCard title="定义与职责" icon="plan" desc="展示名称和职责只影响 Catalog 呈现，不改变 checked-in contract。">
            <Field label="展示名称"><input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} className="studio-input" /></Field>
            <Field label="职责描述"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="studio-input resize-y" /></Field>
            <Field label="Catalog 可见性">
              <div className="grid grid-cols-3 gap-2">
                {VISIBILITY.map((item) => (
                  <button key={item.value} onClick={() => setForm({ ...form, visibility: item.value })} className={`border rounded-lg p-2.5 text-left ${form.visibility === item.value ? 'border-brand bg-blue-50/60' : 'border-line hover:border-slate-300'}`}>
                    <div className={`text-xs font-medium ${form.visibility === item.value ? 'text-brand' : 'text-ink'}`}>{item.label}</div>
                    <div className="text-[10px] text-sub mt-0.5">{item.desc}</div>
                  </button>
                ))}
              </div>
            </Field>
          </StudioCard>

          <StudioCard title="System Prompt" icon="brain" desc="保存的是 runtime overlay；原始 Agent 定义仍保持只读。Skills 指令会在运行时追加到有效 Prompt。">
            <textarea rows={15} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              className="w-full rounded-lg border border-line bg-slate-950 text-slate-100 p-4 font-mono text-xs leading-relaxed focus:outline-none focus:border-brand resize-y" />
            <div className="mt-2 flex items-center justify-between text-[10px] text-sub">
              <span>这里只展示可审计的 Prompt 配置，不展示模型隐藏思维链。</span>
              <span className="font-mono">{form.systemPrompt.length} chars</span>
            </div>
          </StudioCard>

          <StudioCard title="Tool Use 范围" icon="tool" desc="可以收窄 checked-in tool policy，但不能从界面扩大 Agent 权限。">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {tools.map((tool) => {
                const id = tool.name || tool.id;
                const permitted = baseAllowed.includes(id);
                const checked = form.toolIds.includes(id);
                return (
                  <label key={id} className={`border rounded-lg p-3 flex gap-2.5 ${permitted ? 'border-line hover:border-blue-200' : 'border-slate-100 bg-slate-50 opacity-55'}`}>
                    <input type="checkbox" checked={checked} disabled={!permitted} onChange={() => toggleTool(id)} className="mt-0.5 accent-blue-600" />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-xs font-mono text-ink"><Icon.tool size={12} />{id}</span>
                      <span className="block text-[10px] text-sub mt-1 line-clamp-2">{tool.description || tool.desc || tool.effect || '已注册工具'}</span>
                      {!permitted && <span className="block text-[9px] text-slate-400 mt-1">不在原始 contract 中</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </StudioCard>
        </div>

        <div className="space-y-5">
          <StudioCard title="Skills 绑定" icon="spark" desc="Skill 由指令和已授权工具组合而成。">
            <div className="space-y-2">
              {skills.map((skill) => {
                const unavailable = (skill.toolIds || []).some((id) => !form.toolIds.includes(id));
                return (
                  <label key={skill.id} className={`block border rounded-lg p-3 ${unavailable ? 'border-amber-100 bg-amber-50/40' : 'border-line'}`}>
                    <div className="flex gap-2">
                      <input type="checkbox" checked={form.skillIds.includes(skill.id)} disabled={unavailable && !form.skillIds.includes(skill.id)} onChange={() => toggleSkill(skill.id)} className="mt-0.5 accent-blue-600" />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-ink">{skill.name}</div>
                        <div className="text-[10px] text-sub mt-0.5">{skill.description}</div>
                        {unavailable && <div className="text-[9px] text-amber-600 mt-1">先启用 Skill 所需工具</div>}
                      </div>
                    </div>
                  </label>
                );
              })}
              {!skills.length && <div className="text-xs text-sub border border-dashed border-line rounded-lg p-3">还没有 Skill。前往 Skills 管理创建。</div>}
            </div>
          </StudioCard>

          <StudioCard title="Workflow 位置" icon="layers">
            <div className="space-y-2">
              {workflowNodes.length ? workflowNodes.map((node) => <ReadonlyRow key={typeof node === 'string' ? node : node.nodeId || node.id} label={typeof node === 'string' ? node : node.nodeId || node.id} value={typeof node === 'string' ? 'run-analysis' : `${node.workflowId || node.workflow || 'run-analysis'} · ${node.kind || 'node'}`} />) : <p className="text-xs text-sub">未直接绑定到 canonical workflow node。</p>}
            </div>
          </StudioCard>

          <StudioCard title="输出权限" icon="folder">
            <ReadonlyList label="Artifact Authority" values={agent.artifactAuthority || []} />
            <ReadonlyList label="Output Paths" values={agent.outputPaths || []} />
          </StudioCard>
        </div>
      </div>
    </div>
  );
}

function SkillsCatalog({ skills, tools, agents, selectedId, onSelect, selected, onSaved }) {
  const createSkill = () => onSelect('__new__');
  const draft = selectedId === '__new__' ? { id: '', name: '', description: '', instruction: '', toolIds: [], visibility: 'internal' } : selected;
  return (
    <div className="flex-1 min-h-0 flex">
      <aside className="w-80 shrink-0 border-r border-line bg-slate-50/60 flex flex-col">
        <div className="p-3 border-b border-line bg-white"><Btn size="sm" onClick={createSkill}><Icon.plus size={13} />新建 Skill</Btn></div>
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {skills.map((skill) => (
            <button key={skill.id} onClick={() => onSelect(skill.id)} className={`w-full p-3 rounded-xl border text-left ${selectedId === skill.id ? 'bg-white border-violet-200 shadow-sm' : 'border-transparent hover:bg-white hover:border-line'}`}>
              <div className="flex items-start gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-violet-50 text-violet-600 grid place-items-center"><Icon.spark size={16} /></div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-ink truncate">{skill.name}</div>
                  <div className="font-mono text-[9px] text-slate-400 mt-0.5">{skill.id} · v{skill.version || 1}</div>
                  <p className="text-[10px] text-sub mt-1 line-clamp-2">{skill.description}</p>
                  <div className="text-[9px] text-slate-400 mt-2">{(skill.toolIds || []).length} tools · {agents.filter((a) => (a.assignedSkillIds || []).includes(skill.id)).length} agents</div>
                </div>
              </div>
            </button>
          ))}
          {!skills.length && selectedId !== '__new__' && <div className="py-12 text-center text-xs text-sub">创建第一个行业 Skill。</div>}
        </div>
      </aside>
      <div className="flex-1 min-w-0 overflow-auto p-6">
        {draft ? <SkillEditor key={selectedId} skill={draft} tools={tools} agents={agents} isNew={selectedId === '__new__'} onSaved={onSaved} /> : <StudioEmpty icon="spark" text="选择一个 Skill，或创建新的行业能力。" />}
      </div>
    </div>
  );
}

function SkillEditor({ skill, tools, agents, isNew, onSaved }) {
  const [form, setForm] = useState({
    id: skill.id || '', name: skill.name || '', description: skill.description || '', instruction: skill.instruction || '',
    toolIds: skill.toolIds || [], visibility: skill.visibility || 'internal',
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const assignedAgents = agents.filter((agent) => (agent.assignedSkillIds || []).includes(skill.id));
  const save = async () => {
    setSaving(true); setMessage('');
    try {
      const result = await api.saveSkill(form, isNew);
      setMessage('已保存 Skill');
      onSaved({ skill: result.skill });
    } catch (e) { setMessage(e.message); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (assignedAgents.length) { setMessage(`请先从 ${assignedAgents.length} 个 Agent 中解除这个 Skill 的绑定。`); return; }
    if (!window.confirm(`删除 Skill “${skill.name}”？此操作不可撤销。`)) return;
    setSaving(true); setMessage('');
    try { await api.deleteSkill(skill.id); onSaved({ deletedId: skill.id }); }
    catch (e) { setMessage(e.message); }
    finally { setSaving(false); }
  };
  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="bg-white border border-line rounded-xl p-5 flex items-center gap-4 shadow-sm">
        <div className="w-11 h-11 rounded-xl bg-violet-50 text-violet-600 grid place-items-center"><Icon.spark size={22} /></div>
        <div className="flex-1"><h2 className="text-lg font-bold text-ink">{isNew ? '新建 Skill' : skill.name}</h2><p className="text-xs text-sub mt-0.5">可复用的行业指令与 Tool Use 组合</p></div>
        {!isNew && <span title={assignedAgents.length ? '请先解除所有 Agent 绑定' : ''}><Btn variant="danger" size="sm" onClick={remove} disabled={saving || assignedAgents.length > 0}><Icon.trash size={13} />删除</Btn></span>}
        <Btn onClick={save} disabled={saving || !form.id.trim() || !form.name.trim()}>{saving ? '保存中…' : '保存 Skill'}</Btn>
      </div>
      {message && <div className={`rounded-lg border px-3 py-2 text-xs ${message.startsWith('已保存') ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-600'}`}>{message}</div>}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-5">
          <StudioCard title="Skill 定义" icon="plan">
            <div className="grid grid-cols-2 gap-3"><Field label="Skill ID"><input value={form.id} disabled={!isNew} onChange={(e) => setForm({ ...form, id: slugify(e.target.value) })} className="studio-input font-mono" placeholder="semiconductor-supply-chain" /></Field><Field label="名称"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="studio-input" placeholder="半导体产业链分析" /></Field></div>
            <Field label="描述"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="studio-input resize-y" /></Field>
            <Field label="Skill Instruction"><textarea rows={14} value={form.instruction} onChange={(e) => setForm({ ...form, instruction: e.target.value })} className="w-full rounded-lg border border-line bg-slate-950 text-slate-100 p-4 font-mono text-xs leading-relaxed focus:outline-none focus:border-violet-500 resize-y" placeholder="描述这个 Skill 应如何影响 Agent 的分析方式、证据要求与输出格式…" /></Field>
          </StudioCard>
          <StudioCard title="Tool 组合" icon="tool" desc="Agent 绑定 Skill 时，Skill 所需工具必须已在该 Agent 的 contract 中授权。">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {tools.map((tool) => {
                const id = tool.name || tool.id;
                return <label key={id} className="border border-line rounded-lg p-3 flex gap-2.5 hover:border-violet-200"><input type="checkbox" checked={form.toolIds.includes(id)} onChange={() => setForm({ ...form, toolIds: toggle(form.toolIds, id) })} className="mt-0.5 accent-violet-600" /><span><span className="text-xs font-mono text-ink">{id}</span><span className="block text-[10px] text-sub mt-1">{tool.description || tool.desc || tool.effect}</span></span></label>;
              })}
            </div>
          </StudioCard>
        </div>
        <div className="space-y-5">
          <StudioCard title="可见性" icon="eye">
            <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} className="studio-input">
              {VISIBILITY.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </StudioCard>
          <StudioCard title="已绑定 Agent" icon="agent">
            {assignedAgents.length ? <div className="space-y-2">{assignedAgents.map((agent) => <ReadonlyRow key={agent.id} label={agent.displayName || agent.id} value={agent.domain} />)}</div> : <p className="text-xs text-sub">保存后可在 Agent 定义中按需绑定。</p>}
          </StudioCard>
        </div>
      </div>
    </div>
  );
}

function StudioCard({ title, icon, desc, children }) {
  const I = Icon[icon] || Icon.layers;
  return <section className="bg-white border border-line rounded-xl shadow-sm"><div className="px-4 py-3 border-b border-line"><div className="flex items-center gap-2 text-sm font-semibold text-ink"><I size={15} className="text-brand" />{title}</div>{desc && <p className="text-[10px] text-sub mt-1">{desc}</p>}</div><div className="p-4 space-y-4">{children}</div></section>;
}
function Field({ label, children }) { return <label className="block"><span className="block text-xs font-medium text-slate-600 mb-1.5">{label}</span>{children}</label>; }
function ReadonlyRow({ label, value }) { return <div className="flex items-center justify-between gap-3 border border-line rounded-lg px-3 py-2"><span className="text-xs font-mono text-ink truncate">{label}</span><span className="text-[10px] text-sub truncate">{value}</span></div>; }
function ReadonlyList({ label, values }) { const list = Array.isArray(values) ? values : Object.keys(values || {}); return <div><div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">{label}</div>{list.length ? <div className="flex flex-wrap gap-1">{list.map((value) => <span key={String(value)} className="font-mono text-[9px] px-1.5 py-1 bg-slate-100 text-slate-600 rounded">{String(value)}</span>)}</div> : <div className="text-xs text-sub">无</div>}</div>; }
function StudioMetric({ label, value, hint }) { return <div className="border border-line rounded-xl p-3 bg-slate-50/60"><div className="flex items-baseline gap-2"><span className="text-xl font-semibold text-ink tabular-nums">{value}</span><span className="text-[10px] text-sub">{hint}</span></div><div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mt-1">{label}</div></div>; }
function StudioTab({ active, onClick, icon, label, count }) { const I = Icon[icon]; return <button onClick={onClick} className={`px-4 py-2.5 border-b-2 -mb-px text-sm font-medium flex items-center gap-2 ${active ? 'border-brand text-brand' : 'border-transparent text-sub hover:text-ink'}`}><I size={14} />{label}<span className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-1.5 py-0.5">{count}</span></button>; }
function StudioEmpty({ icon, text }) { const I = Icon[icon]; return <div className="h-full grid place-items-center"><div className="text-center text-sub"><I size={34} className="mx-auto text-slate-300 mb-3" /><p className="text-sm">{text}</p></div></div>; }
function VisibilityDot({ value }) { return <span title={value} className={`w-1.5 h-1.5 rounded-full ${value === 'hidden' ? 'bg-slate-300' : value === 'internal' ? 'bg-amber-400' : 'bg-emerald-500'}`} />; }
function catalogVisibility(agent) { return agent.catalogVisibility || 'internal'; }
function toolIds(agent) { return agent.toolPolicy?.allow || []; }
function agentForm(agent) { return { displayName: agent.displayName || agent.id, description: agent.description || '', visibility: catalogVisibility(agent), systemPrompt: agent.editableSystemPrompt || '', toolIds: toolIds(agent), skillIds: agent.assignedSkillIds || [] }; }
function toggle(list, value) { return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]; }
function slugify(value) { return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''); }
