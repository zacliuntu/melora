import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { pitchName, type Note, type Project, type Region } from './types';

type Props = { project: Project; notes: Note[]; selected: Set<string>; setSelected: (s: Set<string>) => void; onEdit: (n: Note[]) => void; region: Region; setRegion: (r: Region) => void; playhead: number; locked: boolean; mode: 'select' | 'draw' };
type Gesture = { type: 'move' | 'left' | 'right' | 'box'; x: number; y: number; ids: Set<string>; original: Note[]; additive: boolean; moved: boolean };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function PianoRoll(p: Props) {
  const [zoom, setZoom] = useState(90), [row, setRow] = useState(20);
  const [scrollX, setScrollX] = useState(0);
  const [snap, setSnap] = useState(true);
  const [preview, setPreview] = useState<Note[] | null>(null);
  const previewRef = useRef<Note[] | null>(null);
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const rangeStart = useRef<number | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const width = Math.max(900, p.project.duration * zoom), height = 128 * row;
  const data = preview || p.notes;
  const quantize = (x: number) => snap ? Math.round(x / 0.05) * 0.05 : x;
  useEffect(() => {
    const pitches = p.notes.map(n => n.pitch).sort((a, b) => a - b);
    const center = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 60;
    if (viewport.current) viewport.current.scrollTop = (127 - center) * row - 170;
  }, [p.project.id, row]);
  const xy = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [clamp(e.clientX - r.left, 0, p.project.duration * zoom), clamp(e.clientY - r.top, 0, height - 1)];
  };
  const newNote = (x: number, y: number) => {
    if (p.locked) return;
    const start = clamp(quantize(x / zoom), 0, p.project.duration - 0.025);
    const n = { id: crypto.randomUUID?.() || `n-${Date.now()}-${Math.random()}`, pitch: 127 - Math.floor(y / row), start, end: Math.min(p.project.duration, start + 0.4), velocity: 90 };
    p.onEdit([...p.notes, n]); p.setSelected(new Set([n.id]));
  };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || p.locked) return;
    const [x, y] = xy(e);
    const target = (e.target as Element).closest('[data-note-id]');
    if (!target && p.mode === 'draw') { newNote(x, y); return; }
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    let ids = new Set(p.selected);
    if (target) {
      const id = target.getAttribute('data-note-id')!;
      if (e.shiftKey) { if (ids.has(id)) ids.delete(id); else ids.add(id); }
      else if (!ids.has(id)) ids = new Set([id]);
      p.setSelected(ids);
      gesture.current = { type: ((e.target as Element).getAttribute('data-handle') as 'left' | 'right') || 'move', x, y, ids, original: p.notes, additive: e.shiftKey, moved: false };
    } else {
      if (!e.shiftKey) { ids = new Set(); p.setSelected(ids); }
      gesture.current = { type: 'box', x, y, ids, original: p.notes, additive: e.shiftKey, moved: false };
      setBox([x, y, x, y]);
    }
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const [x, y] = xy(e);
    g.moved = g.moved || Math.abs(x - g.x) + Math.abs(y - g.y) > 3;
    if (g.type === 'box') {
      setBox([Math.min(x, g.x), Math.min(y, g.y), Math.max(x, g.x), Math.max(y, g.y)]);
      const found = g.original.filter(n => n.end * zoom >= Math.min(x, g.x) && n.start * zoom <= Math.max(x, g.x) &&
        (127 - n.pitch + 1) * row >= Math.min(y, g.y) && (127 - n.pitch) * row <= Math.max(y, g.y));
      p.setSelected(new Set([...(g.additive ? g.ids : []), ...found.map(n => n.id)])); return;
    }
    const chosen = g.original.filter(n => g.ids.has(n.id));
    if (!chosen.length || !g.moved) return;
    let dt = quantize((x - g.x) / zoom), dp = -Math.round((y - g.y) / row);
    if (g.type === 'move') {
      dt = clamp(dt, -Math.min(...chosen.map(n => n.start)), p.project.duration - Math.max(...chosen.map(n => n.end)));
      dp = clamp(dp, -Math.min(...chosen.map(n => n.pitch)), 127 - Math.max(...chosen.map(n => n.pitch)));
    } else if (g.type === 'left') dt = clamp(dt, -Math.min(...chosen.map(n => n.start)), Math.min(...chosen.map(n => n.end - n.start - 0.025)));
    else dt = clamp(dt, -Math.min(...chosen.map(n => n.end - n.start - 0.025)), p.project.duration - Math.max(...chosen.map(n => n.end)));
    const next = g.original.map(n => !g.ids.has(n.id) ? n : { ...n,
      start: g.type === 'right' ? n.start : Math.max(0, n.start + dt),
      end: g.type === 'left' ? n.end : Math.min(p.project.duration, n.end + dt),
      pitch: g.type === 'move' ? n.pitch + dp : n.pitch });
    previewRef.current = next; setPreview(next);
  };
  const finish = () => {
    if (previewRef.current) p.onEdit(previewRef.current);
    gesture.current = null; previewRef.current = null; setPreview(null); setBox(null);
  };
  const rangeDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    rangeStart.current = clamp((e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom, 0, p.project.duration);
    p.setRegion(null);
  };
  const rangeMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (rangeStart.current === null) return;
    const end = clamp((e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom, 0, p.project.duration);
    const start = rangeStart.current;
    if (Math.abs(end - start) >= 0.025) p.setRegion([Math.min(start, end), Math.max(start, end)]);
  };
  const timeHandlers = { onPointerDown: rangeDown, onPointerMove: rangeMove, onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => { rangeMove(e); rangeStart.current = null; }, onPointerCancel: () => { rangeStart.current = null; } };
  const overlay = (h: number) => <>
    {p.region && <rect className="region-overlay" x={p.region[0] * zoom} y={0} width={(p.region[1] - p.region[0]) * zoom} height={h}/>}
    <line className="playhead" x1={p.playhead * zoom} x2={p.playhead * zoom} y1={0} y2={h}/>
  </>;
  const seconds = Array.from({ length: Math.ceil(p.project.duration) + 1 }, (_, i) => i);
  const wavePath = useMemo(() => p.project.waveform.map(([lo, hi], i) => {
    const x = i / p.project.waveform.length * p.project.duration * zoom;
    return `M${x.toFixed(2)},${(40 - hi * 34).toFixed(2)}V${(40 - lo * 34).toFixed(2)}`;
  }).join(' '), [p.project.waveform, p.project.duration, zoom]);
  return <section className="roll-card">
    <div className="roll-heading"><div><b>旋律编辑器</b><span> PIANO ROLL</span></div><div className="zoom-tools">
      <label><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)}/> 吸附 50ms</label>
      <label>时间缩放 <input aria-label="时间缩放" type="range" min="35" max="240" value={zoom} onChange={e => setZoom(+e.target.value)}/></label>
      <label>音高缩放 <input aria-label="音高缩放" type="range" min="14" max="30" value={row} onChange={e => setRow(+e.target.value)}/></label>
    </div></div>
    <div className="timeline-scroll" onScroll={e => setScrollX(e.currentTarget.scrollLeft)}><div className="timeline" style={{ width: width + 64 }}>
      <div className="timeline-row"><div className="gutter">秒</div><svg data-testid="time-ruler" width={width} height={32} {...timeHandlers}>
        {seconds.map(t => <g key={t}><line x1={t * zoom} x2={t * zoom} y1={20} y2={32} stroke="#434d60"/><text x={t * zoom + 6} y={16}>{t.toFixed(1)}</text></g>)}{overlay(32)}</svg></div>
      <div className="timeline-row wave-row"><div className="gutter">原唱<br/><small>WAVE</small></div><svg data-testid="waveform" width={width} height={80} {...timeHandlers}><path d={wavePath} stroke="#8395c7" strokeWidth={1} fill="none"/>{overlay(80)}</svg></div>
      <div className="piano-viewport" ref={viewport}><div className="piano-body" style={{ height }}>
        <div className="keys" style={{ height, transform: `translateX(${scrollX}px)` }}>{Array.from({ length: 128 }, (_, i) => <div key={i} className={`key ${[1, 3, 6, 8, 10].includes((127 - i) % 12) ? 'black' : ''}`} style={{ height: row }}>{pitchName(127 - i)}</div>)}</div>
        <svg data-testid="piano-grid" className="piano-grid" width={width} height={height} onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { gesture.current = null; previewRef.current = null; setPreview(null); setBox(null); }} onDoubleClick={e => { if (p.mode === 'select' && !(e.target as Element).closest('[data-note-id]')) { const r = e.currentTarget.getBoundingClientRect(); newNote(e.clientX - r.left, e.clientY - r.top); } }}>
          {Array.from({ length: 128 }, (_, i) => <rect key={i} x={0} y={i * row} width={width} height={row} fill={[1, 3, 6, 8, 10].includes((127 - i) % 12) ? '#171e2a' : '#1c2432'} stroke="#293243" strokeWidth={0.5}/>)}
          {seconds.map(t => <line key={t} x1={t * zoom} x2={t * zoom} y1={0} y2={height} stroke="#344053" strokeWidth={t % 4 === 0 ? 1.2 : 0.6}/>)}
          {overlay(height)}
          {data.map(n => <g key={n.id} data-testid="note" data-note-id={n.id} data-pitch={n.pitch} data-start={n.start.toFixed(6)} data-end={n.end.toFixed(6)} className={`note ${p.selected.has(n.id) ? 'selected' : ''} ${p.locked ? 'locked' : ''}`} transform={`translate(${n.start * zoom},${(127 - n.pitch) * row + 2})`}>
            <title>{pitchName(n.pitch)} · {n.start.toFixed(3)}–{n.end.toFixed(3)} 秒</title>
            <rect width={Math.max(3, (n.end - n.start) * zoom)} height={row - 4} rx={3}/>
            {(n.end - n.start) * zoom > 30 && <text x={8} y={(row - 4) / 2 + 4}>{pitchName(n.pitch)}</text>}
            <rect data-handle="left" className="resize" width={Math.min(7, (n.end - n.start) * zoom / 3)} height={row - 4}/>
            <rect data-handle="right" className="resize" x={Math.max(0, (n.end - n.start) * zoom - Math.min(7, (n.end - n.start) * zoom / 3))} width={Math.min(7, (n.end - n.start) * zoom / 3)} height={row - 4}/>
          </g>)}
          {box && <rect className="marquee" x={box[0]} y={box[1]} width={box[2] - box[0]} height={box[3] - box[1]}/>}
        </svg>
      </div></div>
    </div></div>
    <footer className="roll-footer"><span>双击新增 · 拖动移动 · 两端调整起止 · 空白拖动框选 · Shift 多选</span><span>{p.notes.length} 音符 / 已选 {p.selected.size}</span></footer>
  </section>;
}
