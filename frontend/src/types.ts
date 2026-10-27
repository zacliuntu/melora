export type Note = { id: string; pitch: number; start: number; end: number; velocity: number };
export type Project = { id: string; name: string; status: 'queued' | 'transcribing' | 'ready' | 'failed' | 'approved'; revision: number; duration: number; bpm: number; notes: Note[]; waveform: [number, number][]; error: string | null; master: { files: Record<string, string>; confirmed_at: string } | null };
export type ProjectItem = Pick<Project, 'id' | 'name' | 'status' | 'revision'>;
export type Version = { revision: number; label: string; created_at: string };
export type Region = [number, number] | null;
export const pitchName = (pitch: number) => ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][pitch % 12] + (Math.floor(pitch / 12) - 1);
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof body.detail === 'string' ? body.detail : '请求参数无效，请检查输入');
  }
  return res.json();
}
export const json = (data: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
