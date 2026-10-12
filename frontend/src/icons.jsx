import React from 'react';

// 统一细线图标系统（stroke-based，专业素雅）。size 默认 16，继承 currentColor。
const S = ({ children, size = 16, sw = 1.6, fill = 'none', vb = 24, className = '' }) => (
  <svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`} fill={fill} stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={className}
    aria-hidden="true">{children}</svg>
);

export const Icon = {
  // 三层系统导航
  idea: (p) => <S {...p}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.3 1 2.5h6c0-1.2.3-1.8 1-2.5A6 6 0 0 0 12 3Z" /></S>,
  library: (p) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 4v16" /></S>,
  target: (p) => <S {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></S>,
  globe: (p) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" /></S>,

  // 动作
  settings: (p) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></S>,
  plus: (p) => <S {...p}><path d="M12 5v14M5 12h14" /></S>,
  sliders: (p) => <S {...p}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></S>,
  spark: (p) => <S {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></S>,
  refresh: (p) => <S {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M21 4v4h-4M3 20v-4h4" /></S>,
  play: (p) => <S {...p}><path d="M7 5v14l11-7z" /></S>,
  pause: (p) => <S {...p}><path d="M8 5v14M16 5v14" /></S>,
  back: (p) => <S {...p}><path d="M15 5l-7 7 7 7" /></S>,
  arrowRight: (p) => <S {...p}><path d="M5 12h14M13 6l6 6-6 6" /></S>,
  send: (p) => <S {...p}><path d="M5 12l15-7-7 15-2-6-6-2z" /></S>,
  chat: (p) => <S {...p}><path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12Z" /></S>,
  pin: (p) => <S {...p}><path d="M12 17v5M9 3h6l-1 7 3 2H7l3-2-1-7Z" /></S>,
  close: (p) => <S {...p}><path d="M6 6l12 12M18 6 6 18" /></S>,
  edit: (p) => <S {...p}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></S>,
  trash: (p) => <S {...p}><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3" /></S>,
  check: (p) => <S {...p}><path d="M5 12l5 5L20 6" /></S>,
  flame: (p) => <S {...p}><path d="M12 3c1 3-2 4-2 7a2 2 0 0 0 4 0c0-1 0-1 .5-2 .8 1 1.5 2.3 1.5 4a4.5 4.5 0 0 1-9 0c0-3.5 3-5.5 5-9Z" /></S>,

  // agent 流程事件
  plan: (p) => <S {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></S>,
  brain: (p) => <S {...p}><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 2 4 3 3 0 0 0 5 1V4.5A2.5 2.5 0 0 0 9 4Z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-2 4 3 3 0 0 1-5 1" /></S>,
  tool: (p) => <S {...p}><path d="M14.5 5.5a3.5 3.5 0 0 0-4.9 4.3l-5.3 5.3a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3.5 3.5 0 0 0 4.3-4.9l-2.2 2.2-1.8-1.8 2.2-2.2Z" /></S>,
  eye: (p) => <S {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></S>,
  agent: (p) => <S {...p}><rect x="5" y="8" width="14" height="11" rx="2" /><path d="M12 8V4M9 3h6" /><circle cx="9.5" cy="13" r="1" /><circle cx="14.5" cy="13" r="1" /></S>,

  // 文件
  folder: (p) => <S {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></S>,
  file: (p) => <S {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></S>,
  doc: (p) => <S {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></S>,
  chart: (p) => <S {...p}><path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6" /></S>,
  calendar: (p) => <S {...p}><path d="M8 2v4M16 2v4M3 10h18" /><rect x="3" y="4" width="18" height="18" rx="2" /></S>,
  layers: (p) => <S {...p}><path d="M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5M3 17l9 5 9-5" /></S>,
  warn: (p) => <S {...p}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 9v5M12 17h.01" /></S>,
  gauge: (p) => <S {...p}><path d="M12 14a8 8 0 1 1 8-8" opacity="0" /><path d="M4 14a8 8 0 1 1 16 0" /><path d="M12 14l4-4" /></S>,
};

// 带圆形底的事件图标
export function EventDot({ type, size = 14 }) {
  const map = {
    plan: ['plan', 'text-blue-600', 'bg-blue-50'],
    think: ['brain', 'text-violet-600', 'bg-violet-50'],
    tool: ['tool', 'text-amber-600', 'bg-amber-50'],
    subagent: ['agent', 'text-cyan-700', 'bg-cyan-50'],
    observe: ['eye', 'text-emerald-600', 'bg-emerald-50'],
    done: ['check', 'text-emerald-700', 'bg-emerald-50'],
    'initial-plan': ['plan', 'text-blue-600', 'bg-blue-50'],
    scan: ['eye', 'text-amber-600', 'bg-amber-50'],
    'main-orchestrator': ['layers', 'text-violet-600', 'bg-violet-50'],
    adaptor: ['brain', 'text-cyan-700', 'bg-cyan-50'],
    'final-report': ['doc', 'text-emerald-700', 'bg-emerald-50'],
  };
  const [icon, color, bg] = map[type] || map.think;
  const I = Icon[icon];
  return <span className={`w-7 h-7 rounded-full ${bg} ${color} grid place-items-center shrink-0`}><I size={size} /></span>;
}
