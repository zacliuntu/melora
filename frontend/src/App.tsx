import { useCallback, useEffect, useRef, useState } from 'react';
import { Audition } from './audio';
import { PianoRoll } from './PianoRoll';
import { api, json, pitchName, type Note, type Project, type ProjectItem, type Region, type Version } from './types';

type Document = { notes: Note[]; bpm: number };
type Draft = Document & { revision: number };
const key = (id: string) => `melody-draft:${id}`;
const statusNames = { queued: '排队中', transcribing: '识别中', failed: '识别失败', ready: '待确认', approved: '已锁定' };

export default function App() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const projectRef = useRef<Project | null>(null);
  const [doc, setDoc] = useState<Document>({ notes: [], bpm: 120 });
  const docRef = useRef(doc), revision = useRef(0), dirty = useRef(false), saving = useRef<Promise<void> | null>(null);
  const [saveState, setSaveState] = useState('已保存');
  const [selected, setSelected] = useState(new Set<string>());
  const undo = useRef<Document[]>([]), redo = useRef<Document[]>([]);
  const [historyCount, setHistoryCount] = useState([0, 0]);
  const [region, setRegion] = useState<Region>(null), [playhead, setPlayhead] = useState(0);
  const [mode, setMode] = useState<'select' | 'draw'>('select');
  const [source, setSource] = useState<'original' | 'melody'>('melody');
  const [loop, setLoop] = useState(false), [playing, setPlaying] = useState(false);
  const [level, setLevel] = useState(-90);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [versions, setVersions] = useState<Version[]>([]), [showHistory, setShowHistory] = useState(false);
  const [confirming, setConfirming] = useState(false), [reviewed, setReviewed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const audition = useRef(new Audition());
  const upload = useRef<HTMLInputElement>(null);
  const locked = project?.status !== 'ready' || busy || conflict;
  const stop = useCallback(() => { audition.current.stop(); setPlaying(false); setLevel(-90); }, []);
  const refresh = () => api<ProjectItem[]>('/projects').then(setProjects);
  const recordDraft = (value: Document) => {
    if (!projectRef.current) return;
    try { localStorage.setItem(key(projectRef.current.id), JSON.stringify({ ...value, revision: revision.current })); }
    catch { setError('浏览器草稿空间不足；请等待服务器保存后再关闭页面。'); }
  };
  const adopt = (p: Project, recover = true) => {
    stop(); projectRef.current = p; revision.current = p.revision;
    let value: Document = { notes: p.notes, bpm: p.bpm };
    dirty.current = false; setConflict(false); setSaveState('已保存');
    if (recover && p.status === 'ready') {
      try {
        const saved = localStorage.getItem(key(p.id));
        if (saved) {
          const draft: Draft = JSON.parse(saved);
          if (draft.revision === p.revision && Array.isArray(draft.notes)) {
            value = { notes: draft.notes, bpm: draft.bpm }; dirty.current = true; setSaveState('恢复本地草稿');
          } else {
            setConflict(true); setError('发现基于旧版本的本地草稿。可先下载草稿备份，再点击「载入服务器版本」继续。');
          }
        }
      } catch { setError('本地草稿读取失败；服务器版本已载入。'); }
    }
    docRef.current = value; setDoc(value); setProject(p);
    undo.current = []; redo.current = []; setHistoryCount([0, 0]); setSelected(new Set());
    setRegion(null); setPlayhead(0); setVersions([]);
  };
  // Serial saves + optimistic revisions prevent out-of-order responses and lost edits.
  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    if (!dirty.current || !projectRef.current || projectRef.current.status !== 'ready') return;
    const operation = async () => {
      while (dirty.current && projectRef.current?.status === 'ready') {
        const p = projectRef.current, value = docRef.current;
        setSaveState('保存中…');
        try {
          const saved = await api<Project>(`/projects/${p.id}/notes`, json({ ...value, expected_revision: revision.current }, 'PUT'));
          revision.current = saved.revision;
          projectRef.current = saved; setProject(saved);
          dirty.current = docRef.current !== value;
          if (dirty.current) recordDraft(docRef.current);
          else localStorage.removeItem(key(p.id));
          setSaveState(dirty.current ? '等待保存' : '已保存');
        } catch (e) {
          setSaveState('保存失败 · 草稿保留在本机'); setError(String(e));
          if (String(e).includes('版本冲突') || String(e).includes('锁定')) setConflict(true);
          throw e;
        }
      }
    };
    saving.current = operation();
    try { await saving.current; } finally { saving.current = null; }
  }, []);
  useEffect(() => {
    refresh().then(list => {
      // Fetch again only if an explicit project is present in the URL.
      const id = new URLSearchParams(location.search).get('project');
      if (id) api<Project>(`/projects/${id}`).then(p => adopt(p)).catch(e => setError(String(e)));
      return list;
    }).catch(e => setError(String(e)));
    return () => audition.current.dispose();
  }, []);
  useEffect(() => {
    if (!dirty.current || conflict) return;
    const t = window.setTimeout(() => { flush().catch(() => {}); }, 650);
    return () => clearTimeout(t);
  }, [doc, conflict, flush]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => { if (dirty.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => {
    if (!project || !['queued', 'transcribing'].includes(project.status)) return;
    const id = project.id;
    const timer = setInterval(() => api<Project>(`/projects/${id}`).then(p => {
      if (projectRef.current?.id !== id) return;
      if (['ready', 'failed'].includes(p.status)) { adopt(p); refresh(); }
      else { setProject(p); projectRef.current = p; }
    }).catch(e => setError(String(e))), 1200);
    return () => clearInterval(timer);
  }, [project?.id, project?.status]);
  const edit = (value: Document, history = true) => {
    if (projectRef.current?.status !== 'ready' || conflict || busy) return;
    stop();
    if (history) { undo.current.push(docRef.current); if (undo.current.length > 100) undo.current.shift(); redo.current = []; }
    docRef.current = value; setDoc(value); dirty.current = true; recordDraft(value);
    setSaveState('等待保存'); setHistoryCount([undo.current.length, redo.current.length]);
  };
  const undoRedo = (direction: 'undo' | 'redo') => {
    if (locked) return;
    const from = direction === 'undo' ? undo.current : redo.current, to = direction === 'undo' ? redo.current : undo.current;
    const previous = from.pop();
    if (previous) { to.push(docRef.current); edit(previous, false); setSelected(new Set()); }
  };
  const remove = () => { if (!locked && selected.size) { edit({ ...doc, notes: doc.notes.filter(n => !selected.has(n.id)) }); setSelected(new Set()); } };
  const start = async (nextSource = source) => {
    if (!project || !['ready', 'approved'].includes(project.status)) return;
    setError(''); setPlaying(true);
    try {
      await audition.current.play({ notes: doc.notes, start: region?.[0] ?? 0, end: region?.[1] ?? project.duration,
        loop, mode: nextSource, audioUrl: `/api/projects/${project.id}/audio`, onTime: setPlayhead, onLevel: setLevel, onStop: () => setPlaying(false) });
    } catch (e) { stop(); setError(`试听失败：${e}`); }
  };
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable], [role="dialog"]') || confirming) return;
      if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); undoRedo(e.shiftKey || e.key.toLowerCase() === 'y' ? 'redo' : 'undo'); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); }
      else if (e.code === 'Space' && !(e.target as HTMLElement).closest('button')) { e.preventDefault(); if (playing) stop(); else start(); }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  });
  const open = async (id: string) => {
    try { await flush(); const p = await api<Project>(`/projects/${id}`); setError(''); adopt(p); history.replaceState(null, '', `?project=${id}`); }
    catch (e) { setError(String(e)); }
  };
  const importAudio = async (file?: File) => {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { setError('请选择小于 100 MB 的音频'); return; }
    setBusy(true); setError('');
    try {
      await flush(); stop(); const form = new FormData(); form.append('file', file);
      const p = await api<Project>('/projects', { method: 'POST', body: form });
      adopt(p); history.replaceState(null, '', `?project=${p.id}`); await refresh();
    } catch (e) { setError(String(e)); } finally { setBusy(false); if (upload.current) upload.current.value = ''; }
  };
  const loadVersions = async () => {
    if (!project) return;
    try { await flush(); setVersions(await api<Version[]>(`/projects/${project.id}/versions`)); setShowHistory(true); }
    catch (e) { setError(String(e)); }
  };
  const restore = async (version: number) => {
    if (!project) return;
    setBusy(true);
    try { await flush(); const p = await api<Project>(`/projects/${project.id}/restore`, json({ version, expected_revision: revision.current })); adopt(p, false); setShowHistory(false); await refresh(); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!project || !reviewed) return;
    setBusy(true); setError(''); stop();
    try {
      await flush();
      const p = await api<Project>(`/projects/${project.id}/confirm`, json({ expected_revision: revision.current, human_confirmed: true }));
      localStorage.removeItem(key(p.id)); adopt(p, false); setConfirming(false); await refresh();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const downloadDraft = () => {
    if (!project) return;
    const data = localStorage.getItem(key(project.id)) || JSON.stringify(doc);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'melody-local-draft.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const selectedNote = doc.notes.find(n => selected.has(n.id));
  return <div className="app">
    <aside className="sidebar"><div className="brand"><div className="brand-icon">♫</div><div>MELORA<span>拾律 · 原创旋律工作台</span></div></div>
      <div className="stage-label">WORKSPACE / 第一阶段</div>
      <button className="import-button" onClick={() => upload.current?.click()} disabled={busy}>＋ 导入原创哼唱</button>
      <input ref={upload} data-testid="audio-upload" type="file" accept="audio/*,.m4a,.flac,.ogg,.webm" hidden onChange={e => importAudio(e.target.files?.[0])}/>
      <div className="sidebar-heading">我的旋律 <span>{projects.length}</span></div>
      <nav>{projects.map(item => <button key={item.id} disabled={busy} className={`project-link ${project?.id === item.id ? 'active' : ''}`} onClick={() => open(item.id)}><span className="project-icon">{item.status === 'approved' ? '◇' : '♪'}</span><span><b>{item.name}</b><small>{statusNames[item.status]} · v{item.revision}</small></span></button>)}</nav>
      <div className="sidebar-bottom"><span className="green-dot"/> 本地旋律处理<p>Basic Pitch · 浏览器内试听<br/>AI 编曲阶段尚未启用</p></div>
    </aside>
    <main><header className="topbar"><span>旋律工作台 <span className="slash">/</span> 识别与校正</span><span className="stage-pill">STAGE 01</span></header>
      <div className="content"><div className="page-heading"><div><div className="eyebrow">YOUR VOICE, YOUR MELODY</div><h1>{project ? project.name : '把灵感，变成准确的旋律。'}</h1><p>从原创哼唱开始，逐句校正，试听后锁定属于你的主旋律。</p></div>{project && <div className={`status-badge ${project.status === 'approved' ? 'approved' : ''}`}>{statusNames[project.status]}</div>}</div>
        <div className="steps"><span className={project ? 'done' : 'current'}>01 <b>导入 & 识别</b></span><i/><span className={project?.status === 'ready' ? 'current' : project?.status === 'approved' ? 'done' : ''}>02 <b>编辑 & 试听</b></span><i/><span className={project?.status === 'approved' ? 'done' : ''}>03 <b>确认 & 锁定</b></span></div>
        {error && <div role="alert" className="error">{error}<button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
        {conflict && <div className="conflict"><button onClick={downloadDraft}>下载本地草稿</button><button onClick={async () => { if (!project) return; try { const p = await api<Project>(`/projects/${project.id}`); const value = localStorage.getItem(key(p.id)); if (value) localStorage.setItem(`${key(p.id)}:backup:${Date.now()}`, value); localStorage.removeItem(key(p.id)); adopt(p, false); setError(''); } catch (e) { setError(String(e)); } }}>载入服务器版本</button></div>}
        {!project && <section className="welcome" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); importAudio(e.dataTransfer.files[0]); }}><div className="welcome-wave">▂ ▄ ▆ █ ▅ ▃ ▆ █ ▄ ▂</div><h2>让一段哼唱成为起点</h2><p>拖入音频，或从电脑中选择。Basic Pitch 将识别音高与时值，<br/>你可以在 Piano Roll 中自由修正每一个音符。</p><button className="primary" onClick={() => upload.current?.click()} disabled={busy}>{busy ? '正在上传…' : '选择音频文件 ↗'}</button><small>WAV / MP3 / M4A / FLAC / OGG / WEBM · 最长 5 分钟 · 最大 100 MB</small></section>}
        {project && ['queued', 'transcribing'].includes(project.status) && <section className="welcome"><div className="spinner"/><h2>正在识别你的旋律</h2><p>Basic Pitch 正在 CPU 上分析音高与起止时间，首次运行需要预热。<br/>你可以离开页面，任务和结果会保留在服务器。</p></section>}
        {project?.status === 'failed' && <section className="welcome"><h2>识别未完成</h2><p>{project.error}</p><button onClick={async () => { try { adopt(await api<Project>(`/projects/${project.id}/transcribe`, { method: 'POST' })); } catch (e) { setError(String(e)); } }}>重试识别</button></section>}
        {project && ['ready', 'approved'].includes(project.status) && <>
          <div className="editor-toolbar"><div className="toolbar-group"><button className={mode === 'select' ? 'active' : ''} disabled={locked} onClick={() => setMode('select')}>↖ 选择</button><button className={mode === 'draw' ? 'active' : ''} disabled={locked} onClick={() => setMode('draw')}>＋ 画音符</button><span className="divider"/><button aria-label="撤销" disabled={locked || !historyCount[0]} onClick={() => undoRedo('undo')}>↶</button><button aria-label="重做" disabled={locked || !historyCount[1]} onClick={() => undoRedo('redo')}>↷</button><button disabled={locked || !selected.size} onClick={remove}>删除</button></div><div className="toolbar-group"><span className="save-state" data-testid="save-state">{saveState} · v{project.revision}</span><button onClick={() => flush().catch(() => {})} disabled={locked}>保存</button><button onClick={loadVersions}>版本历史</button></div></div>
          <PianoRoll project={project} notes={doc.notes} selected={selected} setSelected={setSelected} onEdit={notes => edit({ ...doc, notes })} region={region} setRegion={r => { stop(); setRegion(r); }} playhead={playhead} locked={locked} mode={mode}/>
          <div className="transport"><div className="transport-main"><button className="play-button" aria-label={playing ? '停止播放' : '播放'} onClick={() => playing ? stop() : start()}>{playing ? '■' : '▶'}</button><div className="time-readout"><b data-testid="playhead">{playhead.toFixed(2)}<small> s</small></b><span data-testid="playback-status">{playing ? (loop ? '循环播放中' : '播放中') : '已停止'}</span></div><span className="divider"/><button data-testid="loop" aria-pressed={loop} className={loop ? 'active' : ''} onClick={() => { stop(); setLoop(!loop); }}>↻ 循环</button><div className="region-info"><b data-testid="region-label">{region ? `${region[0].toFixed(2)} – ${region[1].toFixed(2)} s` : '完整旋律'}</b><small>在时间尺或波形上拖动选择试听区间</small></div>{region && <button onClick={() => { stop(); setRegion(null); }}>清除区间</button>}</div>
            <div className="ab-switch" aria-label="A/B 试听"><meter data-testid="output-level" aria-label="音频输出电平" min="-90" max="0" value={level}/><button className={source === 'original' ? 'active' : ''} onClick={() => { setSource('original'); if (playing) start('original'); }}>A 原始哼唱</button><button className={source === 'melody' ? 'active' : ''} onClick={() => { setSource('melody'); if (playing) start('melody'); }}>B 修正旋律</button></div>
          </div>
          <div className="below-editor"><div className="note-inspector"><span className="eyebrow">NOTE INSPECTOR</span><h3>{selectedNote ? `${pitchName(selectedNote.pitch)} · ${selected.size > 1 ? `已选 ${selected.size} 个音符` : '音符属性'}` : '选中一个音符，开始精修'}</h3>{selectedNote ? <p>开始 {selectedNote.start.toFixed(3)}s　结束 {selectedNote.end.toFixed(3)}s　长度 {(selectedNote.end - selectedNote.start).toFixed(3)}s</p> : <p>拖动改变音高和时间；拖动音符左右边缘调整长度。</p>}<label>制谱速度 <input aria-label="制谱速度" type="number" min="30" max="300" key={doc.bpm} defaultValue={doc.bpm} disabled={locked} onBlur={e => { const bpm = +e.target.value; if (bpm >= 30 && bpm <= 300) { if (bpm !== doc.bpm) edit({ ...doc, bpm }); } else e.target.value = String(doc.bpm); }}/> BPM</label><small>影响乐谱节拍表示，保留原唱的秒级时间。</small></div>
            <div className="confirm-card"><span className="eyebrow">{project.status === 'approved' ? 'MASTER MELODY' : 'HUMAN IN THE LOOP'}</span><h3>{project.status === 'approved' ? '主旋律已确认并锁定' : '最后一步，交给你的耳朵。'}</h3><p>{project.status === 'approved' ? '只读文件与 SHA-256 已保存。可继续试听和查看历史。' : '逐句 A/B 试听后确认。确认将锁定当前版本，生成只读 MIDI 与 MusicXML。'}</p>{project.status === 'approved' ? <div className="downloads"><a href={`/api/projects/${project.id}/exports/master_melody.mid`}>↓ MIDI</a><a href={`/api/projects/${project.id}/exports/master_melody.musicxml`}>↓ MusicXML</a><a href={`/api/projects/${project.id}/exports/manifest.json`}>校验清单</a></div> : <button className="primary" disabled={locked || !doc.notes.length} onClick={() => { stop(); setReviewed(false); setConfirming(true); }}>确认主旋律并锁定 →</button>}</div>
          </div>
        </>}
        <footer className="page-footer">MELORA <span>音频保留在本地服务器 · 试听由当前浏览器实时合成</span></footer>
      </div>
    </main>
    {showHistory && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="版本历史" className="modal"><button className="close" onClick={() => setShowHistory(false)}>×</button><div className="eyebrow">VERSION HISTORY</div><h2>每一次修改，都有迹可循。</h2><p>恢复会创建一个新版本，保留全部历史记录。</p><div className="version-list">{versions.map(v => <div className="version" key={v.revision}><span><b>v{v.revision} · {v.label}</b><small>{new Date(v.created_at).toLocaleString()}</small></span><button disabled={locked || v.revision === project?.revision} onClick={() => restore(v.revision)}>恢复</button></div>)}</div></section></div>}
    {confirming && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="人工确认" className="modal"><div className="eyebrow">CONFIRM YOUR MELODY</div><h2>锁定这版主旋律？</h2><p>确认后音符、版本恢复和重新识别均被锁定。服务器将生成只读主旋律 MIDI、MusicXML 与校验清单。</p><p>此阶段仅交付已确认旋律，不会启动 AI 编曲。</p><label className="review-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/> 我已对照原始哼唱试听并确认当前主旋律。</label>{error && <p role="alert" className="error">{error}</p>}<div className="modal-actions"><button disabled={busy} onClick={() => setConfirming(false)}>继续编辑</button><button className="primary" disabled={!reviewed || busy} onClick={confirm}>{busy ? '保存并生成文件…' : '确认并生成只读文件'}</button></div></section></div>}
  </div>;
}
